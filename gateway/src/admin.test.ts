import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { startAdmin } from './admin.ts';
import { Docker } from './docker.ts';
import { EventLog } from './events.ts';
import { DockerInfra } from './infra.ts';
import { Metrics, Series } from './metrics.ts';
import { NodeView } from './nodes.ts';
import {
  appName, DEFAULT_POLICY, DEFAULT_TENANT, parseManifest, subject, USAGE_COUNTERS,
  type AppId, type AuditRecord, type HealthCheck, type ReplicaId, type Runtime, type RuntimeKind, type TenantName, type Usage,
} from './model.ts';
import { RequestLog } from './requests.ts';
import { Runtimes } from './runtimes.ts';
import { world } from './registry.fakes.ts';

async function admin(runtime?: Runtimes) {
  const w = world();
  const { registry, store } = await w.open();
  const metrics = new Metrics({
    events: new EventLog(() => {}),
    stats: () => [],
    apps: () => registry.listing(),
    deliveries: { counts: () => store.deliveryCounts(), failed: (limit) => store.deliveries({ state: 'failed', limit }) },
    nameOf: (app) => registry.nameOf(app),
    probes: { redis: async () => 'up' },
    host: async () => ({ cpus: 1, load: [0, 0, 0], memory: { totalBytes: 1, freeBytes: 1 }, data: null }),
    store,
    policy: () => registry.policy(),
    view: (name) => registry.view(name),
    series: new Series(),
    retries: () => 0,
    replica: 'r1' as ReplicaId,
  });
  const up = async () => 'up' as const;
  const off = async () => 'off' as const;
  const infra = new DockerInfra({ docker: new Docker('/nonexistent.sock'), probes: { redis: up, object: up, postgres: off, coturn: off, runner: off }, volumes: async () => [] });
  const nodes = new NodeView({
    infra,
    apps: () => registry.listing(),
    nameOf: (app) => registry.nameOf(app),
    instances: { row: () => null, rows: () => [][Symbol.iterator]() },
    replicas: async () => [],
    runner: async () => null,
  });
  const requests = new RequestLog(() => {});
  const logs = { logs: (app: AppId, tail: number) => w.runtime.logs(app, tail), healthOf: () => [] };
  const server = await startAdmin({
    registry, bundles: w.bundles, runtime: runtime ?? logs, guard: w.runtime, metrics, nodes, infra, scaleMax: 10, requests, replica: 'r1' as ReplicaId, store, ingressPort: 18080,
    providers: [...w.providers.values()],
  }, { port: 0 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(base + path, { method, body: raw });
    return { status: response.status, body: await response.json() };
  };
  return { w, registry, store, server, call, base, metrics, nodes, requests };
}

const kvApp = { image: 'example:1', manifest: { contract: 1, capabilities: { kv: {} } }, owner: 'user:ann' };

test('every contract endpoint answers 200 on valid input', async (t) => {
  const { call, server } = await admin();
  t.after(() => server.close());
  const health = await call('GET', '/api/health');
  assert.deepEqual([health.status, health.body.ok, health.body.ingressPort], [200, true, 18080]);

  const bundle = await call('POST', '/api/bundles', 'tar bytes');
  assert.equal(bundle.status, 200);
  const site = { image: null, manifest: { contract: 1, capabilities: { static: { dir: 'dist' } } }, bundle: bundle.body.bundle, owner: 'user:ann' };
  const published = await call('PUT', '/api/apps/site/release', site);
  assert.deepEqual([published.status, published.body.number, published.body.image, published.body.bundle], [200, 1, null, bundle.body.bundle]);
  assert.equal((await call('PUT', '/api/apps/survey/release', kvApp)).status, 200);

  const listed = await call('GET', '/api/apps');
  assert.deepEqual(listed.body.map((a: { name: string; status: string }) => [a.name, a.status]), [['site', 'registered'], ['survey', 'registered']]);
  const detail = await call('GET', '/api/apps/survey');
  assert.deepEqual([detail.status, detail.body.bindings.map((b: { kind: string }) => b.kind)], [200, ['kv']]);
  assert.equal(detail.body.bindings[0].resource, undefined);

  assert.deepEqual(await call('PUT', '/api/apps/survey/policy', { idle_seconds: 5 }), { status: 200, body: { idle_seconds: 5 } });
  assert.equal((await call('PUT', '/api/policy', { idle_seconds: 5, timezone: 'Asia/Shanghai' })).body.timezone, 'Asia/Shanghai');
  assert.deepEqual(await call('PUT', '/api/apps/survey/owner', { owner: 'user:bob' }), { status: 200, body: { owner: 'user:bob' } });
  assert.deepEqual(await call('PUT', '/api/apps/survey/access', { access: 'public' }), { status: 200, body: { access: 'public' } });
  const token = await call('POST', '/api/tokens', { name: 'ci' });
  assert.deepEqual([token.status, token.body.subject, typeof token.body.token], [200, 'service:ci', 'string']);
  assert.equal((await call('POST', '/api/apps/survey/remove')).status, 200);
  assert.equal((await call('POST', '/api/apps/survey/purge')).status, 200);
  assert.equal((await call('GET', '/api/apps/survey')).status, 404);
});


test('GET /api/cluster on the docker plane lists the compose services, none scalable, and no nodes or warnings (AC-OPS-11)', async (t) => {
  const { call, server, nodes } = await admin();
  t.after(() => server.close());
  await nodes.sample();
  const { body } = await call('GET', '/api/cluster');
  assert.deepEqual([body.plane, body.nodes, body.warnings], ['docker', [], []]);
  assert.deepEqual(body.workloads.map((w: { name: string; ready: number; scalable: boolean }) => [w.name, w.ready, w.scalable]), [
    ['gateway', 1, false], ['redis', 1, false], ['rustfs', 1, false], ['postgres', 0, false], ['coturn', 0, false], ['runner', 0, false],
  ]);
});

test('scaling to 0 replicas or above PNEUMA_SPACE_SCALE_MAX answers 400 (AC-OPS-12)', async (t) => {
  const { call, server } = await admin();
  t.after(() => server.close());
  const [none, many] = [await call('PUT', '/api/cluster/workloads/pneuma-space-runner/scale', { replicas: 0 }), await call('PUT', '/api/cluster/workloads/pneuma-space-runner/scale', { replicas: 11 })];
  assert.deepEqual([none.status, many.status], [400, 400]);
});

test('scaling on the docker plane answers 409 and the audit lists cluster.scale with the replica count', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  assert.equal((await call('PUT', '/api/cluster/workloads/pneuma-space-runner/scale', { replicas: 2 })).status, 409);
  const rows = await audit(store, 'pneuma-space-runner');
  assert.deepEqual(rows.map((r) => [r.action, r.targetKind, r.result, r.details.replicas]).sort(), [['cluster.scale', 'workload', 'refused', 2], ['cluster.scale', 'workload', 'started', 2]]);
});

