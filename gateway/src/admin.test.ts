import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { startAdmin, type AdminDeps } from './admin.ts';
import { Docker } from './docker.ts';
import { EventLog } from './events.ts';
import { DockerInfra } from './infra.ts';
import { Metrics, Series } from './metrics.ts';
import { NodeView } from './nodes.ts';
import {
  appName, DEFAULT_POLICY, DEFAULT_TENANT, parseManifest, subject, USAGE_COUNTERS,
  type AppId, type AuditRecord, type HealthCheck, type Infra, type ReplicaId, type Runtime, type RuntimeKind, type TenantName, type Usage,
} from './model.ts';
import { RequestLog } from './requests.ts';
import { Runtimes } from './runtimes.ts';
import { fakeKubernetes, world } from './registry.fakes.ts';

/** The admin API over a registry on a real store; `infra` is the plane's, the docker one by default, while images resolve from the fake table. */
async function admin({ runtime, infra: plane, overrides = {} }: { runtime?: Runtimes; infra?: Infra; overrides?: Partial<AdminDeps> } = {}) {
  const w = world();
  const up = async () => 'up' as const;
  const off = async () => 'off' as const;
  const infra = plane ?? new DockerInfra({ docker: new Docker('/nonexistent.sock'), probes: { redis: up, object: up, postgres: off, coturn: off, runner: off }, volumes: async () => [] });
  const { registry, store } = await w.open({
    infra: { resolveImage: (reference) => w.runtime.resolveImage(reference), removedBy: (name, replicas) => infra.removedBy(name, replicas), scale: (name, replicas) => infra.scale(name, replicas) },
  });
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
    providers: [...w.providers.values()], ...overrides,
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

test('a runner scale-down that would remove an app\'s home answers 409 with the app and its replica, reaches no Kubernetes API and is audited as refused with the count (ADR 0032)', async (t) => {
  const k8s = await fakeKubernetes(t, { 'pneuma-space-runner': 3 });
  const { call, server, store, w } = await admin({ infra: k8s.infra });
  t.after(() => server.close());
  w.runtime.homed = [{ app: appName('notes'), home: 'pneuma-space-runner-2' }];
  const refused = await call('PUT', '/api/cluster/workloads/pneuma-space-runner/scale', { replicas: 2 });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.stranded, { workload: 'pneuma-space-runner', replicas: 2, homes: [{ app: 'notes', home: 'pneuma-space-runner-2' }], more: 0 });
  assert.deepEqual([k8s.seen, k8s.replicas['pneuma-space-runner']], [[], 3]);
  const rows = await audit(store, 'pneuma-space-runner');
  assert.deepEqual(rows.map((r) => [r.result, r.details.replicas]), [['started', 2], ['refused', 2]]);
});

test('on the kubernetes plane 0 and 11 replicas answer 400 and pneuma-space-postgres 409, none reaching Kubernetes (AC-OPS-12)', async (t) => {
  const k8s = await fakeKubernetes(t, { 'pneuma-space-runner': 3 });
  const { call, server } = await admin({ infra: k8s.infra });
  t.after(() => server.close());
  const statuses = [
    await call('PUT', '/api/cluster/workloads/pneuma-space-runner/scale', { replicas: 0 }),
    await call('PUT', '/api/cluster/workloads/pneuma-space-runner/scale', { replicas: 11 }),
    await call('PUT', '/api/cluster/workloads/pneuma-space-postgres/scale', { replicas: 2 }),
  ].map((r) => r.status);
  assert.deepEqual([statuses, k8s.seen], [[400, 400, 409], []]);
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
  const { call, server } = await admin({ runtime: runtimes });
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
    result: 'error', details: { error: 'guard unreachable', appId: (await store.app(appName('survey')))!.id },
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


test('hosted admin refuses an unauthenticated dependency configuration (AC-SAAS-4)', async () => {
  await assert.rejects(admin({ overrides: { hosted: { controlOrigin: 'https://control.test', identityPaths: [] } } }), /requires authentication/);
});

function hostedFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method, headers: init.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk) => { body += chunk; }).on('end', () => resolve({ status: res.statusCode!, json: () => JSON.parse(body) }));
    });
    req.on('error', reject).end(init.body);
  });
}

