import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import {
  DEFAULT_POLICY, IDEMPOTENCY_WINDOW_MS, NotFound, QuotaExceeded,
  type App, type AppId, type CronExpr, type Delivery, type DeliveryFilter, type Lease, type Replica, type ReplicaId, type SchedulerView, type Subject, type TenantName, type TriggerName,
} from './model.ts';
import { DEAD_MS } from './instances.ts';
import { RING, requests } from './requests.ts';
import { DeliveryScheduler, latestSlot, nextSlot, type SchedulerDeps } from './scheduler.ts';
import { SqliteStore } from './store.ts';

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
  const state = { view: view as SchedulerView | null, acquired: 0, released: 0, refuse: false, quota: false, failWrite: false, replicas: [] as Replica[] };
  const store: SchedulerDeps['store'] = {
    apps: async () => [{ id: APP, status: 'registered' } as App],
    insertDelivery: async (d) => {
      const existing = rows.find((r) => r.app === d.app && r.trigger === d.trigger && (
        (d.scheduledFor !== null && r.scheduledFor === d.scheduledFor) ||
        (d.idempotencyKey !== null && r.idempotencyKey === d.idempotencyKey && d.createdAt - r.createdAt < IDEMPOTENCY_WINDOW_MS)));
      if (existing) return existing;
      rows.push(d);
      return d;
    },
    casDelivery: async (expected, d) => {
      if (state.failWrite) throw new Error('database is locked');
      const i = rows.findIndex((r) => r.id === expected.id && r.state === expected.state && r.replica === expected.replica && r.attempts === expected.attempts);
      if (i >= 0) rows[i] = { ...rows[i], state: d.state, attempts: d.attempts, nextAttemptAt: d.nextAttemptAt };
      return i >= 0;
    },
    claimDelivery: async (id, replica, attempts) => {
      if (state.failWrite) throw new Error('database is locked');
      const i = rows.findIndex((r) => r.id === id && r.state === 'due');
      if (i >= 0) rows[i] = { ...rows[i], state: 'delivering', replica, attempts };
      return i >= 0;
    },
    replicas: async () => state.replicas,
    sweepDeliveries: async () => 0,
    deliveries: async (f: DeliveryFilter) => rows.filter((r) => (f.app === undefined || r.app === f.app) &&
      (f.state === undefined || r.state === f.state) && (f.dueBefore === undefined || r.nextAttemptAt <= f.dueBefore)),
    deleteDeliveries: async (app) => void rows.splice(0, rows.length, ...rows.filter((r) => r.app !== app)),
    lastScheduledFor: async (app, trigger) => {
      const slots = rows.filter((r) => r.app === app && r.trigger === trigger && r.scheduledFor !== null).map((r) => r.scheduledFor!);
      return slots.length ? Math.max(...slots) : null;
    },
  };
  const runtime: SchedulerDeps['runtime'] = {
    acquire: async (app) => {
      if (state.refuse) throw new NotFound('app has no run spec');
      if (state.quota) throw new QuotaExceeded('blue' as TenantName, { resource: 'awake', used: 1, limit: 1, ask: 1 });
      state.acquired++;
      return { app, address };
    },
    release: (_lease: Lease) => void state.released++,
    state: () => 'asleep',
  };
  const scheduler = new DeliveryScheduler({ store, runtime, view: () => state.view, now: () => clock.now, log: () => {}, replica: 'me' as ReplicaId });
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
  const id = await invoke(null, 'hello');
  await scheduler.tick();
  assert.equal(rows[0].state, 'due');
  clock.now += 10_000;
  await scheduler.tick();
  assert.equal(rows[0].state, 'done');
  assert.deepEqual(received.map((r) => [r.headers['x-pneuma-space-delivery'], r.headers['x-pneuma-space-attempt'], r.headers['x-pneuma-space-subject'], r.body]),
    [[id, '1', caller, 'hello'], [id, '2', caller, 'hello']]);
});

test('each delivery attempt leaves one trigger record with the app\'s status (AC-P-15)', async () => {
  const { scheduler, invoke } = harness();
  handle = (_req, res) => res.writeHead(500).end();
  const from = requests.after(0, RING).at(-1)?.seq ?? 0;
  await invoke();
  await scheduler.tick();
  const records = requests.after(from, RING);
  assert.deepEqual(records.map((r) => [r.kind, r.method, r.path, r.status, r.cold, r.subject]), [['trigger', 'POST', '/_pneuma-space/trigger/run', 500, true, caller]]);
});