test('input errors answer 400, unknown apps and images 404, conflicts 409', async (t) => {
  const { call, server } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  const statuses = await Promise.all([
    call('PUT', '/api/apps/survey/release', { ...kvApp, manifest: { contract: 1, capabilities: { kafka: {} } } }),
    call('PUT', '/api/apps/survey/release', 'not json'),
    call('PUT', '/api/apps/survey/policy', { idle_seconds: 0 }),
    call('PUT', '/api/apps/survey/policy', { timezone: 'UTC' }),
    call('PUT', '/api/policy', { timezone: 'Mars/Olympus' }),
    call('GET', '/api/apps/nobody'),
    call('PUT', '/api/apps/other/release', { ...kvApp, image: 'missing:1' }),
    call('POST', '/api/apps/survey/purge'),
  ]);
  assert.deepEqual(statuses.map((r) => r.status), [400, 400, 400, 400, 400, 404, 404, 409]);
  assert.match(statuses[0].body.error, /"kafka"/);
});

test('GET /api/apps lists every app without a Docker call', async (t) => {
  const { call, server, registry, w } = await admin();
  t.after(() => server.close());
  const manifest = parseManifest({ contract: 1, capabilities: { kv: {}, files: {} } });
  for (let i = 0; i < 20; i++) {
    await registry.publish({ name: appName(`app-${i}`), image: 'example:1', manifest, bundle: null, owner: subject('user:ann') });
  }
  w.runtime.calls.length = 0;
  const listed = await call('GET', '/api/apps');
  assert.equal(listed.body.length, 20);
  assert.deepEqual(w.runtime.calls, []);
});

