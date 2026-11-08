import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventLog } from './events.ts';
import { Metrics } from './metrics.ts';
import { DEFAULT_TENANT, USAGE_COUNTERS, appName, type AppId, type AppSummary, type InstanceState, type ReplicaId, type Stats, type Usage } from './model.ts';
import { SqliteStore } from './store.ts';

const HOUR = 3_600_000;
const app = 'a1b2c3d4e5f6' as AppId;
const survey = appName('survey');

function fixture({ store = new SqliteStore(':memory:'), replica = 'r1', leader = true, clock = { now: 1_800_000_000_000 } } = {}) {
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
    usage: store,
    policy: () => ({ usage_retention_days: 90 }),
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

test('a wake with its latency lands in the current minute and in the last hour with p50', () => {
  const { events, metrics, last } = fixture();
  events.emit('waking', app);
  events.emit('awake', app, { ms: 840 });
  const snapshot = metrics.snapshot();
  assert.equal(last(snapshot.series.wakes), 1);
  assert.equal(last(snapshot.series.wakeMeanMs), 840);
  assert.deepEqual(snapshot.wakes.last1h, { count: 1, failures: 0, p50Ms: 840, p95Ms: 840 });
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

test('the events ring keeps the last 100, newest last', () => {
  const { events, metrics } = fixture();
  for (let i = 0; i < 120; i++) events.emit('delivery.due', app, { attempt: 0, n: i });
  const { events: ring } = metrics.snapshot();
  assert.equal(ring.length, 100);
  assert.equal(ring.at(-1)!.n, 119);
});

test('each event carries a seq one above the previous', () => {
  const { events, metrics } = fixture();
  for (let i = 0; i < 3; i++) events.emit('delivery.due', app, { attempt: 0 });
  assert.deepEqual(metrics.snapshot().events.map((e) => e.seq), [1, 2, 3]);
});
