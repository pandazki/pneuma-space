import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import {
  DEFAULT_POLICY, IDEMPOTENCY_WINDOW_MS, NotFound,
  type App, type AppId, type CronExpr, type Delivery, type DeliveryFilter, type Lease, type Subject, type TriggerName,
} from './model.ts';
import { DeliveryScheduler, nextSlot, type SchedulerDeps, type SchedulerView } from './scheduler.ts';

type Received = { headers: IncomingMessage['headers']; body: string };
let handle: (req: IncomingMessage, res: ServerResponse, received: Received) => void = (_req, res) => res.end();
let received: Received[] = [];
let address = '';
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const entry = { headers: req.headers, body: Buffer.concat(chunks).toString() };
  received.push(entry);
  handle(req, res, entry);
});
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const APP = 'a1' as AppId;
const T0 = Date.parse('2026-01-01T00:00:30Z');
const caller = 'service:ci' as Subject;

function harness(triggers: Record<string, string | null> = { run: null }) {
  received = [];
  handle = (_req, res) => res.end();
  const rows: Delivery[] = [];
  const clock = { now: T0 };
  const view: SchedulerView = {
    status: 'registered',
    publishedAt: T0,
    triggers: Object.entries(triggers).map(([name, schedule]) => ({ app: APP, name: name as TriggerName, schedule: schedule as CronExpr | null })),
    policy: DEFAULT_POLICY,
  };
  const state = { view: view as SchedulerView | null, acquired: 0, released: 0, refuse: false };
  const store: SchedulerDeps['store'] = {
    apps: () => [{ id: APP, status: 'registered' } as App],
    insertDelivery: (d) => {
      const existing = rows.find((r) => r.app === d.app && r.trigger === d.trigger && (
        (d.scheduledFor !== null && r.scheduledFor === d.scheduledFor) ||
        (d.idempotencyKey !== null && r.idempotencyKey === d.idempotencyKey && d.createdAt - r.createdAt < IDEMPOTENCY_WINDOW_MS)));
      if (existing) return existing;
      rows.push(d);
      return d;
    },
    updateDelivery: (d) => void rows.splice(rows.findIndex((r) => r.id === d.id), 1, d),
    deliveries: (f: DeliveryFilter) => rows.filter((r) => (f.app === undefined || r.app === f.app) &&
      (f.state === undefined || r.state === f.state) && (f.dueBefore === undefined || r.nextAttemptAt <= f.dueBefore)),
    deleteDeliveries: (app) => void rows.splice(0, rows.length, ...rows.filter((r) => r.app !== app)),
    lastScheduledFor: (app, trigger) => {
      const slots = rows.filter((r) => r.app === app && r.trigger === trigger && r.scheduledFor !== null).map((r) => r.scheduledFor!);
      return slots.length ? Math.max(...slots) : null;
    },
  };
  const runtime: SchedulerDeps['runtime'] = {
    acquire: async (app) => {
      if (state.refuse) throw new NotFound('app has no run spec');
      state.acquired++;
      return { app, address };
    },
    release: (_lease: Lease) => void state.released++,
  };
  const scheduler = new DeliveryScheduler({ store, runtime, view: () => state.view, now: () => clock.now, log: () => {} });
  const invoke = (key: string | null = null, body = '') =>
    scheduler.invoke({ app: APP, trigger: 'run' as TriggerName, caller, idempotencyKey: key, body: new TextEncoder().encode(body) });
  return { scheduler, rows, clock, state, invoke };
}

test('a cron trigger yields one delivery per slot after publish and catches up only the latest missed slot', async () => {
  const { scheduler, rows, clock } = harness({ report: '* * * * *' });
  clock.now = Date.parse('2026-01-01T00:00:50Z');
  await scheduler.tick();
  assert.equal(rows.length, 0);
  clock.now = Date.parse('2026-01-01T00:01:10Z');
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(rows.map((r) => new Date(r.scheduledFor!).toISOString()), ['2026-01-01T00:01:00.000Z']);
  assert.equal(received[0].headers['x-pneuma-space-scheduled-for'], '2026-01-01T00:01:00.000Z');
  clock.now = Date.parse('2026-01-01T00:11:10Z');
  await scheduler.tick();
  assert.deepEqual(rows.map((r) => new Date(r.scheduledFor!).toISOString()), ['2026-01-01T00:01:00.000Z', '2026-01-01T00:11:00.000Z']);
});

test('a retry after a 500 carries the same delivery id, the next attempt number, the caller and the body', async () => {
  const { scheduler, rows, clock, invoke } = harness();
  let calls = 0;
  handle = (_req, res) => res.writeHead(++calls === 1 ? 500 : 200).end();
  const id = invoke(null, 'hello');
  await scheduler.tick();
  assert.equal(rows[0].state, 'due');
  clock.now += 10_000;
  await scheduler.tick();
  assert.equal(rows[0].state, 'done');
  assert.deepEqual(received.map((r) => [r.headers['x-pneuma-space-delivery'], r.headers['x-pneuma-space-attempt'], r.headers['x-pneuma-space-subject'], r.body]),
    [[id, '1', caller, 'hello'], [id, '2', caller, 'hello']]);
});

