import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, arch, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const control = 'https://space.deepaste.ai';
const appsDomain = 'apps.pneuma-test.net';
const persistence = await mkdtemp(join(tmpdir(), 'pneuma-space-fetch-bench-'));
const bundled = await build({ entryPoints: [fileURLToPath(new URL('./tests/fixtures/cloudflare-worker.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
const start = () => new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: persistence, workers: [{
  name: 'pneuma-space-fetch-bench', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-11-11',
  bindings: { PNEUMA_SPACE_CONTROL_ORIGIN: control, PNEUMA_SPACE_APPS_DOMAIN: appsDomain, PNEUMA_SPACE_GITHUB_CLIENT_ID: 'bench', PNEUMA_SPACE_GITHUB_CLIENT_SECRET: 'bench', PNEUMA_SPACE_SESSION_KEY: 'local-benchmark-handshake-key-32-characters', PNEUMA_SPACE_ENABLED: 'true' },
  workerLoaders: { PNEUMA_SPACE_LOADER: {} }, r2Buckets: ['PNEUMA_SPACE_ARTIFACTS'],
  durableObjects: {
    PNEUMA_SPACE_ACCOUNTS: { className: 'AccountsObject', useSQLite: true }, PNEUMA_SPACE_CAPACITY: { className: 'CapacityObject', useSQLite: true },
    PNEUMA_SPACE_TENANTS: { className: 'TenantObject', useSQLite: true }, PNEUMA_SPACE_RECORDS: { className: 'RecordsObject', useSQLite: true },
    PNEUMA_SPACE_ARTIFACT_INDEX: { className: 'ArtifactIndexObject', useSQLite: true }, PNEUMA_SPACE_TEST_GATE: { className: 'ArtifactGate', useSQLite: true },
  },
}] }));
const artifact = { manifest: { contract: 2, runtime: 'fetch', abi: 'pneuma-space.fetch/1', entry: 'app.mjs', capabilities: { records: {} } },
  source: `export default { async fetch(request, app) { return Response.json({value: await app.records.get('saved'), release:app.release}); } };`, assets: [] };
const rows: string[] = [];
const at = new Date().toISOString();
const host = `${cpus()[0].model} ${arch()}`;
let mf = start();
try {
  const signup = await mf.dispatchFetch(control + '/__test/register?name=bench');
  assert.equal(signup.status, 200);
  const user = await signup.json() as { credential: string; csrf: string; account: { tenant: string } };
  const created = await mf.dispatchFetch(control + '/api/tokens', { method: 'POST', headers: {
    cookie: '__Host-pneuma-space-control=' + user.credential, origin: control, 'x-pneuma-space-csrf': user.csrf,
  }, body: JSON.stringify({ label: 'bench', scopes: ['publish', 'invoke'], appIds: null, expiresAt: Date.now() + 3600_000 }) });
  assert.equal(created.status, 201);
  const credential = await created.json() as { token: string };
  const headers = { authorization: 'Bearer ' + credential.token };
  const published = await mf.dispatchFetch(control + '/api/apps/bench/release', { method: 'PUT', headers: { ...headers, 'idempotency-key': 'bench-1' }, body: JSON.stringify(artifact) });
  assert.equal(published.status, 200, await published.clone().text());
  const timed = async (metric: string, round: number) => {
    const started = performance.now();
    const response = await mf.dispatchFetch(`https://bench--${user.account.tenant}.${appsDomain}/`, { headers });
    const body = await response.json();
    const duration = performance.now() - started;
    assert.equal(response.status, 200);
    assert.deepEqual(body, { value: null, release: 1 });
    rows.push([at, host, loadavg()[0].toFixed(2), 'fetch-local-workerd', metric, round, duration.toFixed(3), 0].join('\t'));
  };
  await timed('first-after-publish', 1);
  for (let round = 1; round <= 5; round++) {
    for (let request = 0; request < 20; request++) await timed('warm', round);
    await mf.dispose();
    mf = start();
    await timed('after-engine-restart', round);
  }
  const directory = resolve(import.meta.dirname, '../tests/bench/results');
  await mkdir(directory, { recursive: true });
  const path = join(directory, at.slice(0, 10) + '-hosted-fetch.tsv');
  await writeFile(path, 'at\thost\tload1\truntime\tmetric\tround\tresponse_ms\terrors\n' + rows.join('\n') + '\n');
  process.stdout.write(`Recorded ${rows.length} complete responses, zero errors, in ${path}\n`);
} finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
