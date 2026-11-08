import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { EventLog } from './events.ts';
import { Metrics } from './metrics.ts';
import { DEFAULT_TENANT, USAGE_COUNTERS, appName, type AppId, type AppSummary, type InstanceState, type ReplicaId, type Stats, type Usage } from './model.ts';
import { SqliteStore } from './store.ts';

const HOUR = 3_600_000;
const app = 'a1b2c3d4e5f6' as AppId;
const survey = appName('survey');

function fixture({ store = new SqliteStore(':memory:'), replica = 'r1', leader = true, clock = { now: 1_800_000_000_000 }, policy = {} } = {}) {
  const events = new EventLog(() => {});
  const stats: Stats[] = [];
  const apps: AppSummary[] = [];
  const metrics = new Metrics({
    events,
    stats: () => stats,
    apps: async () => apps,
    deliveries: { counts: async () => ({ due: 0, delivering: 0, done: 0, failed: 0, cancelled: 0 }), failed: async () => [] },
    nameOf: (id) => (id === app ? survey : null),
    probes: { redis: async () => 'up' },
    host: async () => ({ cpus: 1, load: [0, 0, 0], memory: { totalBytes: 1, freeBytes: 1 }, data: null }),
    store,
    policy: () => ({ usage_retention_days: 90, events_retention_days: 14, events_max_rows: 1_000_000, ...policy }),
    view: (name) => (name === survey ? { app, tenant: DEFAULT_TENANT } : null),
    replica: replica as ReplicaId,
    leader: () => leader,
    now: () => clock.now,
  });
  const last = (series: readonly (number | null)[]) => series.at(-1);
  const hourRow = async () => (await store.usage({ step: 3600, app, from: 0, to: clock.now + HOUR }))[0];
  return { clock, events, stats, apps, metrics, store, last, hourRow };
}

const summary = (instance: InstanceState): AppSummary => ({
  name: survey, address: '/apps/survey/', release: null, capabilities: [], status: 'registered', instance, since: null,
  leases: { request: 0, channel: 0, trigger: 0 }, sleepsAt: null, runtime: 'container', quarantine: null, dbBackend: null,
  lastAccessAt: null, requests: 0, errors: 0, node: null,
});

const stored = (app: AppId | '*', step: 60 | 3600, start: number, requests: number): Usage => ({
  ...(Object.fromEntries(USAGE_COUNTERS.map((c) => [c, 0])) as Record<(typeof USAGE_COUNTERS)[number], number>),
  app, tenant: app === '*' ? null : DEFAULT_TENANT, step, start, replica: 'elsewhere' as ReplicaId, requests,
});

/** A file the test can reach with a second connection, to move rows back on the library's clock. */
function fileStore() {
  const path = join(mkdtempSync(join(tmpdir(), 'pneuma-space-metrics-')), 'pneuma-space.sqlite3');
  const backdate = (ms: number) => {
    const db = new DatabaseSync(path);
    db.prepare('UPDATE events SET at = at - ?').run(ms);
    db.close();
  };
  return { path, store: new SqliteStore(path), backdate };
}

const realClock = () => ({ now: Date.now() });

test('a wake with its latency lands in the current minute and in the last hour', () => {
  const { events, metrics, last } = fixture();
  events.emit('waking', app);
  events.emit('awake', app, { ms: 840 });
  const snapshot = metrics.snapshot();
  assert.equal(last(snapshot.series.wakes), 1);
  assert.equal(last(snapshot.series.wakeMeanMs), 840);
  assert.equal(snapshot.wakes.last1h.count, 1);
});

test("wake p50 and p95 per window come from every replica's awake events in the store", async () => {
  const { store, backdate } = fileStore();
  const awake = (ms: number) => ({ replica: 'other' as ReplicaId, ev: 'awake', app, tenant: DEFAULT_TENANT, body: { ms } });
  await store.insertEvents(Array.from({ length: 10 }, () => awake(1000)));
  backdate(2 * HOUR);
  await store.insertEvents(Array.from({ length: 20 }, (_, i) => awake(i + 1)));
  const { metrics } = fixture({ store, clock: realClock() });
  await metrics.sample();
  const { last1h, last24h } = metrics.snapshot().wakes;
  assert.deepEqual([last1h.p50Ms, last1h.p95Ms, last24h.p50Ms, last24h.p95Ms], [10, 19, 15, 1000]);
});

test('the next snapshot counts a request once, before and after the sampler writes it', async () => {
  const { stats, metrics, last } = fixture();
  stats.push({ app, requests: 3, errors: 1, lastAccessAt: null });
  const before = metrics.snapshot().series;
  await metrics.sample();
  const after = metrics.snapshot().series;
  assert.deepEqual([last(before.requests), last(before.errors), last(after.requests), last(after.errors)], [3, 1, 3, 1]);
});

test('a request counted in memory appears in the written row with absolute values', async () => {
  const { stats, metrics, hourRow } = fixture();
  stats.push({ app, requests: 3, errors: 1, lastAccessAt: null });
  await metrics.sample();
  const row = await hourRow();
  assert.deepEqual([row.tenant, row.requests, row.errors], [DEFAULT_TENANT, 3, 1]);
});

test('a second write of the same bucket overwrites, never adds', async () => {
  const { stats, metrics, hourRow } = fixture();
  stats.push({ app, requests: 3, errors: 0, lastAccessAt: null });
  await metrics.sample();
  stats[0] = { app, requests: 5, errors: 0, lastAccessAt: null };
  await metrics.sample();
  assert.equal((await hourRow()).requests, 5);
});