test('GET /api/apps/<name>/logs answers the container output as text/plain for the requested tail', async (t) => {
  const { call, server, base, store } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  const response = await fetch(`${base}/api/apps/survey/logs?tail=5`);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await response.text(), `last 5 lines of ${(await store.app(appName('survey')))!.id}\n`);
});

test('GET /api/metrics answers the sampled snapshot without a Docker call', async (t) => {
  const { call, server, metrics, w } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  await metrics.sample();
  w.runtime.calls.length = 0;
  const replies = await Promise.all(Array.from({ length: 20 }, () => call('GET', '/api/metrics')));
  assert.deepEqual(replies.map((r) => [r.status, r.body.fleet.apps.registered, r.body.services.redis.status]), Array(20).fill([200, 1, 'up']));
  assert.deepEqual(w.runtime.calls, []);
});

test('GET /api/requests answers the records after the cursor, named, without a Docker call', async (t) => {
  const { call, server, store, requests, w } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  const id = (await store.app(appName('survey')))!.id as AppId;
  for (const path of ['/a', '/b', '/c']) requests.record({ app: id, kind: 'request', method: 'GET', path, status: 200, ms: 2, waitMs: 1, cold: false, subject: null, error: null });
  w.runtime.calls.length = 0;
  const first = await call('GET', '/api/requests?after=&limit=1');
  const reply = await call('GET', `/api/requests?after=${encodeURIComponent(first.body.cursor)}&limit=1`);
  assert.deepEqual(reply.body.records.map((r: { replica: string; seq: number; app: string; path: string }) => [r.replica, r.seq, r.app, r.path]), [['r1', 2, 'survey', '/b']]);
  assert.deepEqual(reply.body.reset, []);
  assert.deepEqual(w.runtime.calls, []);
});

test('GET /api/requests?local=1 tells a peer this replica restarted since its cursor (#18)', async (t) => {
  const { call, server, requests } = await admin();
  t.after(() => server.close());
  const page = (await call('GET', `/api/requests?local=1&after=${encodeURIComponent(`r1:0@${requests.generation - 1}`)}`)).body;
  assert.deepEqual([page.replica, page.generation, page.reset], ['r1', requests.generation, true]);
});

test('POST /api/apps/<name>/unquarantine lifts the quarantine the listing shows', async (t) => {
  const { call, server, store, w } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  w.runtime.quarantined.set((await store.app(appName('survey')))!.id, { reason: 'exit 1', since: 1, failures: 3 });
  assert.equal((await call('GET', '/api/apps')).body[0].quarantine.failures, 3);
  assert.deepEqual(await call('POST', '/api/apps/survey/unquarantine'), { status: 200, body: { quarantine: null } });
  assert.equal((await call('GET', '/api/apps')).body[0].quarantine, null);
});

test('GET /api/health lists every runtime kind with its checks and the global policy, without a Docker call', async (t) => {
  const calls: string[] = [];
  /** Answers kind and health; records every other Runtime method, each of which may reach Docker. */
  const reporting = (kind: RuntimeKind, checks: HealthCheck[]) => new Proxy({ kind, health: () => checks }, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : (...args: unknown[]) => void calls.push(`${kind}.${String(key)}(${args.join(',')})`)),
  }) as unknown as Runtime;
  const runtimes = new Runtimes({
    runtimes: [reporting('container', ['exit', 'ready']), reporting('isolate', ['exit', 'ready', 'hang', 'memory'])], specFor: () => null, events: new EventLog(() => {}),
  });
  const { call, server } = await admin(runtimes);
  t.after(() => server.close());
  const { body } = await call('GET', '/api/health');
  assert.deepEqual(body.runtimes, {
    container: { service: null, profile: null, health: ['exit', 'ready'] },
    isolate: { service: 'runner', profile: 'isolate', health: ['exit', 'ready', 'hang', 'memory'] },
  });
  assert.deepEqual(body.policy, DEFAULT_POLICY);
  assert.deepEqual(calls, []);
});