test('the fifth failed attempt sets failed after backoffs of 10, 20, 40 and 80 s', async () => {
  const { scheduler, rows, clock, state, invoke } = harness();
  handle = (_req, res) => res.writeHead(503).end();
  invoke();
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    await scheduler.tick();
    if (rows[0].state === 'due') waits.push(rows[0].nextAttemptAt - clock.now);
    clock.now = rows[0].nextAttemptAt;
  }
  assert.deepEqual(waits, [10_000, 20_000, 40_000, 80_000]);
  assert.equal(rows[0].state, 'failed');
  assert.equal(state.released, state.acquired);
});

test('an upstream slower than trigger_timeout_seconds has its connection closed and is retried with growing backoff', async () => {
  const { scheduler, rows, clock, state, invoke } = harness();
  state.view = { ...state.view!, policy: { ...DEFAULT_POLICY, trigger_timeout_seconds: 0.2 } };
  const closed: Promise<unknown>[] = [];
  handle = (req) => void closed.push(once(req.socket, 'close'));
  invoke();
  await scheduler.tick();
  await closed[0];
  assert.deepEqual([rows[0].state, rows[0].nextAttemptAt - clock.now], ['due', 10_000]);
  clock.now = rows[0].nextAttemptAt;
  await scheduler.tick();
  assert.deepEqual([rows[0].state, rows[0].nextAttemptAt - clock.now], ['due', 20_000]);
  assert.equal(state.released, 2);
});

test('a second due delivery for an app starts only after the first finishes', async () => {
  const { scheduler, rows, invoke } = harness();
  let finishFirst = () => {};
  handle = (_req, res) => {
    if (received.length === 1) finishFirst = () => res.end();
    else res.end();
  };
  const first = invoke('a');
  const second = invoke('b');
  const firstTick = scheduler.tick();
  while (received.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await scheduler.tick();
  assert.deepEqual(rows.map((r) => r.state), ['delivering', 'due']);
  finishFirst();
  await firstTick;
  await scheduler.tick();
  assert.deepEqual(received.map((r) => r.headers['x-pneuma-space-delivery']), [first, second]);
});

test('invoke with the same Idempotency-Key returns the same delivery; different keys create two', () => {
  const { rows, invoke } = harness();
  assert.equal(invoke('k1'), invoke('k1'));
  assert.notEqual(invoke('k2'), invoke('k1'));
  assert.equal(rows.length, 2);
});

test('invoke of a trigger the current release does not declare throws NotFound', () => {
  const { scheduler } = harness();
  assert.throws(() => scheduler.invoke({ app: APP, trigger: 'gone' as TriggerName, caller, idempotencyKey: null, body: new Uint8Array() }), NotFound);
});

test('reload after the trigger was dropped cancels its due deliveries and keeps done ones', async () => {
  const { scheduler, rows, state, invoke } = harness();
  invoke('done');
  await scheduler.tick();
  invoke('pending');
  state.view = { ...state.view!, triggers: state.view!.triggers.filter((t) => t.name !== 'run') };
  scheduler.reload(APP);
  assert.deepEqual(rows.map((r) => r.state), ['done', 'cancelled']);
});

test('an acquire refused with NotFound cancels the delivery', async () => {
  const { scheduler, rows, state, invoke } = harness();
  state.refuse = true;
  invoke();
  await scheduler.tick();
  assert.equal(rows[0].state, 'cancelled');
});

test('resume returns a delivering row to due and redelivers it with the same id', async () => {
  const { scheduler, rows, clock, invoke } = harness();
  const id = invoke();
  rows[0] = { ...rows[0], state: 'delivering', attempts: 1, nextAttemptAt: clock.now + 60_000 };
  scheduler.resume();
  assert.deepEqual([rows[0].state, rows[0].nextAttemptAt], ['due', clock.now]);
  await scheduler.tick();
  scheduler.stop();
  assert.deepEqual([rows[0].state, received[0].headers['x-pneuma-space-delivery'], received[0].headers['x-pneuma-space-attempt']], ['done', id, '2']);
});

test('nextSlot follows the America/New_York wall clock across the 2026 DST changes', () => {
  const tz = 'America/New_York';
  const next = (expr: string, after: string) => new Date(nextSlot(expr as CronExpr, Date.parse(after), tz)!).toISOString();
  // 2026-03-08 02:00 EST jumps to 03:00 EDT: 02:30 does not exist that day.
  assert.equal(next('30 2 * * *', '2026-03-07T12:00:00Z'), '2026-03-09T06:30:00.000Z');
  assert.equal(next('*/30 * * * *', '2026-03-08T06:30:00Z'), '2026-03-08T07:00:00.000Z');
  assert.equal(next('0 3 * * *', '2026-03-08T00:00:00Z'), '2026-03-08T07:00:00.000Z');
  // 2026-11-01 02:00 EDT falls back to 01:00 EST: 01:30 occurs twice.
  assert.equal(next('30 1 * * *', '2026-11-01T05:00:00Z'), '2026-11-01T05:30:00.000Z');
  assert.equal(next('30 1 * * *', '2026-11-01T05:30:00Z'), '2026-11-01T06:30:00.000Z');
});