test('the fifth failed attempt sets failed after backoffs of 10, 20, 40 and 80 s', async () => {
  const { scheduler, rows, clock, state, invoke } = harness();
  handle = (_req, res) => res.writeHead(503).end();
  await invoke();
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
  await invoke();
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
  const first = await invoke('a');
  const second = await invoke('b');
  const firstTick = scheduler.tick();
  while (received.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await scheduler.tick();
  assert.deepEqual(rows.map((r) => r.state), ['delivering', 'due']);
  finishFirst();
  await firstTick;
  await scheduler.tick();
  assert.deepEqual(received.map((r) => r.headers['x-pneuma-space-delivery']), [first, second]);
});

test('invoke with the same Idempotency-Key returns the same delivery; different keys create two', async () => {
  const { rows, invoke } = harness();
  assert.equal(await invoke('k1'), await invoke('k1'));
  assert.notEqual(await invoke('k2'), await invoke('k1'));
  assert.equal(rows.length, 2);
});

test('invoke of a trigger the current release does not declare throws NotFound', async () => {
  const { scheduler } = harness();
  await assert.rejects(scheduler.invoke({ app: APP, trigger: 'gone' as TriggerName, caller, idempotencyKey: null, body: new Uint8Array() }), NotFound);
});

test('reload after the trigger was dropped cancels its due deliveries and keeps done ones', async () => {
  const { scheduler, rows, state, invoke } = harness();
  await invoke('done');
  await scheduler.tick();
  await invoke('pending');
  state.view = { ...state.view!, triggers: state.view!.triggers.filter((t) => t.name !== 'run') };
  await scheduler.reload(APP);
  assert.deepEqual(rows.map((r) => r.state), ['done', 'cancelled']);
});

test('an acquire refused with NotFound cancels the delivery', async () => {
  const { scheduler, rows, state, invoke } = harness();
  state.refuse = true;
  await invoke();
  await scheduler.tick();
  assert.equal(rows[0].state, 'cancelled');
});

test('a wake refused by the tenant\'s quota leaves attempts unchanged and retries the delivery 30 s later', async () => {
  const { scheduler, rows, clock, state, invoke } = harness();
  state.quota = true;
  await invoke();
  await scheduler.tick();
  assert.deepEqual([rows[0].state, rows[0].attempts, rows[0].nextAttemptAt], ['due', 0, T0 + 30_000]);
});

test('resume leaves a delivery claimed by another live replica delivering', async () => {
  const { scheduler, rows, state, invoke } = harness();
  await invoke();
  rows[0] = { ...rows[0], state: 'delivering', attempts: 1, replica: 'other' as ReplicaId };
  state.replicas = [{ id: 'other' as ReplicaId, startedAt: 0, seenAt: Date.now(), leading: false }];
  await scheduler.resume();
  scheduler.stop();
  assert.equal(rows[0].state, 'delivering');
});

test('resume returns a delivering row to due and redelivers it with the same id', async () => {
  const { scheduler, rows, clock, invoke } = harness();
  const id = await invoke();
  rows[0] = { ...rows[0], state: 'delivering', attempts: 1, nextAttemptAt: clock.now + 60_000 };
  await scheduler.resume();
  assert.deepEqual([rows[0].state, rows[0].nextAttemptAt], ['due', clock.now]);
  await scheduler.tick();
  scheduler.stop();
  assert.deepEqual([rows[0].state, received[0].headers['x-pneuma-space-delivery'], received[0].headers['x-pneuma-space-attempt']], ['done', id, '2']);
});

/**
 * Replicas a and b over one SqliteStore and one fake clock; a heartbeat is a planted replica row. The upstream holds the first `hold`
 * requests until `answers[i](status)` is called, so those attempts stay in flight as long as a test wants, and answers later ones 200 (ADR 0029).
 */
function twoReplicas(hold: number) {
  received = [];
  const answers: ((status: number) => void)[] = [];
  handle = (_req, res) => {
    const answer = (status: number) => void res.writeHead(status).end();
    if (received.length <= hold) answers.push(answer);
    else answer(200);
  };
  const store = new SqliteStore(':memory:');
  const clock = { now: Date.now() };
  const view: SchedulerView = { status: 'registered', publishedAt: T0, triggers: [{ app: APP, name: 'run' as TriggerName, schedule: null }], policy: DEFAULT_POLICY };
  const runtime: SchedulerDeps['runtime'] = { acquire: async (app) => ({ app, address }), release: () => {}, state: () => 'asleep' };
  const logged: string[] = [];
  const replica = (id: string) => new DeliveryScheduler({
    store, runtime, view: () => view, now: () => clock.now, log: (ev) => void logged.push(`${id} ${ev}`), replica: id as ReplicaId,
  });
  const beat = (id: string) => store.putReplica({ id: id as ReplicaId, startedAt: T0, seenAt: clock.now, leading: false });
  const row = async (id: string) => (await store.deliveries({})).find((d) => d.id === id)!;
  const arrived = async (n: number) => {
    while (received.length < n) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { store, clock, a: replica('a'), b: replica('b'), beat, row, arrived, answers, logged };
}

/** a leads and starts a delivery its upstream holds, then stops beating: it died mid-delivery. */
async function diedMidDelivery(r: ReturnType<typeof twoReplicas>) {
  await r.beat('a');
  await r.beat('b');
  const id = await r.a.invoke({ app: APP, trigger: 'run' as TriggerName, caller, idempotencyKey: null, body: new Uint8Array() });
  const attempt = r.a.tick();
  await r.arrived(1);
  return { id, attempt };
}

const attempts = () => received.map((r) => [r.headers['x-pneuma-space-delivery'], r.headers['x-pneuma-space-attempt']]);

/** b leads from now and ticks once a second until a second attempt arrives or `until`; returns the clock at that tick. */
async function leadUntilRetried(r: ReturnType<typeof twoReplicas>, until: number): Promise<number> {
  await r.beat('b');
  await r.b.resume();
  r.b.stop();
  while (received.length < 2 && r.clock.now < until) {
    r.clock.now += 1000;
    await r.beat('b');
    await r.b.tick();
  }
  return r.clock.now;
}

test('a delivery whose replica dies is attempted again within one reclaim period of its heartbeat expiring, though the new leader took the lead before (ADR 0029)', async () => {
  const r = twoReplicas(1);
  const { id, attempt } = await diedMidDelivery(r);
  const expired = r.clock.now + DEAD_MS + 1;
  r.clock.now += 2000;
  const retriedAt = await leadUntilRetried(r, expired + 60_000);
  assert.deepEqual(attempts(), [[id, '1'], [id, '2']]);
  assert.ok(retriedAt <= expired + 5000, `retried ${retriedAt - expired} ms after the heartbeat expired`);
  assert.deepEqual([(await r.row(id)).state, (await r.row(id)).attempts], ['done', 2]);
  r.answers[0](500);
  await attempt;
});

test('a delivery whose replica died before the new leader took the lead is attempted again on its first tick (ADR 0029)', async () => {
  const r = twoReplicas(1);
  const { id, attempt } = await diedMidDelivery(r);
  r.clock.now += DEAD_MS + 1;
  await leadUntilRetried(r, r.clock.now + 1000);
  assert.deepEqual(attempts(), [[id, '1'], [id, '2']]);
  r.answers[0](500);
  await attempt;
});

/** a died mid-delivery, b reclaimed it and holds its own attempt; resolves once b's attempt reached the upstream. */
async function reclaimed(r: ReturnType<typeof twoReplicas>) {
  const { id, attempt } = await diedMidDelivery(r);
  r.clock.now += DEAD_MS + 1;
  await r.beat('b');
  await r.b.resume();
  r.b.stop();
  const retry = r.b.tick();
  await r.arrived(2);
  return { id, attempt, retry, claim: await r.row(id) };
}

test("a dead replica's late 2xx leaves the new claim as it was and emits no delivery.done, and the new attempt's outcome is what is stored (ADR 0029)", async () => {
  const r = twoReplicas(2);
  const { id, attempt, retry, claim } = await reclaimed(r);
  r.answers[0](200);
  await attempt;
  assert.deepEqual([await r.row(id), claim.replica, claim.attempts], [claim, 'b', 2]);
  assert.deepEqual(r.logged.filter((line) => line.startsWith('a delivery.')), ['a delivery.due', 'a delivery.delivering']);
  r.answers[1](503);
  await retry;
  assert.deepEqual([(await r.row(id)).state, (await r.row(id)).attempts], ['due', 2]);
});

test("a dead replica's late failure neither returns the new claim to due nor moves its backoff (ADR 0029)", async () => {
  const r = twoReplicas(2);
  const { id, attempt, retry, claim } = await reclaimed(r);
  r.answers[0](500);
  await attempt;
  assert.deepEqual([await r.row(id), claim.state, claim.replica, claim.attempts], [claim, 'delivering', 'b', 2]);
  r.answers[1](200);
  await retry;
});

test("the leader's hourly tick sweeps done and cancelled deliveries past the event retention and keeps failed ones (INV-4)", async () => {
  const store = new SqliteStore(':memory:');
  const day = 24 * 3_600_000;
  const row = (id: string, state: Delivery['state'], age: number): Delivery => ({
    id: id as Delivery['id'], app: APP, trigger: 'run' as TriggerName, scheduledFor: null, caller: null, idempotencyKey: id, body: new Uint8Array(),
    state, attempts: 1, nextAttemptAt: T0 - age, createdAt: T0 - age, replica: null,
  });
  for (const d of [row('old-done', 'done', 15 * day), row('old-cancelled', 'cancelled', 15 * day), row('old-failed', 'failed', 15 * day), row('new-done', 'done', day)]) {
    await store.insertDelivery(d);
  }
  const runtime = { acquire: async () => { throw new Error('unused'); }, release: () => {}, state: () => 'asleep' as const };
  const scheduler = new DeliveryScheduler({ store, runtime, view: () => null, now: () => T0, log: () => {}, policy: () => ({ events_retention_days: 14 }) });
  await scheduler.tick();
  assert.deepEqual((await store.deliveries({})).map((d) => d.id).sort(), ['new-done', 'old-failed']);
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

test('catching up a per-minute trigger after 30 days down yields the latest slot only', () => {
  const now = Date.parse('2026-06-01T12:00:30Z');
  assert.equal(latestSlot('* * * * *' as CronExpr, now - 30 * 86_400_000, now, 'UTC'), Date.parse('2026-06-01T12:00:00Z'));
});

test('a store error during a tick is logged and does not reject the tick', async () => {
  const { scheduler, state, invoke } = harness();
  await invoke();
  state.failWrite = true;
  await assert.doesNotReject(scheduler.tick());
});