test("two replicas' rows sum in the series read", async () => {
  const store = new SqliteStore(':memory:');
  const one = fixture({ store, replica: 'r1' });
  const two = fixture({ store, replica: 'r2' });
  one.stats.push({ app, requests: 2, errors: 0, lastAccessAt: null });
  two.stats.push({ app, requests: 3, errors: 0, lastAccessAt: null });
  await one.metrics.sample();
  await two.metrics.sample();
  await one.metrics.sample();
  assert.equal(one.last(one.metrics.snapshot().series.requests), 5);
});

test('awake_ms is written only when the leader flag is set', async () => {
  const awake = async (leader: boolean) => {
    const { apps, metrics, clock, hourRow } = fixture({ leader });
    apps.push(summary('awake'));
    await metrics.sample();
    clock.now += 10_000;
    await metrics.sample();
    return (await hourRow())?.awakeMs ?? 0;
  };
  assert.deepEqual([await awake(true), await awake(false)], [10_000, 0]);
});

test('the sweep deletes hourly rows past the retention and minute rows past 24 h, and keeps the rest', async () => {
  const { metrics, store, clock } = fixture();
  const day = 24 * HOUR;
  const hour = (start: number) => stored(app, 3600, start, 1);
  const minute = (start: number) => stored('*', 60, start, 1);
  await store.putUsage([hour(clock.now - 91 * day), hour(clock.now - 89 * day), minute(clock.now - day - 60_000), minute(clock.now - HOUR)]);
  await metrics.sample();
  const left = async (step: 60 | 3600) => (await store.usage({ step, from: 0, to: clock.now })).map((b) => (clock.now - b.start) / HOUR);
  assert.deepEqual([await left(3600), await left(60)], [[89 * 24], [1]]);
});

test("the listing's 24 h counts come from usage", async () => {
  const { metrics, store, clock } = fixture();
  await store.putUsage([stored(app, 3600, clock.now, 7), stored(app, 3600, clock.now - 25 * HOUR, 100)]);
  await metrics.sample();
  assert.deepEqual(metrics.stats(), [{ app, requests: 7, errors: 0, lastAccessAt: null }]);
});

test('a failed delivery lands in the deliveries series', () => {
  const { events, metrics, last } = fixture();
  events.emit('delivery.failed', app, { trigger: 'nightly', delivery: 'd1', attempt: 5, reason: 'HTTP 500' });
  assert.equal(last(metrics.snapshot().series.deliveriesFailed), 1);
});

const storedNs = async (store: SqliteStore) => (await store.events({})).map((e) => e.body.n);

test('100 waiting events are inserted at once, without waiting for the second to pass', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { events, store } = fixture();
  const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
  events.emit('delivery.due', app, { attempt: 0, n: 0 });
  await settle();
  for (let n = 1; n <= 99; n++) events.emit('delivery.due', app, { attempt: 0, n });
  await settle();
  const waiting = (await storedNs(store)).length;
  events.emit('delivery.due', app, { attempt: 0, n: 100 });
  await settle();
  assert.deepEqual([waiting, (await storedNs(store)).length], [1, 101]);
});

test('an event after an insert waits until a second has passed since it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { events, store } = fixture();
  const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
  events.emit('delivery.due', app, { attempt: 0, n: 1 });
  await settle();
  events.emit('delivery.due', app, { attempt: 0, n: 2 });
  t.mock.timers.tick(999);
  await settle();
  const early = await storedNs(store);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual([early, await storedNs(store)], [[1], [1, 2]]);
});

test('the event tail hides rows younger than the settle window and shows them after', async () => {
  const { store, backdate } = fileStore();
  const { events, metrics, clock } = fixture({ store });
  events.emit('awake', app, { ms: 5 });
  await metrics.flushEvents();
  backdate(1500);
  const young = await metrics.events();
  backdate(600);
  clock.now += 1000;
  assert.deepEqual([young.length, (await metrics.events()).map((e) => [e.ev, e.app, e.ms])], [0, [['awake', 'survey', 5]]]);
});

test('event ids keep increasing after the gateway restarts on the same store', async () => {
  const { path, store } = fileStore();
  const before = fixture({ store });
  before.events.emit('delivery.due', app, { attempt: 0 });
  await before.metrics.flushEvents();
  await store.close();
  const reopened = new SqliteStore(path);
  const after = fixture({ store: reopened });
  after.events.emit('delivery.due', app, { attempt: 0 });
  await after.metrics.flushEvents();
  assert.deepEqual((await reopened.events({})).map((e) => e.id), [1, 2]);
});

test("the leader's sweep deletes events past the retention, then the oldest beyond the row cap", async () => {
  const { store, backdate } = fileStore();
  const row = (n: number) => ({ replica: 'r1' as ReplicaId, ev: 'delivery.due', app, tenant: DEFAULT_TENANT, body: { n } });
  await store.insertEvents([1, 2, 3].map(row));
  backdate(15 * 24 * HOUR);
  await store.insertEvents([4, 5, 6].map(row));
  const { metrics } = fixture({ store, clock: realClock(), policy: { events_max_rows: 2 } });
  await metrics.sample();
  assert.deepEqual(await storedNs(store), [5, 6]);
});
