import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sha256 } from '../core/crypto.ts';
import { DEFAULT_LIMITS, type Artifact, type ArtifactStore, type Invocation } from '../core/model.ts';
import { FetchRuntime } from '../core/runtime.ts';
import { LocalExecutionHost } from '../adapters/local/execution.ts';
import { LocalSqliteDatabase } from '../adapters/local/sqlite.ts';
import { SqlRecordsResource } from '../core/records.ts';

const manifest: Artifact['manifest'] = {
  contract: 2, runtime: 'fetch', abi: 'pneuma-space.fetch/1', entry: 'app.mjs', capabilities: { records: {}, identity: {} },
};

async function workers(resourcePersistencePath?: string) {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/execution-worker.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false,
  });
  const script = bundled.outputFiles[0].text;
  return new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath, workers: [{
    name: 'pneuma-space-execution-test', modules: true, script, compatibilityDate: '2026-11-11',
    workerLoaders: { PNEUMA_SPACE_LOADER: {} },
    durableObjects: { PNEUMA_SPACE_DATA: { className: 'RecordsDO', useSQLite: true } },
    r2Buckets: ['PNEUMA_SPACE_ARTIFACTS'],
  }] }));
}

async function install(mf: Miniflare, id: string, source: string, capabilities = manifest.capabilities) {
  const artifact: Artifact = { manifest: { ...manifest, capabilities }, source, assets: [] };
  const response = await mf.dispatchFetch(`http://localhost/install/${id}`, {
    method: 'POST', body: JSON.stringify({ artifact, digest: await sha256(source), bytes: source.length }),
  });
  assert.equal(response.status, 204, await response.text());
}

test('AC-C-18 workerd denies fetch, raw sockets and platform bindings', async () => {
  const mf = await workers();
  try {
    await install(mf, 'network', `import { connect } from 'cloudflare:sockets';
      import { env } from 'cloudflare:workers';
      export default { async fetch(request, app) {
        let http = false, tcp = false;
        try { await fetch('https://example.com'); http = true; } catch {}
        try { const socket = connect('example.com:443'); await socket.opened; tcp = true; } catch {}
        return Response.json({ http, tcp, bindings: Object.keys(env), appKeys: Object.keys(app).sort() });
      } };`);
    const response = await mf.dispatchFetch('http://localhost/app/network');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { http: false, tcp: false, bindings: [], appKeys: ['id', 'identity', 'name', 'records', 'release'] });
  } finally { await mf.dispose(); }
});

test('AC-C-20 workerd uses fresh context and rejects retained records capabilities', async () => {
  const mf = await workers();
  try {
    await install(mf, 'fresh', `let previous;
      export default { async fetch(request, app) {
        let retained = 'none';
        if (previous) { try { await previous.get('value'); retained = 'allowed'; } catch { retained = 'rejected'; } }
        previous = app.records;
        return Response.json({ name: app.identity.name, retained, current: await app.records.get('value') });
      } };`);
    const first = await mf.dispatchFetch('http://localhost/app/fresh', { headers: { 'X-Test-Identity': 'first' } });
    assert.deepEqual(await first.json(), { name: 'first', retained: 'none', current: null });
    const second = await mf.dispatchFetch('http://localhost/app/fresh', { headers: { 'X-Test-Identity': 'second' } });
    assert.deepEqual(await second.json(), { name: 'second', retained: 'rejected', current: null });
  } finally { await mf.dispose(); }
});

test('AC-C-20 identical source apps have distinct workerd module state', async () => {
  const mf = await workers();
  try {
    const source = `let count = 0; export default { fetch() { return Response.json({ count: ++count }); } };`;
    await install(mf, 'app-a', source);
    await install(mf, 'app-b', source);
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/app/app-a')).json(), { count: 1 });
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/app/app-b')).json(), { count: 1 });
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/app/app-a')).json(), { count: 2 });
  } finally { await mf.dispose(); }
});

test('AC-C-19 input limit refuses work before workerd invocation', async () => {
  const mf = await workers();
  try {
    await install(mf, 'request', `let count = 0; export default { fetch() { return Response.json({ count: ++count }); } };`);
    const excess = await mf.dispatchFetch('http://localhost/app/request?requestBytes=3', { method: 'POST', body: 'four' });
    assert.equal(excess.status, 413);
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/app/request')).json(), { count: 1 });
  } finally { await mf.dispose(); }
});

test('AC-C-19 output limit stops excess response bytes', async () => {
  const mf = await workers();
  try {
    await install(mf, 'response', `export default { fetch() { return new Response('four'); } };`);
    assert.equal((await mf.dispatchFetch('http://localhost/app/response?responseBytes=3')).status, 413);
  } finally { await mf.dispose(); }
});

test('AC-C-19 deadline includes consumption of a stalled response body', async () => {
  const mf = await workers();
  try {
    await install(mf, 'deadline', `export default { fetch() { return new Response(new ReadableStream({
      async pull(controller) { await new Promise(resolve => setTimeout(resolve, 100)); controller.enqueue(new Uint8Array([1])); }
    })); } };`);
    const response = await mf.dispatchFetch('http://localhost/app/deadline?deadlineMs=30');
    assert.equal(response.status, 504, await response.text());
  } finally { await mf.dispose(); }
});

