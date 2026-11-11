import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import dns from 'node:dns';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { mock, test, type TestContext } from 'node:test';
import { EventLog } from './events.ts';
import { admission, EXPOSITION_TYPE, Metrics, networkProbe, profileProbe, serveMetrics, Series, untilUp, type ServiceStatus } from './metrics.ts';
import {
  Conflict, DEFAULT_TENANT, USAGE_COUNTERS, appName, parseManifest, subject,
  type AppId, type AppSummary, type InstanceState, type ReplicaId, type TenantName, type Traffic, type Usage,
} from './model.ts';
import { addressOnNetwork, createProviders, networkResolver, providerConfig } from './providers.ts';
import { world } from './registry.fakes.ts';
import { SqliteStore } from './store.ts';

const HOUR = 3_600_000;
const app = 'a1b2c3d4e5f6' as AppId;
const survey = appName('survey');

function fixture({ store = new SqliteStore(':memory:'), replica = 'r1', leader = true, term = undefined as (() => { readonly since: number } | null) | undefined, clock = { now: 1_800_000_000_000 }, policy = {} } = {}) {
  const events = new EventLog(() => {});
  const stats: Traffic[] = [];
  const apps: AppSummary[] = [];
  const always = { since: clock.now };
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
    term: term ?? (() => (leader ? always : null)),
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

/** Replicas a and b over one store and one clock, the app awake throughout; `lead(r)` starts r's term now and ends the other's. */
function awakeReplicas() {
  const store = new SqliteStore(':memory:');
  const clock = { now: 1_800_000_000_000 };
  const terms: Record<'a' | 'b', { readonly since: number } | null> = { a: null, b: null };
  const replica = (id: 'a' | 'b') => {
    const f = fixture({ store, replica: id, clock, term: () => terms[id] });
    f.apps.push(summary('awake'));
    return f.metrics;
  };
  const lead = (id: 'a' | 'b') => {
    terms.a = terms.b = null;
    terms[id] = { since: clock.now };
  };
  const awakeMs = async (from = 0, to = clock.now + HOUR) => (await store.usage({ step: 3600, app, from, to })).reduce((sum, b) => sum + b.awakeMs, 0);
  return { a: replica('a'), b: replica('b'), lead, clock, awakeMs };
}

test('a replica that leads again after another led counts none of the time the other led (#15)', async () => {
  const { a, b, lead, clock, awakeMs } = awakeReplicas();
  const start = clock.now;
  lead('a');
  await a.sample();
  clock.now += 10_000;
  await a.sample();
  lead('b');
  await b.sample();
  for (let i = 0; i < 6; i++) {
    clock.now += 10_000;
    await b.sample();
  }
  lead('a');
  await a.sample();
  const [total, truth] = [await awakeMs(), clock.now - start];
  assert.ok(total <= truth && total >= truth - 2 * 10_000, `awake ${total} ms of ${truth}`);
});

test('across 20 rounds of a, b, a leading, awake time loses at most one sampling interval per switch and counts nothing twice (#15)', async () => {
  const { a, b, lead, clock, awakeMs } = awakeReplicas();
  const start = clock.now;
  let [leader, switches, last] = ['a' as 'a' | 'b', 0, start];
  lead('a');
  // a samples at :00 and b at :05 of every 10 s; each switch comes 100 ms after the new leader's sample, so its next one is almost an interval away.
  for (let t = 0; t < 35_100 + 40 * 35_000; t += 100) {
    clock.now = start + t;
    if (t >= 35_100 && (t - 35_100) % 35_000 === 0) {
      leader = leader === 'a' ? 'b' : 'a';
      lead(leader);
      switches++;
    }
    for (const [id, phase, metrics] of [['a', 0, a], ['b', 5000, b]] as const) {
      if (t % 10_000 !== phase) continue;
      await metrics.sample();
      if (leader === id) last = clock.now;
    }
  }
  const [total, truth] = [await awakeMs(), last - start];
  assert.ok(total <= truth && total >= truth - switches * 10_000, `awake ${total} ms of ${truth} after ${switches} switches`);
});

test('a switch across an hour boundary writes nothing into the earlier hour after it (#15)', async () => {
  const { a, b, lead, clock, awakeMs } = awakeReplicas();
  const hour = clock.now + HOUR;
  clock.now = hour - 20_000;
  lead('a');
  await a.sample();
  clock.now = hour - 10_000;
  await a.sample();
  const earlier = await awakeMs(hour - HOUR, hour);
  clock.now = hour - 5000;
  lead('b');
  await b.sample();
  clock.now = hour + 5000;
  await b.sample();
  clock.now = hour + 12_000;
  lead('a');
  for (const at of [20_000, 30_000]) {
    clock.now = hour + at;
    await a.sample();
  }
  assert.deepEqual([earlier, await awakeMs(hour - HOUR, hour)], [10_000, 10_000]);
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

/** The gateway on 172.20.0.5/16, and on 127.0.0.5/8 as an ordinary interface so a local listener is a service on its network. */
const gatewayInterfaces = (): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  eth0: [{ address: '172.20.0.5', netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:ac:14:00:05', internal: false, cidr: '172.20.0.5/16' }],
  eth1: [{ address: '127.0.0.5', netmask: '255.0.0.0', family: 'IPv4', mac: '02:42:7f:00:00:05', internal: false, cidr: '127.0.0.5/8' }],
});

type ServiceCase = { readonly name: string; readonly address: (service: string) => Promise<string | null>; readonly port: number; readonly strip: ServiceStatus };

/** The four ways a profile service can look to the gateway (#16): what its name resolves to, and whether that address accepts on the port. */
async function serviceCases(t: TestContext): Promise<ServiceCase[]> {
  const listen = async () => {
    const server = createTcpServer((socket) => socket.destroy()).listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, port: (server.address() as AddressInfo).port };
  };
  const open = await listen();
  t.after(() => open.server.close());
  const closed = await listen();
  closed.server.close();
  const answering = (answer: () => Promise<string[]>) => (service: string) => addressOnNetwork(service, { resolve: answer, interfaces: gatewayInterfaces });
  const nxdomain = () => Promise.reject(Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' }));
  return [
    { name: 'no such name', address: answering(nxdomain), port: open.port, strip: 'off' },
    { name: 'a synthetic answer', address: answering(async () => ['198.18.6.17']), port: open.port, strip: 'off' },
    { name: 'an address on the network that refuses', address: answering(async () => ['127.0.0.1']), port: closed.port, strip: 'down' },
    { name: 'an address on the network that accepts', address: answering(async () => ['127.0.0.1']), port: open.port, strip: 'up' },
  ];
}

const profiles = (c: ServiceCase) => ({
  postgres: profileProbe('postgres', c.port, c.address), coturn: profileProbe('coturn', c.port, c.address), runner: profileProbe('runner', c.port, c.address),
});

test('the service strip reads off for no name and for a synthetic answer, down for a refusing address, up for an accepting one, and admission admits only up (#16)', async (t) => {
  for (const c of await serviceCases(t)) {
    for (const service of ['postgres', 'coturn', 'runner'] as const) {
      const probes = profiles(c);
      assert.deepEqual([await probes[service](), await admission(probes)(service)], [c.strip, c.strip === 'up'], `${service}: ${c.name}`);
    }
  }
});

test("a publish needing the runner, coturn or postgres answers the contract's 409 unless the service is on the network and accepts (#16)", async (t) => {
  for (const c of await serviceCases(t)) {
    const probe = admission(profiles(c));
    const config = { ...providerConfig({ PNEUMA_SPACE_RTC_SECRET: 's' }), postgres: { host: '127.0.0.1', port: c.port, password: 'p' } };
    const real = createProviders({ destroyStorage: async () => {} }, config, probe);
    const w = world();
    const providers = [...[...w.providers.values()].filter((p) => p.name !== 'coturn' && p.name !== 'postgres'), real.coturn, real.postgres];
    const { registry } = await w.open({ probe, providers });
    await registry.setGlobalPolicy({ db_backend: 'postgres' });
    const bundle = await w.bundles.put(Readable.from([Buffer.from('app dir')]));
    const publish = (name: string, image: string | null, manifest: Record<string, unknown>) =>
      registry.publish({ name: appName(name), image, manifest: parseManifest({ contract: 1, ...manifest }), bundle: image ? null : bundle, owner: subject('user:ann') })
        .then(() => 'published', (error) => (error instanceof Conflict && /--profile/.test(error.message) ? '409' : 'admitted'));
    const outcomes = [
      await publish('iso', null, { runtime: 'isolate', capabilities: {} }),
      await publish('game', 'example:1', { capabilities: { rtc: {} } }),
      await publish('form', 'example:1', { capabilities: { db: {} } }),
    ];
    // Past admission the postgres provider speaks to the test's listener, which is not PostgreSQL.
    assert.deepEqual(outcomes, c.strip === 'up' ? ['published', 'published', 'admitted'] : ['409', '409', '409'], c.name);
  }
});

test('a resolver that never answers costs one bounded query and no connection, and never the libuv lookup pool (#16)', async (t) => {
  const silent = createSocket('udp4');
  silent.bind(0, '127.0.0.1');
  await once(silent, 'listening');
  t.after(() => silent.close());
  const resolver = networkResolver([`127.0.0.1:${silent.address().port}`]);
  const lookup = mock.method(dns, 'lookup');
  t.after(() => lookup.mock.restore());
  let queries = 0;
  const address = (service: string) => addressOnNetwork(service, { resolve: (name) => (queries++, resolver.resolve4(name)) });
  assert.deepEqual([await profileProbe('runner', 8082, address)(), queries, lookup.mock.callCount()], ['off', 1, 0]);
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