function hostedAdmin() {
  return admin({ overrides: {
    hosted: { controlOrigin: 'https://control.test', identityPaths: [] },
    upstream: {
      identity: { identify: async () => ({ via: 'hosted', subject: subject('user:ana'), name: 'Ana', sessionHash: 'hash', csrf: 'csrf', origin: 'https://control.test' }), challenge: () => ({ status: 401 }), serve: async () => {} },
      authority: { callerOf: async () => ({ actor: { via: 'hosted', subject: subject('user:ana'), name: 'Ana' }, platformAdmin: true, roles: new Map(), viaToken: false, authentication: { kind: 'hosted', sessionHash: 'hash', csrf: 'csrf', origin: 'https://control.test' } }) },
    },
  } });
}

test('hosted control writes require exact Origin and the session CSRF (AC-SAAS-4)', async (t) => {
  const { server, base } = await hostedAdmin();
  t.after(() => server.close());
  for (const headers of [{}, { origin: 'https://control.test' }, { origin: 'https://other.test', 'x-pneuma-space-csrf': 'csrf' }]) {
    const response = await hostedFetch(base + '/api/policy', { method: 'PUT', headers: { host: 'control.test', ...headers }, body: JSON.stringify({ idle_seconds: 10 }) });
    assert.equal(response.status, 403);
  }
  const accepted = await hostedFetch(base + '/api/policy', { method: 'PUT', headers: { host: 'control.test', origin: 'https://control.test', 'x-pneuma-space-csrf': 'csrf' }, body: JSON.stringify({ idle_seconds: 10 }) });
  assert.equal(accepted.status, 200);
  const me = (await hostedFetch(base + '/api/me', { headers: { host: 'control.test' } })).json() as Record<string, unknown>;
  assert.equal(me.csrf, 'csrf');
  assert.equal(me.hosted, true);
  assert.equal(JSON.stringify(me).includes('hash'), false);
});


test('hosted purge requires the exact typed app name (AC-SAAS-11)', async (t) => {
  const { server, base, registry } = await hostedAdmin();
  t.after(() => server.close());
  const name = appName('purge-confirm');
  await registry.publish({ name, image: 'example:1', manifest: parseManifest(kvApp.manifest), bundle: null, owner: subject('user:ana') });
  await registry.remove(name);
  const send = (confirm: string) => hostedFetch(base + `/api/apps/${name}/purge`, { method: 'POST', headers: { host: 'control.test', origin: 'https://control.test', 'x-pneuma-space-csrf': 'csrf' }, body: JSON.stringify({ confirm }) });
  assert.equal((await send('different')).status, 400);
  assert.equal(registry.view(name)?.status, 'removed');
  assert.equal((await send(name)).status, 200);
  assert.equal(registry.view(name), null);
});

test('AC-EPH-2 POST /api/apps/<name>/discard ends an ephemeral app and writes app.discard started and ok rows', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  assert.equal((await call('PUT', '/api/apps/trial/release', { ...kvApp, ephemeral: { ttl_seconds: 60 } })).status, 200);
  assert.deepEqual(await call('POST', '/api/apps/trial/discard'), { status: 200, body: { status: 'discarded' } });
  assert.equal((await call('GET', '/api/apps/trial')).status, 404);
  assert.deepEqual((await audit(store, 'trial')).filter((r) => r.action === 'app.discard').map((r) => r.result), ['started', 'ok']);
});

test('ADR 0038 POST /api/apps/<name>/discard?app=<id> answers 409 for another id and 400 for an empty one, and discards for the id the publish returned', async (t) => {
  const { call, server, registry } = await admin();
  t.after(() => server.close());
  const { body: release } = await call('PUT', '/api/apps/trial/release', { ...kvApp, ephemeral: {} });
  assert.deepEqual([(await call('POST', '/api/apps/trial/discard?app=0123456789ab')).status, (await call('POST', '/api/apps/trial/discard?app=')).status], [409, 400]);
  assert.equal(registry.view(appName('trial'))?.status, 'registered');
  assert.equal((await call('POST', `/api/apps/trial/discard?app=${release.app}`)).status, 200);
  assert.equal(registry.view(appName('trial')), null);
});

