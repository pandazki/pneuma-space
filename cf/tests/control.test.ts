import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';

let mf: Miniflare;
const origin = 'https://space.test';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Client = { id: string; tenant: string; cookie: string; csrf: string };
type Value = { user: { id: string; platformAdmin: boolean }; tenants: { id: string }[]; csrf: string; accessKey: string; url: string; id: string; token: string; items: { id: string }[] };
let owner: Client;
async function request(path: string, client?: Client, body?: unknown, method = body === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
  return mf.dispatchFetch(origin + '/api/v1' + path, {
    method, headers: { origin, ...(client ? { cookie: client.cookie, 'x-pneuma-space-csrf': client.csrf } : {}), 'content-type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function identity(admin = false): Promise<Client> {
  const id = 'u_' + randomBytes(8).toString('hex'), tenant = 't_' + randomBytes(8).toString('hex'), key = randomBytes(32).toString('hex'), session = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.batch([
    db.prepare('INSERT INTO users(id,username,name,key_hash,platform_admin,created_at) VALUES(?,?,?,?,?,1)').bind(id, id, id, hash(key), Number(admin)),
    db.prepare('INSERT INTO tenants(id,name,created_at) VALUES(?,?,1)').bind(tenant, tenant),
    db.prepare("INSERT INTO memberships(tenant_id,user_id,role) VALUES(?,?,'admin')").bind(tenant, id),
    db.prepare('INSERT INTO sessions(hash,user_id,csrf,created_at,expires_at) VALUES(?,?,?,1,?)').bind(hash(session), id, csrf, Date.now() + 3600000),
  ]);
  return { id, tenant, cookie: '__Host-pneuma-space-control=' + session, csrf };
}
async function invite(): Promise<string> {
  const response = await request('/admin/invitations', owner, {});
  assert.equal(response.status, 201, await response.clone().text());
  return new URL((await response.json() as Value).url).searchParams.get('code')!;
}
async function staticApp(client: Client) {
  const app = await (await request('/tenants/' + client.tenant + '/apps', client, { name: 'static-' + randomBytes(4).toString('hex') })).json() as { id: string; origin: string };
  const manifest = { contract: 'pneuma-space.cf/1', runtime: 'static', entry: 'public/index.html', capabilities: { static: { dir: 'public' } } };
  const contents = 'Private application ' + app.id;
  const bytes = JSON.stringify({ manifest, files: [{ path: 'public/index.html', body: Buffer.from(contents).toString('base64'), contentType: 'text/plain' }] });
  const digest = hash(bytes), key = 'apps/' + app.id + '/artifacts/' + digest + '/package.json';
  const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS') as unknown as R2Bucket;
  await bucket.put(key, bytes);
  await bucket.put('apps/' + app.id + '/artifacts/' + digest + '/static/index.html', contents);
  const namespace = await mf.getDurableObjectNamespace('PNEUMA_SPACE_APPS') as unknown as DurableObjectNamespace;
  const published = await namespace.get(namespace.idFromName(app.id)).fetch('https://cell/publish', {
    method: 'POST', body: JSON.stringify({ actor: { kind: 'session', hash: hash(client.cookie.split('=')[1]), csrf: client.csrf, user: { id: client.id } }, artifact: { manifest, key, digest, bytes: Buffer.byteLength(bytes) }, expectedGeneration: 0, idempotencyKey: 'initial' }),
  });
  assert.equal(published.status, 200, await published.clone().text());
  return { ...app, contents };
}
before(async () => {
  const bundled = await build({ entryPoints: [new URL('../src/worker.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'esnext', external: ['cloudflare:workers'] });
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'control-tests', modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-11-13', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PNEUMA_SPACE_APPS: { className: 'AppCell', useSQLite: true } },
    d1Databases: ['PNEUMA_SPACE_DB'], r2Buckets: ['PNEUMA_SPACE_ARTIFACTS', 'PNEUMA_SPACE_OBJECTS'],
    bindings: { PNEUMA_SPACE_CONTROL_ORIGIN: origin, PNEUMA_SPACE_APPS_DOMAIN: 'apps.test', PNEUMA_SPACE_MAX_ACCOUNTS: '100', PNEUMA_SPACE_R2_ACCESS_KEY_ID: 'test-key', PNEUMA_SPACE_R2_SECRET_ACCESS_KEY: 'test-secret', PNEUMA_SPACE_ACCOUNT_ID: '00000000000000000000000000000000', PNEUMA_SPACE_ARTIFACT_BUCKET: 'artifacts' },
  }));
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.exec((await readFile(new URL('../schema.sql', import.meta.url).pathname, 'utf8')).replace(/\n/g, ' '));
  owner = await identity(true);
});
after(async () => { await mf?.dispose(); });
test('CF-01 invalid keys fail and public signup is absent', async () => {
  assert.equal((await request('/auth/login', undefined, { account: 'unknown', key: 'unknown' })).status, 401);
  assert.equal((await request('/auth/signup', undefined, {})).status, 401);
  assert.equal((await request('/me', owner)).status, 200);
});
test('CF-02 concurrent redemption creates exactly one ordinary account and tenant', async () => {
  const code = await invite();
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => request('/auth/redeem', undefined, { invite: code, username: 'redeem' + i, name: 'Redeemed' })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409, 409]);
  const value = await results.find(r => r.status === 200)!.json() as Value;
  assert.equal(value.user.platformAdmin, false);
  assert.equal(value.tenants.length, 1);
  assert.match(value.accessKey, /^[a-f0-9]{64}$/);
});
test('CF-02 revoked invitation cannot create an account', async () => {
  const response = await request('/admin/invitations', owner, {});
  const value = await response.json() as Value;
  assert.equal((await request('/admin/invitations/' + value.id, owner, undefined, 'DELETE')).status, 204);
  assert.equal((await request('/auth/redeem', undefined, { invite: new URL(value.url).searchParams.get('code'), username: 'revoked', name: 'Revoked' })).status, 409);
});
test('CF-03 tenant cannot access platform APIs or another tenant directory', async () => {
  const a = await identity(), b = await identity();
  assert.equal((await request('/admin/accounts', a)).status, 403);
  assert.equal((await request('/tenants/' + b.tenant + '/apps', a)).status, 403);
  assert.equal((await request('/tenants/' + a.tenant + '/apps', a)).status, 200);
});
test('CF-04 control mutations reject incorrect Origin and CSRF', async () => {
  assert.equal((await request('/admin/invitations', owner, {}, 'POST', { origin: 'https://app.apps.test' })).status, 403);
  assert.equal((await request('/admin/invitations', owner, {}, 'POST', { 'x-pneuma-space-csrf': 'bad' })).status, 403);
});
test('CF-04 logout immediately revokes the session', async () => {
  const client = await identity();
  assert.equal((await request('/auth/logout', client, {})).status, 204);
  assert.equal((await request('/me', client)).status, 401);
});
test('CF-04 app grant binds nonce and AppId, is used once, and follows parent revocation', async () => {
  const client = await identity(), app = await staticApp(client), other = await staticApp(client);
  const start = await mf.dispatchFetch(app.origin + '/_pneuma-space/login', { redirect: 'manual' });
  assert.equal(start.status, 303);
  const nonce = start.headers.get('set-cookie')!.split(';')[0];
  const grant = await mf.dispatchFetch(start.headers.get('location')!, { redirect: 'manual', headers: { cookie: client.cookie } });
  assert.equal(grant.status, 303);
  const callback = grant.headers.get('location')!;
  assert.equal((await mf.dispatchFetch(callback, { redirect: 'manual' })).status, 401);
  assert.equal((await mf.dispatchFetch(callback.replace(app.origin, other.origin), { redirect: 'manual', headers: { cookie: nonce } })).status, 401);
  const accepted = await mf.dispatchFetch(callback, { redirect: 'manual', headers: { cookie: nonce } });
  assert.equal(accepted.status, 303);
  const appCookie = accepted.headers.getSetCookie().find(value => value.startsWith('__Host-pneuma-space-app='))!.split(';')[0];
  assert.equal((await mf.dispatchFetch(callback, { redirect: 'manual', headers: { cookie: nonce } })).status, 401);
  const page = await mf.dispatchFetch(app.origin + '/', { headers: { cookie: appCookie } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), app.contents);
  assert.equal((await mf.dispatchFetch(other.origin + '/', { headers: { cookie: appCookie } })).status, 401);
  await request('/auth/logout', client, {});
  assert.equal((await mf.dispatchFetch(app.origin + '/', { headers: { cookie: appCookie } })).status, 401);
});
test('CF-05 bearer credentials cannot manage users or issue other credentials', async () => {
  const client = await identity();
  const created = await request('/tenants/' + client.tenant + '/tokens', client, { label: 'test', scopes: ['read', 'publish'] });
  assert.equal(created.status, 201);
  const value = await created.json() as Value, headers = { authorization: 'Bearer ' + value.token };
  assert.equal((await request('/tenants/' + client.tenant + '/apps', undefined, undefined, 'GET', headers)).status, 200);
  assert.equal((await request('/admin/accounts', undefined, undefined, 'GET', headers)).status, 403);
  assert.equal((await request('/tenants/' + client.tenant + '/tokens', undefined, { label: 'bad', scopes: ['read'] }, 'POST', headers)).status, 403);
  assert.equal((await request('/tenants/' + client.tenant + '/tokens/' + value.id, client, undefined, 'DELETE')).status, 204);
  assert.equal((await request('/me', undefined, undefined, 'GET', headers)).status, 401);
});
test('CF-05 members cannot revoke another member credential', async () => {
  const admin = await identity(), member = await identity();
  assert.equal((await request('/tenants/' + admin.tenant + '/members', admin, { userId: member.id, role: 'member' })).status, 200);
  const token = await (await request('/tenants/' + admin.tenant + '/tokens', admin, { label: 'admin', scopes: ['read'] })).json() as Value;
  assert.equal((await request('/tenants/' + admin.tenant + '/tokens/' + token.id, member, undefined, 'DELETE')).status, 404);
  const listed = await (await request('/tenants/' + admin.tenant + '/tokens', member)).json() as Value;
  assert.equal(listed.items.length, 0);
});
test('CF-16 account disable revokes sessions permanently across reenable', async () => {
  const client = await identity();
  assert.equal((await request('/admin/accounts/' + client.id, owner, { disabled: true }, 'PATCH')).status, 200);
  assert.equal((await request('/me', client)).status, 401);
  assert.equal((await request('/admin/accounts/' + client.id, owner, { disabled: false }, 'PATCH')).status, 200);
  assert.equal((await request('/me', client)).status, 401);
});
test('CF-16 concurrent platform demotion retains one active administrator', async () => {
  const other = await identity(true);
  const results = await Promise.all([
    request('/admin/accounts/' + other.id, owner, { platformAdmin: false }, 'PATCH'),
    request('/admin/accounts/' + owner.id, other, { platformAdmin: false }, 'PATCH'),
  ]);
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  const count = await db.prepare('SELECT count(*) AS n FROM users WHERE platform_admin=1 AND disabled=0').first<{ n: number }>();
  assert.equal(count?.n, 1);
  assert.ok(results.some(r => r.status !== 200));
  await db.prepare('UPDATE users SET platform_admin=1 WHERE id=?').bind(owner.id).run();
  await db.prepare('UPDATE users SET platform_admin=0 WHERE id=?').bind(other.id).run();
});
test('CF-16 tenant cannot remove or demote its last active administrator', async () => {
  const client = await identity();
  assert.equal((await request('/tenants/' + client.tenant + '/members/' + client.id, client, undefined, 'DELETE')).status, 409);
  assert.equal((await request('/tenants/' + client.tenant + '/members', client, { userId: client.id, role: 'member' })).status, 409);
});
test('CF-20 concurrent app creation admits only the tenant application quota', async () => {
  const client = await identity();
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare('UPDATE tenants SET apps_limit=1 WHERE id=?').bind(client.tenant).run();
  const results = await Promise.all(['first', 'second'].map(name => request('/tenants/' + client.tenant + '/apps', client, { name })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
});
test('CF-03 exact app origin requires authorization and unknown hosts fail', async () => {
  const client = await identity();
  const app = await (await request('/tenants/' + client.tenant + '/apps', client, { name: 'private' })).json() as { id: string; origin: string };
  assert.equal((await mf.dispatchFetch(app.origin + '/', { redirect: 'manual' })).status, 401);
  assert.equal((await mf.dispatchFetch('https://unknown.apps.test/')).status, 404);
  assert.equal((await request('/apps/' + app.id, await identity())).status, 404);
});
test('CF-20 artifact reservations are atomic and expiry cannot release retained bytes', async () => {
  const client = await identity(), db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare('UPDATE tenants SET storage_limit=1024,apps_limit=1 WHERE id=?').bind(client.tenant).run();
  const app = await (await request('/tenants/' + client.tenant + '/apps', client, { name: 'artifact-limit' })).json() as { id: string };
  const manifest = { contract: 'pneuma-space.cf/1', runtime: 'static', entry: 'public/index.html', capabilities: { static: { dir: 'public' } } };
  const body = { manifest, digest: 'a'.repeat(64), bytes: 768 };
  assert.equal((await request('/apps/' + app.id + '/uploads', client, { ...body, bytes: 1025 })).status, 409);
  const attempts = await Promise.all([request('/apps/' + app.id + '/uploads', client, body), request('/apps/' + app.id + '/uploads', client, body)]);
  assert.deepEqual(attempts.map(response => response.status).sort(), [201, 409]);
  const ticket = await attempts.find(response => response.status === 201)!.json() as { url: string };
  const key = new URL(ticket.url).pathname.slice('/artifacts/'.length);
  const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS') as unknown as R2Bucket;
  await bucket.put(key, new Uint8Array(768));
  await db.prepare('UPDATE uploads SET expires_at=0 WHERE app_id=?').bind(app.id).run();
  assert.equal((await request('/apps/' + app.id + '/uploads', client, body)).status, 409);
  assert.equal((await bucket.head(key))?.size, 768);
  const state = await (await request('/apps/' + app.id + '/state', client)).json() as { artifacts: { reservedBytes: number; limitBytes: number; uploads: number } };
  assert.equal(state.artifacts.reservedBytes, 2304);
  assert.equal(state.artifacts.limitBytes, 3072);
  assert.equal(state.artifacts.uploads, 1);
});
