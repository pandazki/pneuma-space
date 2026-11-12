import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { PersonalAccount } from '../core/model.ts';

const control = 'https://space.deepaste.ai';
const appsDomain = 'apps.pneuma-test.net';
type Login = { account: PersonalAccount; credential: string; csrf: string };
type Token = { token: string; metadata: { id: string } };

async function workers(resourcePersistencePath?: string) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/cloudflare-worker.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
  return new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath, workers: [{
    name: 'pneuma-space-cloud-test', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-11-11',
    bindings: {
      PNEUMA_SPACE_CONTROL_ORIGIN: control, PNEUMA_SPACE_APPS_DOMAIN: appsDomain,
      PNEUMA_SPACE_GITHUB_CLIENT_ID: 'local-test-id', PNEUMA_SPACE_GITHUB_CLIENT_SECRET: 'local-test-secret',
      PNEUMA_SPACE_SESSION_KEY: 'local-test-handshake-key-with-32-characters', PNEUMA_SPACE_ENABLED: 'true',
    },
    workerLoaders: { PNEUMA_SPACE_LOADER: {} }, r2Buckets: ['PNEUMA_SPACE_ARTIFACTS'],
    durableObjects: {
      PNEUMA_SPACE_ACCOUNTS: { className: 'AccountsObject', useSQLite: true },
      PNEUMA_SPACE_CAPACITY: { className: 'CapacityObject', useSQLite: true },
      PNEUMA_SPACE_TENANTS: { className: 'TenantObject', useSQLite: true },
      PNEUMA_SPACE_RECORDS: { className: 'RecordsObject', useSQLite: true },
      PNEUMA_SPACE_ARTIFACT_INDEX: { className: 'ArtifactIndexObject', useSQLite: true },
      PNEUMA_SPACE_TEST_GATE: { className: 'ArtifactGate', useSQLite: true },
    },
  }] }));
}

async function login(mf: Miniflare, name: string): Promise<Login> {
  const response = await mf.dispatchFetch(control + '/__test/register?name=' + name);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as Login;
}

function browserHeaders(user: Login): Record<string, string> {
  return { cookie: '__Host-pneuma-space-control=' + user.credential, origin: control, 'x-pneuma-space-csrf': user.csrf, 'content-type': 'application/json' };
}

async function token(mf: Miniflare, user: Login): Promise<Token> {
  const response = await mf.dispatchFetch(control + '/api/tokens', { method: 'POST', headers: browserHeaders(user), body: JSON.stringify({
    label: 'development', scopes: ['read', 'publish', 'invoke', 'remove', 'export'], appIds: null, expiresAt: Date.now() + 86_400_000,
  }) });
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json() as Token;
}

function artifact(source = `export default { async fetch(request, app) {
  if (request.method === 'POST') {
    const before = await app.records.get('saved');
    await app.records.commit([{kind:'put',key:'saved',expected:before?.revision ?? null,value:42}]);
  }
  return Response.json({saved:await app.records.get('saved'), release:app.release});
} };`) {
  return { manifest: { contract: 2, runtime: 'fetch', abi: 'pneuma-space.fetch/1', entry: 'app.mjs', capabilities: { records: {}, identity: {}, static: { dir: 'public' } } },
    source, assets: [{ path: 'private.txt', contentType: 'text/plain', body: btoa('private static bytes') }] };
}