test('ADR 0038 item 10 a per-app write with ?app= of another app answers 409 and changes nothing; with the app\'s own id it acts', async (t) => {
  const { call, server, registry } = await admin();
  t.after(() => server.close());
  const { body: release } = await call('PUT', '/api/apps/survey/release', kvApp);
  const other = '0123456789ab';
  const writes: [string, string, unknown?][] = [
    ['PUT', 'policy', { idle_seconds: 5 }], ['PUT', 'access', { access: 'public' }], ['PUT', 'owner', { owner: 'user:bo' }], ['POST', 'stop'], ['POST', 'restart'], ['POST', 'unquarantine'], ['POST', 'remove'],
  ];
  for (const [method, path, body] of writes) assert.equal((await call(method, `/api/apps/survey/${path}?app=${other}`, body)).status, 409, path);
  assert.deepEqual([registry.view(appName('survey'))?.status, registry.view(appName('survey'))?.access], ['registered', 'org']);
  assert.equal((await call('POST', `/api/apps/survey/remove?app=${release.app}`)).status, 200);
});

test('ADR 0038 item 10 a write checked against the app a lagging view still shows answers 409 and leaves the later app of the name alone', async (t) => {
  const { call, server, registry } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  const stale = registry.view(appName('survey'));
  await call('POST', '/api/apps/survey/remove');
  await call('POST', '/api/apps/survey/purge');
  await call('PUT', '/api/apps/survey/release', { ...kvApp, owner: 'user:bo' });
  // Another replica purged and published the name again; this one has not followed yet.
  const view = registry.view.bind(registry);
  registry.view = (name) => (name === 'survey' ? stale : view(name));
  const reply = await call('POST', '/api/apps/survey/remove');
  assert.deepEqual([reply.status, /belongs to a later app/.test(reply.body.error)], [409, true]);
  assert.equal(view(appName('survey'))?.status, 'registered');
});

test('AC-EPH-2 POST /api/apps/<name>/discard on a durable app answers 409', async (t) => {
  const { call, server, registry } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  assert.equal((await call('POST', '/api/apps/survey/discard')).status, 409);
  assert.equal(registry.view(appName('survey'))?.status, 'registered');
});

test('AC-EPH-1 the publish audit row records the ephemeral marker of the release body', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/trial/release', { ...kvApp, ephemeral: { ttl_seconds: 60 } });
  assert.deepEqual((await audit(store, 'trial')).map((r) => r.details.ephemeral), [{ ttl_seconds: 60 }, { ttl_seconds: 60 }]);
});

test('AC-EPH-2 hosted discard needs no confirmation body', async (t) => {
  const { server, base, registry } = await hostedAdmin();
  t.after(() => server.close());
  const name = appName('scratch');
  await registry.publish({ name, image: 'example:1', manifest: parseManifest(kvApp.manifest), bundle: null, owner: subject('user:ana'), ephemeral: { ttlSeconds: null } });
  const response = await hostedFetch(base + `/api/apps/${name}/discard`, { method: 'POST', headers: { host: 'control.test', origin: 'https://control.test', 'x-pneuma-space-csrf': 'csrf' } });
  assert.deepEqual([response.status, registry.view(name)], [200, null]);
});

const managedApp = { ...kvApp, manager: { name: 'deployer', url: 'https://deploy.test/survey' } };

test('AC-MGR-1 the listing and the detail carry the manager, null for an unmanaged app, and the publish audit row the manager it sets', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', managedApp);
  await call('PUT', '/api/apps/site/release', kvApp);
  assert.deepEqual((await call('GET', '/api/apps')).body.map((a: { name: string; manager: unknown }) => [a.name, a.manager]), [['site', null], ['survey', managedApp.manager]]);
  assert.deepEqual((await call('GET', '/api/apps/survey')).body.app.manager, managedApp.manager);
  assert.deepEqual((await audit(store, 'survey')).map((r) => r.details.manager), [managedApp.manager, managedApp.manager]);
});

test('AC-MGR-2 a write to a managed app answers 409 naming the manager unless X-Pneuma-Space-Manager names it; the audit rows of the named one carry it', async (t) => {
  const { base, call, server, store } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', managedApp);
  const remove = async (headers: Record<string, string>) => {
    const response = await fetch(`${base}/api/apps/survey/remove`, { method: 'POST', headers });
    return { status: response.status, body: await response.json() };
  };
  const refused = await remove({});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /managed by deployer \(https:\/\/deploy\.test\/survey\); acting here goes around it/);
  assert.equal((await remove({ 'x-pneuma-space-manager': 'other' })).status, 409);
  assert.equal((await remove({ 'x-pneuma-space-manager': 'deployer' })).status, 200);
  const rows = (await audit(store, 'survey')).filter((r) => r.action === 'app.remove');
  assert.deepEqual(rows.map((r) => [r.actor, r.result, r.details.namedManager]), [
    ['local', 'started', undefined], ['local', 'refused', undefined], ['local', 'started', 'other'], ['local', 'refused', 'other'], ['local', 'started', 'deployer'], ['local', 'ok', 'deployer'],
  ]);
});