test('GET /api/usage filters by app and by tenant', async (t) => {
  const { call, server, registry, store } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  const survey = registry.view(appName('survey'))!.app;
  const row = (app: AppId, tenant: TenantName, requests: number): Usage => ({
    ...(Object.fromEntries(USAGE_COUNTERS.map((c) => [c, 0])) as Record<(typeof USAGE_COUNTERS)[number], number>),
    app, tenant, step: 3600, start: 7_200_000, replica: 'r1' as ReplicaId, requests,
  });
  await store.putUsage([row(survey, DEFAULT_TENANT, 4), row('other0000001' as AppId, 'lab' as TenantName, 9)]);
  const requests = async (query: string) => (await call('GET', `/api/usage?${query}&from=0&to=10800000`)).body.buckets.map((b: Usage) => b.requests);
  assert.deepEqual([await requests('app=survey'), await requests('tenant=lab')], [[4], [9]]);
});

const audit = async (store: { audit: (filter: { target?: string }) => Promise<AuditRecord[]> }, target: string) =>
  (await store.audit({ target })).reverse().map(({ actor, actorTenant, tenant, action, targetKind, target: id, result, details }) => ({ actor, actorTenant, tenant, action, targetKind, target: id, result, details }));

test('a publish writes a started row, then an ok row with the release number and key', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  const release = (await call('PUT', '/api/apps/survey/release', kvApp)).body;
  const row = { actor: 'local', actorTenant: null, tenant: DEFAULT_TENANT, action: 'app.publish', targetKind: 'app', target: 'survey' };
  assert.deepEqual(await audit(store, 'survey'), [
    { ...row, result: 'started', details: {} },
    { ...row, result: 'ok', details: { release: 1, releaseKey: release.releaseKey } },
  ]);
});

test('a request the handler refuses writes refused with the reason', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  assert.equal((await call('POST', '/api/apps/survey/purge')).status, 409);
  const [started, refused] = (await audit(store, 'survey')).filter((r) => r.action === 'app.purge');
  assert.deepEqual([started.result, refused.result], ['started', 'refused']);
  assert.match(String(refused.details.error), /remove it before purging/);
});

test('a handler that throws writes error with the message', async (t) => {
  const { call, server, store, w } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  w.runtime.unquarantine = () => { throw new Error('guard unreachable'); };
  assert.equal((await call('POST', '/api/apps/survey/unquarantine')).status, 500);
  assert.deepEqual((await audit(store, 'survey')).at(-1), {
    actor: 'local', actorTenant: null, tenant: DEFAULT_TENANT, action: 'app.unquarantine', targetKind: 'app', target: 'survey',
    result: 'error', details: { error: 'guard unreachable' },
  });
});

test('a token issue row carries the token id and never the secret', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  const issued = (await call('POST', '/api/tokens', { name: 'ci' })).body;
  const rows = await audit(store, 'service:ci');
  assert.deepEqual(rows.map((r) => [r.action, r.targetKind, r.result, r.details]), [['token.issue', 'token', 'started', {}], ['token.issue', 'token', 'ok', { token: issued.id }]]);
  assert.equal(JSON.stringify(await store.audit({})).includes(issued.token), false);
});

test('GET /api/audit filters by tenant, time range, action and actor, newest first within the limit', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  const row = { actor: subject('user:ann'), actorTenant: null, tenant: 'lab' as TenantName, action: 'app.remove', targetKind: 'app', target: 'a', result: 'ok', details: {} } as const;
  for (const at of [10, 20, 30, 40]) await store.insertAudit({ ...row, at });
  await store.insertAudit({ ...row, at: 25, tenant: DEFAULT_TENANT });
  await store.insertAudit({ ...row, at: 25, action: 'app.purge' });
  await store.insertAudit({ ...row, at: 25, actor: subject('user:bob') });
  const ats = async (query: string) => (await call('GET', `/api/audit?${query}`)).body.map((r: AuditRecord) => r.at);
  assert.deepEqual(await ats('tenant=lab&from=20&to=40&action=app.remove&actor=user:ann'), [30, 20]);
  assert.deepEqual(await ats('tenant=lab&action=app.remove&actor=user:ann&limit=3'), [40, 30, 20]);
});