test('AC-C-19 records operations stop at the invocation budget', async () => {
  const mf = await workers();
  try {
    await install(mf, 'operations', `export default { async fetch(request, app) {
      await app.records.get('a'); await app.records.get('b');
      try { await app.records.commit([{kind:'put', key:'c', expected:null, value:'too-many'}]); }
      catch { return new Response('limited'); }
      return new Response('allowed');
    } };`);
    const response = await mf.dispatchFetch('http://localhost/app/operations?recordOperations=2');
    assert.equal(await response.text(), 'limited');
    const status = await (await mf.dispatchFetch('http://localhost/status/operations')).json() as { count: number };
    assert.equal(status.count, 0);
  } finally { await mf.dispose(); }
});

test('AC-C-14 workerd records survive remove and resume', async () => {
  const mf = await workers();
  try {
    await install(mf, 'persist', `export default { async fetch(request, app) {
      const current = await app.records.get('count');
      if (request.method === 'POST') await app.records.commit([{kind:'put', key:'count', expected:current?.revision ?? null, value:7}]);
      return Response.json(await app.records.get('count'));
    } };`);
    const stored = await (await mf.dispatchFetch('http://localhost/app/persist', { method: 'POST' })).json();
    assert.deepEqual(stored, { key: 'count', value: 7, revision: '1' });
    await mf.dispatchFetch('http://localhost/suspend/persist');
    assert.equal((await mf.dispatchFetch('http://localhost/app/persist')).status, 403);
    await mf.dispatchFetch('http://localhost/resume/persist');
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/app/persist')).json(), stored);
  } finally { await mf.dispose(); }
});

test('AC-C-14 records survive replacement of the Workers engine', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-workerd-state-'));
  let mf = await workers(directory);
  try {
    await install(mf, 'eviction', `let calls = 0; export default { async fetch(request, app) {
      const before = await app.records.get('saved');
      if (!before) await app.records.commit([{kind:'put', key:'saved', expected:null, value:42}]);
      return Response.json({calls: ++calls, saved: await app.records.get('saved')});
    } };`);
    const expected = { key: 'saved', value: 42, revision: '1' };
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/app/eviction')).json(), { calls: 1, saved: expected });
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/app/eviction')).json(), { calls: 2, saved: expected });
    await mf.dispose();
    mf = await workers(directory);
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/app/eviction')).json(), { calls: 1, saved: expected });
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('AC-C-23 module preparation requires Fetch ABI without invoking app fetch', async () => {
  const mf = await workers();
  try {
    await install(mf, 'prepare', `export default { fetch() { throw new Error('must not run during preparation'); } };`);
    const artifact = { manifest, source: 'export default {};', assets: [] };
    const response = await mf.dispatchFetch('http://localhost/install/invalid', {
      method: 'POST', body: JSON.stringify({ artifact, digest: await sha256(artifact.source), bytes: artifact.source.length }),
    });
    assert.equal(response.status, 400);
  } finally { await mf.dispose(); }
});

test('AC-C-16 trusted local adapter runs the same Fetch module against SQLite records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-execution-'));
  const db = new LocalSqliteDatabase(join(directory, 'records.sqlite'));
  try {
    const artifact: Artifact = { manifest, assets: [], source: `export default { async fetch(request, app) {
      return Response.json({ identity: app.identity.name, value: await app.records.get('saved') });
    } };` };
    const digest = await sha256(artifact.source);
    const invocation: Invocation = {
      appId: 'local-app' as Invocation['appId'], name: 'local' as Invocation['name'],
      release: { number: 1, digest, bytes: artifact.source.length, manifest, createdAt: 0 },
      identity: { subject: 'user:local', owner: 'user:local', name: 'Local' },
      expiresAt: Date.now() + 1000, records: { epoch: 1, expiresAt: Date.now() + 1000 },
    };
    const resource = new SqlRecordsResource(db, DEFAULT_LIMITS.records);
    await resource.restore({ format: 1, revision: 3, records: [{ key: 'saved', value: { n: 5 }, revision: '3' }] }, 'restore');
    await resource.transition('active', 1);
    const artifacts: ArtifactStore = { async put() {}, async get() { return artifact; }, async destroy() {} };
    const host = new LocalExecutionHost();
    await host.prepare(invocation.appId, { artifact, digest, bytes: artifact.source.length });
    const runtime = new FetchRuntime({ host, artifacts, resources: { records: () => resource }, limits: DEFAULT_LIMITS });
    const acquired = runtime.acquire(invocation);
    assert.deepEqual(await (await acquired.fetch(new Request('https://local.invalid/'))).json(), {
      identity: 'Local', value: { key: 'saved', value: { n: 5 }, revision: '3' },
    });
    await assert.rejects(acquired.fetch(new Request('https://local.invalid/')), /only once/);
  } finally { db.close(); await rm(directory, { recursive: true }); }
});