test('AC-MGR-3 DELETE /api/apps/<name>/manager clears the manager when it names it, audited as app.manager', async (t) => {
  const { base, call, server, store } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', managedApp);
  const clear = (headers: Record<string, string>) => fetch(`${base}/api/apps/survey/manager`, { method: 'DELETE', headers }).then((r) => r.status);
  assert.deepEqual([await clear({}), await clear({ 'x-pneuma-space-manager': 'deployer' })], [409, 200]);
  assert.equal((await call('GET', '/api/apps/survey')).body.app.manager, null);
  assert.deepEqual((await audit(store, 'survey')).filter((r) => r.action === 'app.manager').map((r) => r.result), ['started', 'refused', 'started', 'ok']);
});

test('ADR 0039 a manager url is stored as the URL parser writes it, and one with a control character answers 400', async (t) => {
  const { call, server } = await admin();
  t.after(() => server.close());
  assert.equal((await call('PUT', '/api/apps/survey/release', { ...kvApp, manager: { name: 'deployer', url: 'https://deploy.test/\u0000x' } })).status, 400);
  assert.equal((await call('PUT', '/api/apps/survey/release', { ...kvApp, manager: { name: 'deployer', url: ' HTTPS://Deploy.test/x' } })).status, 200);
  assert.deepEqual((await call('GET', '/api/apps/survey')).body.app.manager, { name: 'deployer', url: 'https://deploy.test/x' });
});

test('a NUL in a tenant display name, a token label, a path segment or a query answers 400 and stores nothing, since PostgreSQL TEXT takes none', async (t) => {
  const { call, server, store } = await admin();
  t.after(() => server.close());
  const refused = [
    await call('POST', '/api/tenants', { name: 'blue', display: 'B\u0000lue', admins: ['ann'] }),
    await call('POST', '/api/tenants/default/tokens', { kind: 'service', name: 'ci', label: 'c\u0000i' }),
    await call('POST', '/api/tenants', { name: 'gr\u0000een', admins: ['ann'] }),
    await call('PUT', '/api/tenants/default/members/a%00n', { role: 'member' }),
    await call('GET', '/api/audit?actor=a%00n'),
  ];
  assert.deepEqual(refused.map((r) => [r.status, r.body.error]), Array(5).fill([400, 'the NUL character is not accepted in a request']));
  assert.deepEqual([(await store.tenants()).map((x) => x.name), await store.tokens(DEFAULT_TENANT)], [[DEFAULT_TENANT], []]);
});

test('ADR 0039 a manager outside the name grammar, a url that is not absolute http or https, or a malformed header answers 400', async (t) => {
  const { base, call, server } = await admin();
  t.after(() => server.close());
  for (const manager of [{ name: 'Deployer' }, { name: 'deployer', url: 'javascript:alert(1)' }, { name: 'deployer', url: '/relative' }, 'deployer']) {
    assert.equal((await call('PUT', '/api/apps/survey/release', { ...kvApp, manager })).status, 400, JSON.stringify(manager));
  }
  await call('PUT', '/api/apps/survey/release', managedApp);
  assert.equal((await fetch(`${base}/api/apps/survey/remove`, { method: 'POST', headers: { 'x-pneuma-space-manager': 'Deployer' } })).status, 400);
});

test('ADR 0039 a malformed manager header answers 400 on an unmanaged app too, and the app is not removed', async (t) => {
  const { base, call, server, registry } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  const remove = await fetch(`${base}/api/apps/survey/remove`, { method: 'POST', headers: { 'x-pneuma-space-manager': 'Deployer' } });
  assert.deepEqual([remove.status, registry.view(appName('survey'))?.status], [400, 'registered']);
});

test('ADR 0039 a manager header given twice answers 400 saying it names one manager', async (t) => {
  const { base, call, server } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', managedApp);
  // Two header lines; fetch would join them before sending.
  const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(`${base}/api/apps/survey/remove`, { method: 'POST', headers: { 'x-pneuma-space-manager': ['deployer', 'deployer'] } }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk)).on('end', () => resolve({ status: response.statusCode!, body }));
    });
    request.on('error', reject).end();
  });
  assert.equal(reply.status, 400);
  assert.match(JSON.parse(reply.body).error, /names one manager, got "deployer, deployer"/);
});

