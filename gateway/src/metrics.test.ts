import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import dns from 'node:dns';
import { createServer as createTcpServer } from 'node:net';
import { mock, test } from 'node:test';
import { EventLog } from './events.ts';
import { EXPOSITION_TYPE, Metrics, networkProbe, profileProbe, serveMetrics, Series, untilUp } from './metrics.ts';
import { DEFAULT_TENANT, USAGE_COUNTERS, appName, type AppId, type AppSummary, type InstanceState, type ReplicaId, type TenantName, type Traffic, type Usage } from './model.ts';
import { SqliteStore } from './store.ts';

const HOUR = 3_600_000;
const app = 'a1b2c3d4e5f6' as AppId;
const survey = appName('survey');

function fixture({ store = new SqliteStore(':memory:'), replica = 'r1', leader = true, clock = { now: 1_800_000_000_000 }, policy = {} } = {}) {
  const events = new EventLog(() => {});
  const stats: Traffic[] = [];
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
    series: new Series(),
    retries: () => 0,
    replica: replica as ReplicaId,
    leader: () => leader,
    now: () => clock.now,
  });
  const last = (series: readonly (number | null)[]) => series.at(-1);
  const hourRow = async () => (await store.usage({ step: 3600, app, from: 0, to: clock.now + HOUR }))[0];
  return { clock, events, stats, apps, metrics, store, last, hourRow };
}

const summary = (instance: InstanceState): AppSummary => ({
  name: survey, address: '/apps/survey/', tenant: DEFAULT_TENANT, access: 'org', release: null, capabilities: [], status: 'registered', instance, since: null,
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

/** A replica that has answered a request, run a wake and sampled an awake instance. */
async function exported(leader = true) {
  const f = fixture({ leader });
  f.apps.push(summary('awake'));
  f.events.emit('waking', app);
  f.events.emit('awake', app, { ms: 300, tenant: DEFAULT_TENANT, runtime: 'container' });
  await f.metrics.sample();
  return f.metrics.prometheus();
}

const FAMILIES = /^pneuma_space_(instances|tenant_quota_used|tenant_quota_limit|deliveries|service_up)[{ ]/m;

test('a wake adds to its bucket and every bucket above, and to _sum and _count', () => {
  const series = new Series();
  series.awake(DEFAULT_TENANT, 'container', 300);
  const lines = series.render().split('\n').filter((l) => l.startsWith('pneuma_space_wake_duration_seconds_') && /le="0\.(25|5)"|le="\+Inf"|_sum|_count/.test(l));
  assert.deepEqual(lines, [
    'pneuma_space_wake_duration_seconds_bucket{runtime="container",le="0.25"} 0',
    'pneuma_space_wake_duration_seconds_bucket{runtime="container",le="0.5"} 1',
    'pneuma_space_wake_duration_seconds_bucket{runtime="container",le="+Inf"} 1',
    'pneuma_space_wake_duration_seconds_sum{runtime="container"} 0.3',
    'pneuma_space_wake_duration_seconds_count{runtime="container"} 1',
  ]);
});

test('only the leader exports the instance, quota, delivery and service gauges', async () => {
  assert.deepEqual([FAMILIES.test(await exported(true)), FAMILIES.test(await exported(false))], [true, false]);
});

test('no sample carries an app label', async () => {
  assert.doesNotMatch(await exported(), /^[^#].*[{,]app="/m);
});

test('a label value with a quote, a backslash and a newline is escaped', () => {
  const series = new Series();
  series.request('a"b\\c\nd' as TenantName, null, 'request', false);
  assert.match(series.render(), /^pneuma_space_requests_total\{tenant="a\\"b\\\\c\\nd",runtime="none",kind="request"\} 1$/m);
});

test('the exposition parses: every sample is name{labels} value under one HELP and one TYPE of its family', async () => {
  const lines = (await exported()).trimEnd().split('\n');
  const declared = (kind: string) => lines.filter((l) => l.startsWith(`# ${kind} `)).map((l) => l.split(' ')[2]);
  const types = new Map(lines.filter((l) => l.startsWith('# TYPE ')).map((l) => [l.split(' ')[2], l.split(' ')[3]]));
  assert.deepEqual(declared('HELP'), [...new Set(declared('HELP'))]);
  assert.deepEqual(declared('TYPE'), declared('HELP'));
  const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\]|\\.)*",?)*\})? (\S+)$/;
  for (const line of lines.filter((l) => !l.startsWith('#'))) {
    const match = sample.exec(line);
    assert.ok(match && !Number.isNaN(Number(match[5])), line);
    const name = match[1];
    const family = types.has(name) ? name : name.replace(/_(bucket|sum|count)$/, '');
    assert.ok(types.has(family) && (family === name || types.get(family) === 'histogram'), line);
  }
});

test('without PNEUMA_SPACE_METRICS_PORT no exporter starts', async () => {
  assert.equal(await serveMetrics(undefined, () => ''), null);
});

test('the exporter answers GET /metrics in the exposition format and 404 elsewhere', async (t) => {
  const server = (await serveMetrics('0', () => 'x 1\n'))!;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const [metrics, other] = await Promise.all([fetch(`${base}/metrics`), fetch(`${base}/api/metrics`)]);
  assert.deepEqual([metrics.status, metrics.headers.get('content-type'), await metrics.text(), other.status], [200, EXPOSITION_TYPE, 'x 1\n', 404]);
});

test('a Compose service is probed at the address the network gives, never by getaddrinfo', async (t) => {
  const server = createTcpServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const lookup = mock.method(dns, 'lookup');
  t.after(() => lookup.mock.restore());
  const at = async () => '127.0.0.1';
  assert.deepEqual([await networkProbe('redis', port, at)(), await profileProbe('runner', port, at)()], ['up', 'up']);
  assert.equal(lookup.mock.callCount(), 0);
});

test('a Compose service the network does not name is down, and a profile one is off', async () => {
  const nowhere = async () => null;
  assert.deepEqual([await networkProbe('redis', 6379, nowhere)(), await profileProbe('postgres', 5432, nowhere)()], ['down', 'off']);
});

test('the gateway waits for a service that is not up yet, and says so once', async () => {
  const answers = [false, false, true];
  let waited = 0;
  assert.equal(await untilUp(async () => answers.shift()!, { everyMs: 1, waiting: () => waited++ }), true);
  assert.deepEqual([answers.length, waited], [0, 1]);
});

test('the gateway stops waiting for a service that stays down', async () => {
  assert.equal(await untilUp(async () => { throw new Error('refused'); }, { everyMs: 1, forMs: 20 }), false);
});
