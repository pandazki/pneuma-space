import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { startAdmin } from './admin.ts';
import { EventLog } from './events.ts';
import { Metrics } from './metrics.ts';
import { appName, parseManifest, subject } from './model.ts';
import { world } from './registry.fakes.ts';

async function admin() {
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
  });
  const server = await startAdmin({ registry, bundles: w.bundles, runtime: w.runtime, metrics }, { port: 0 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(base + path, { method, body: raw });
    return { status: response.status, body: await response.json() };
  };
  return { w, registry, store, server, call, base, metrics };
}

const kvApp = { image: 'example:1', manifest: { contract: 1, capabilities: { kv: {} } }, owner: 'user:ann' };

test('every contract endpoint answers 200 on valid input', async (t) => {
  const { call, server } = await admin();
  t.after(() => server.close());
  assert.deepEqual(await call('GET', '/api/health'), { status: 200, body: { ok: true } });

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
  const token = await call('POST', '/api/tokens', { name: 'ci' });
  assert.deepEqual([token.status, token.body.subject, typeof token.body.token], [200, 'service:ci', 'string']);
  assert.equal((await call('POST', '/api/apps/survey/remove')).status, 200);
  assert.equal((await call('POST', '/api/apps/survey/purge')).status, 200);
  assert.equal((await call('GET', '/api/apps/survey')).status, 404);
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

test('GET /api/apps lists 500 apps in under 100 ms without a Docker call', async (t) => {
  const { call, server, registry, w } = await admin();
  t.after(() => server.close());
  const manifest = parseManifest({ contract: 1, capabilities: { kv: {}, files: {} } });
  for (let i = 0; i < 500; i++) {
    await registry.publish({ name: appName(`app-${i}`), image: 'example:1', manifest, bundle: null, owner: subject('user:ann') });
  }
  w.runtime.calls.length = 0;
  const started = performance.now();
  const listed = await call('GET', '/api/apps');
  const elapsed = performance.now() - started;
  console.log(`GET /api/apps with ${listed.body.length} apps: ${elapsed.toFixed(1)} ms`);
  assert.equal(listed.body.length, 500);
  assert.ok(elapsed < 100, `${elapsed} ms`);
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