test('ADR 0040 item 3: a write to a replica not on the current build answers 503 with Retry-After, changes nothing and writes no audit row', async (t) => {
  let current = true;
  const { base, call, server, registry, store } = await admin({ overrides: { current: async () => current } });
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  current = false;
  const remove = await fetch(`${base}/api/apps/survey/remove`, { method: 'POST' });
  assert.deepEqual([remove.status, remove.headers.get('retry-after'), (await remove.json()).error], [503, '2', 'the platform is upgrading; retry in a few seconds']);
  assert.deepEqual([registry.view(appName('survey'))?.status, (await audit(store, 'survey')).map((r) => r.action)], ['registered', ['app.publish', 'app.publish']]);
});

test('ADR 0040 item 3: a read from a replica not on the current build answers as usual', async (t) => {
  const { call, server } = await admin({ overrides: { current: async () => false } });
  t.after(() => server.close());
  assert.equal((await call('GET', '/api/apps')).status, 200);
});

/** The headers a browser adds to a request from a page, which a program does not send. */
const fromPage = (origin: string, site: string) => ({ origin, 'sec-fetch-site': site });

test('ADR 0048 under local a write marked as coming from another site or origin answers 403 before routing and changes nothing', async (t) => {
  const { base, call, server, registry, store } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  const host = new URL(base).host;
  const refused = [
    fromPage('http://evil.test', 'cross-site'), fromPage(`http://127.0.0.1:18080`, 'same-site'), { origin: 'http://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' },
  ];
  for (const headers of refused) {
    const reply = await hostedFetch(`${base}/api/apps/survey/remove`, { method: 'POST', headers: { host, 'content-type': 'text/plain', ...headers } });
    assert.equal(reply.status, 403, JSON.stringify(headers));
  }
  assert.deepEqual([registry.view(appName('survey'))?.status, (await audit(store, 'survey')).map((r) => r.action)], ['registered', ['app.publish', 'app.publish']]);
});

test('ADR 0048 under local the console\'s own same-origin write and a program\'s write without browser headers both pass', async (t) => {
  const { base, call, server, registry } = await admin();
  t.after(() => server.close());
  await call('PUT', '/api/apps/survey/release', kvApp);
  const host = new URL(base).host;
  assert.equal((await hostedFetch(`${base}/api/apps/survey/stop`, { method: 'POST', headers: { host, ...fromPage(`http://${host}`, 'same-origin') } })).status, 200);
  assert.equal((await hostedFetch(`${base}/api/apps/survey/remove`, { method: 'POST', headers: { host: 'gateway:8081' } })).status, 200);
  assert.equal(registry.view(appName('survey'))?.status, 'removed');
});

test('ADR 0048 under local a request under a name a page could point at the port answers 403, reads included; a single-label name passes only without browser headers', async (t) => {
  const { base, server } = await admin();
  t.after(() => server.close());
  const get = async (host: string, headers: Record<string, string> = {}) => (await hostedFetch(`${base}/api/apps`, { headers: { host, ...headers } })).status;
  assert.deepEqual(
    [await get('evil.test:8081'), await get('host.docker.internal:8081'), await get('gateway:8081', fromPage('http://gateway:8081', 'same-origin'))],
    [403, 403, 403],
  );
  assert.deepEqual([await get('localhost:8081'), await get('[::1]:8081'), await get('172.18.0.4:8081'), await get('gateway:8081')], [200, 200, 200, 200]);
  const write = await hostedFetch(`${base}/api/apps/survey/stop`, { method: 'POST', headers: { host: 'evil.test:8081', ...fromPage('http://evil.test:8081', 'same-origin') } });
  assert.equal(write.status, 403);
  assert.match((write.json() as { error: string }).error, /not to "evil\.test"/);
});

test('ADR 0048 PNEUMA_SPACE_ADMIN_HOSTS adds names a browser may call the admin API by', async (t) => {
  const { base, server } = await admin({ overrides: { adminHosts: ['Space.Internal'] } });
  t.after(() => server.close());
  const reply = await hostedFetch(`${base}/api/apps`, { headers: { host: 'space.internal:8081', ...fromPage('http://space.internal:8081', 'same-origin') } });
  assert.equal(reply.status, 200);
});