test('the state inventory lists every binding\'s location and the release\'s bundle, and no credential (AC-OPS-9)', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  const manifest = { contract: 1, capabilities: { files: {}, db: {}, kv: {}, object: {} } };
  assert.equal((await call('PUT', '/api/apps/vault/release', { ...kvApp, manifest })).status, 200);
  const secrets = (await store.bindings()).map((b) => b.resource.password!);
  assert.equal(secrets.length, 4);

  const one = await call('GET', '/api/apps/vault/state');
  assert.deepEqual([one.body.app, one.body.release, one.body.bundle], ['vault', 1, null]);
  assert.deepEqual(one.body.bindings.map((b: { kind: string }) => b.kind).sort(), ['db', 'files', 'kv', 'object']);
  const tenant = await call('GET', `/api/state?tenant=${DEFAULT_TENANT}`);
  assert.deepEqual(tenant.body.apps, [one.body]);
  for (const secret of secrets) assert.ok(!JSON.stringify([one.body, tenant.body]).includes(secret), 'no credential in the inventory');
});

test('a first publish past the tenant\'s apps quota answers 409 with the quota field', async (t) => {
  const { call, server } = await admin();
  t.after(() => server.close());
  await call('POST', '/api/tenants', { name: 'blue', admins: ['ann'] });
  await call('PUT', '/api/tenants/blue/quota', { apps: 1 });
  assert.equal((await call('PUT', '/api/apps/one/release', { ...kvApp, tenant: 'blue' })).status, 200);
  const refused = await call('PUT', '/api/apps/two/release', { ...kvApp, tenant: 'blue' });
  assert.deepEqual([refused.status, refused.body.quota], [409, { tenant: 'blue', resource: 'apps', used: 1, limit: 1, ask: 1 }]);
});

test('switching an app to SQLite past the tenant\'s storage_gb answers 409 with the quota field (#12)', async (t) => {
  const { call, server } = await admin();
  t.after(() => server.close());
  await call('POST', '/api/tenants', { name: 'blue', admins: ['ann'] });
  await call('PUT', '/api/tenants/blue/quota', { storage_gb: 0 });
  await call('PUT', '/api/policy', { db_backend: 'postgres' });
  await call('PUT', '/api/apps/one/release', { ...kvApp, manifest: { contract: 1, capabilities: { db: {} } }, tenant: 'blue' });
  const refused = await call('PUT', '/api/apps/one/policy', { db_backend: 'sqlite' });
  assert.deepEqual([refused.status, refused.body.quota], [409, { tenant: 'blue', resource: 'storage_gb', used: 0, limit: 0, ask: 1 }]);
  assert.equal((await call('GET', '/api/tenants/blue/quota')).body.used.storage_gb, 0);
});

test('a per-app cpu_millis or memory_mb above the tenant\'s total answers 400', async (t) => {
  const { call, server } = await admin();
  t.after(() => server.close());
  await call('POST', '/api/tenants', { name: 'blue', admins: ['ann'] });
  await call('PUT', '/api/tenants/blue/quota', { cpu_millis: 2000, memory_mb: 1024 });
  await call('PUT', '/api/apps/one/release', { ...kvApp, tenant: 'blue' });
  const statuses = await Promise.all([
    call('PUT', '/api/apps/one/policy', { cpu_millis: 2001 }),
    call('PUT', '/api/apps/one/policy', { memory_mb: 1025 }),
    call('PUT', '/api/apps/one/policy', { cpu_millis: 2000, memory_mb: 1024 }),
  ]);
  assert.deepEqual(statuses.map((r) => r.status), [400, 400, 200]);
});