async function publish(mf: Miniflare, credential: Token, name: string, body = artifact(), key = crypto.randomUUID()) {
  const response = await mf.dispatchFetch(control + `/api/apps/${name}/release`, { method: 'PUT',
    headers: { authorization: 'Bearer ' + credential.token, 'idempotency-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { number: number };
}

function appUrl(user: Login, name = 'counter', path = '/') { return `https://${name}--${user.account.tenant}.${appsDomain}${path}`; }

async function appLogin(mf: Miniflare, user: Login) {
  const first = await mf.dispatchFetch(appUrl(user, 'counter', '/?view=saved'), { headers: { 'x-test-navigation': 'true' }, redirect: 'manual' });
  assert.equal(first.status, 303, await first.clone().text());
  const nonce = first.headers.getSetCookie()[0].split(';')[0];
  const authorized = await mf.dispatchFetch(first.headers.get('location')!, { headers: browserHeaders(user), redirect: 'manual' });
  assert.equal(authorized.status, 303, await authorized.clone().text());
  const callbackUrl = authorized.headers.get('location')!;
  const callback = await mf.dispatchFetch(callbackUrl, { headers: { cookie: nonce }, redirect: 'manual' });
  assert.equal(callback.status, 303, await callback.clone().text());
  assert.equal(callback.headers.get('location'), appUrl(user, 'counter', '/?view=saved'));
  return { cookie: callback.headers.getSetCookie().find(value => value.startsWith('__Host-pneuma-space-app='))!.split(';')[0], callbackUrl, nonce };
}

test('AC-C-1 real Workers concurrent registration returns one personal account', async () => {
  const mf = await workers();
  try {
    const users = await Promise.all(Array.from({ length: 20 }, () => login(mf, 'alice')));
    assert.equal(new Set(users.map(user => user.account.tenant)).size, 1);
    assert.equal(new Set(users.map(user => user.account.userId)).size, 1);
  } finally { await mf.dispose(); }
});

test('AC-C-5 real Workers deny another account before dynamic or static bytes', async () => {
  const mf = await workers();
  try {
    const alice = await login(mf, 'alice');
    const bob = await login(mf, 'bob');
    const aliceToken = await token(mf, alice);
    const bobToken = await token(mf, bob);
    await publish(mf, aliceToken, 'counter');
    const listed = await mf.dispatchFetch(control + '/api/apps', { headers: browserHeaders(bob) });
    assert.deepEqual(await listed.json(), []);
    for (const path of ['/', '/private.txt']) {
      const denied = await mf.dispatchFetch(appUrl(alice, 'counter', path), { headers: { authorization: 'Bearer ' + bobToken.token } });
      assert.equal(denied.status, 404, await denied.text());
    }
    const allowed = await mf.dispatchFetch(appUrl(alice, 'counter', '/private.txt'), { headers: { authorization: 'Bearer ' + aliceToken.token } });
    assert.equal(await allowed.text(), 'private static bytes');
    const read = await mf.dispatchFetch(appUrl(alice), { headers: { authorization: 'Bearer ' + aliceToken.token } });
    assert.deepEqual(await read.json(), { saved: null, release: 1 });
  } finally { await mf.dispose(); }
});

test('AC-C-3 real Workers reject the next admission after token revocation', async () => {
  const mf = await workers();
  try {
    const user = await login(mf, 'alice');
    const credential = await token(mf, user);
    await publish(mf, credential, 'counter');
    const revoke = await mf.dispatchFetch(control + `/api/tokens/${credential.metadata.id}/revoke`, { method: 'POST', headers: browserHeaders(user), body: '{}' });
    assert.equal(revoke.status, 200, await revoke.text());
    const denied = await mf.dispatchFetch(appUrl(user), { headers: { authorization: 'Bearer ' + credential.token } });
    assert.equal(denied.status, 403, await denied.text());
  } finally { await mf.dispose(); }
});

test('AC-C-14 full Cloudflare adapter preserves records across republish and engine restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-cloud-'));
  let mf = await workers(directory);
  try {
    const user = await login(mf, 'alice');
    const credential = await token(mf, user);
    await publish(mf, credential, 'counter');
    const headers = { authorization: 'Bearer ' + credential.token };
    const saved = await mf.dispatchFetch(appUrl(user), { method: 'POST', headers });
    assert.deepEqual(await saved.json(), { saved: { key: 'saved', value: 42, revision: '1' }, release: 1 });
    const removed = await mf.dispatchFetch(control + '/api/apps/counter/remove', { method: 'POST', headers: browserHeaders(user), body: '{}' });
    assert.equal(removed.status, 200, await removed.text());
    assert.equal((await mf.dispatchFetch(appUrl(user), { headers })).status, 404);
    const next = artifact(artifact().source + '\n');
    await publish(mf, credential, 'counter', next);
    await mf.dispose();
    mf = await workers(directory);
    const restored = await mf.dispatchFetch(appUrl(user), { headers });
    assert.deepEqual(await restored.json(), { saved: { key: 'saved', value: 42, revision: '1' }, release: 2 });
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('AC-C-6 real Workers require exact browser Origin and CSRF before token creation', async () => {
  const mf = await workers();
  try {
    const user = await login(mf, 'alice');
    const headers = browserHeaders(user);
    headers.origin = 'https://attacker.pneuma-test.net';
    const response = await mf.dispatchFetch(control + '/api/tokens', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403, await response.text());
    const listed = await mf.dispatchFetch(control + '/api/tokens', { headers: browserHeaders(user) });
    assert.deepEqual(await listed.json(), []);
  } finally { await mf.dispose(); }
});

test('AC-C-7 real Workers consume an app login grant only once', async () => {
  const mf = await workers();
  try {
    const user = await login(mf, 'alice');
    await publish(mf, await token(mf, user), 'counter');
    const session = await appLogin(mf, user);
    const invoked = await mf.dispatchFetch(appUrl(user), { headers: { cookie: session.cookie } });
    assert.deepEqual(await invoked.json(), { saved: null, release: 1 });
    const replay = await mf.dispatchFetch(session.callbackUrl, { headers: { cookie: session.nonce }, redirect: 'manual' });
    assert.equal(replay.status, 403, await replay.text());
  } finally { await mf.dispose(); }
});

test('AC-C-6 real Workers invalidate derived app sessions after parent logout', async () => {
  const mf = await workers();
  try {
    const user = await login(mf, 'alice');
    await publish(mf, await token(mf, user), 'counter');
    const session = await appLogin(mf, user);
    const logout = await mf.dispatchFetch(control + '/auth/logout', { method: 'POST', headers: browserHeaders(user) });
    assert.equal(logout.status, 204, await logout.text());
    const denied = await mf.dispatchFetch(appUrl(user), { headers: { cookie: session.cookie } });
    assert.equal(denied.status, 401, await denied.text());
  } finally { await mf.dispose(); }
});

test('AC-C-15 real Cloudflare adapters retain purge fences against delayed effects', async () => {
  const mf = await workers();
  try {
    const user = await login(mf, 'alice');
    const credential = await token(mf, user);
    await publish(mf, credential, 'counter');
    const detail = await mf.dispatchFetch(control + '/api/apps/counter', { headers: browserHeaders(user) });
    const app = await detail.json() as { id: string };
    const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS');
    for (let offset = 0; offset < 1001; offset += 25) {
      await Promise.all(Array.from({ length: Math.min(25, 1001 - offset) }, (_, index) => bucket.put(`apps/${app.id}/orphan-${offset + index}`, 'retained')));
    }
    const removed = await mf.dispatchFetch(control + '/api/apps/counter/remove', { method: 'POST', headers: browserHeaders(user), body: '{}' });
    assert.equal(removed.status, 200, await removed.text());
    const purged = await mf.dispatchFetch(control + '/api/apps/counter/purge', { method: 'POST', headers: browserHeaders(user), body: JSON.stringify({ confirm: 'counter' }) });
    assert.equal(purged.status, 200, await purged.text());
    const page = await bucket.list({ prefix: `apps/${app.id}/`, limit: 1000 });
    assert.ok(page.truncated);
    assert.ok(page.objects.every(object => object.size === 0));
    assert.ok((await bucket.list({ prefix: `apps/${app.id}/`, cursor: page.cursor })).objects.every(object => object.size === 0));
    assert.ok(await bucket.head(`purged/${app.id}`));
    const lateArtifact = await mf.dispatchFetch(control + '/__test/late-artifact?appId=' + app.id, { method: 'POST', body: JSON.stringify(artifact()) });
    assert.equal(lateArtifact.status, 409, await lateArtifact.text());
    const lateResume = await mf.dispatchFetch(control + '/__test/late-resume?appId=' + app.id, { method: 'POST' });
    assert.equal(lateResume.status, 409, await lateResume.text());
    assert.ok((await bucket.list({ prefix: `apps/${app.id}/` })).objects.every(object => object.size === 0));
  } finally { await mf.dispose(); }
});

test('AC-C-15 purge tombstones defeat an artifact put reserved before purge', async () => {
  const mf = await workers();
  try {
    const user = await login(mf, 'alice');
    await publish(mf, await token(mf, user), 'counter');
    const detail = await mf.dispatchFetch(control + '/api/apps/counter', { headers: browserHeaders(user) });
    const app = await detail.json() as { id: string };
    const pending = mf.dispatchFetch(control + '/__test/race-put?appId=' + app.id, { method: 'POST', body: JSON.stringify(artifact(artifact().source + '\n')) });
    assert.equal((await mf.dispatchFetch(control + '/__test/race-ready')).status, 204);
    const removed = await mf.dispatchFetch(control + '/api/apps/counter/remove', { method: 'POST', headers: browserHeaders(user), body: '{}' });
    assert.equal(removed.status, 200, await removed.text());
    const purged = await mf.dispatchFetch(control + '/api/apps/counter/purge', { method: 'POST', headers: browserHeaders(user), body: JSON.stringify({ confirm: 'counter' }) });
    assert.equal(purged.status, 200, await purged.text());
    await mf.dispatchFetch(control + '/__test/race-release');
    const delayed = await pending;
    assert.equal(delayed.status, 404, await delayed.text());
    const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS');
    const objects = await bucket.list({ prefix: `apps/${app.id}/` });
    assert.equal(objects.objects.length, 2);
    assert.ok(objects.objects.every(object => object.size === 0));
  } finally { await mf.dispose(); }
});

test('AC-C-15 purge retry finishes partial artifact tombstones after an engine restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-purge-'));
  let mf = await workers(directory);
  try {
    const user = await login(mf, 'alice');
    const credential = await token(mf, user);
    await publish(mf, credential, 'counter');
    await publish(mf, credential, 'counter', artifact(artifact().source + '\n'));
    const detail = await mf.dispatchFetch(control + '/api/apps/counter', { headers: browserHeaders(user) });
    const app = await detail.json() as { id: string };
    const removed = await mf.dispatchFetch(control + '/api/apps/counter/remove', { method: 'POST', headers: browserHeaders(user), body: '{}' });
    assert.equal(removed.status, 200, await removed.text());
    assert.equal((await mf.dispatchFetch(control + '/__test/partial-purge?appId=' + app.id)).status, 204);
    const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS');
    assert.ok((await bucket.list({ prefix: `apps/${app.id}/` })).objects.some(object => object.size > 0));
    await mf.dispose();
    mf = await workers(directory);
    const purged = await mf.dispatchFetch(control + '/api/apps/counter/purge', { method: 'POST', headers: browserHeaders(user), body: JSON.stringify({ confirm: 'counter' }) });
    assert.equal(purged.status, 200, await purged.text());
    const reopened = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS');
    assert.ok((await reopened.list({ prefix: `apps/${app.id}/` })).objects.every(object => object.size === 0));
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});
