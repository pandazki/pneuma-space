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
  const app = await (await request('/tenants/' + client.tenant + '/apps', client, { name: 'static-' + randomBytes(4).toString('hex') })).json() as { id: string; name: string; url: string };
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
    serviceBindings: { PNEUMA_SPACE_UI: async (request: Request) => new Response('asset ' + new URL(request.url).pathname) },
    bindings: { PNEUMA_SPACE_CONTROL_ORIGIN: origin, PNEUMA_SPACE_MAX_ACCOUNTS: '100', PNEUMA_SPACE_R2_ACCESS_KEY_ID: 'test-key', PNEUMA_SPACE_R2_SECRET_ACCESS_KEY: 'test-secret', PNEUMA_SPACE_ACCOUNT_ID: '00000000000000000000000000000000', PNEUMA_SPACE_ARTIFACT_BUCKET: 'artifacts', PNEUMA_SPACE_EPHEMERAL_TTL_SECONDS: '600', PNEUMA_SPACE_EPHEMERAL_MAX_TTL_SECONDS: '3600' },
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
  assert.equal((await request('/admin/invitations', owner, {}, 'POST', { origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await request('/admin/invitations', owner, {}, 'POST', { 'x-pneuma-space-csrf': 'bad' })).status, 403);
});
test('CF-04 logout immediately revokes the session', async () => {
  const client = await identity();
  assert.equal((await request('/auth/logout', client, {})).status, 204);
  assert.equal((await request('/me', client)).status, 401);
});
test('CF-04 logout revokes access to applications', async () => {
  const client = await identity(), app = await staticApp(client);
  await request('/auth/logout', client, {});
  assert.equal((await mf.dispatchFetch(app.url, { headers: { cookie: client.cookie } })).status, 401);
});
test('CF-04 an unauthenticated page navigation to an app redirects to login with its path', async () => {
  const app = await staticApp(await identity());
  const response = await mf.dispatchFetch(app.url + 'notes?view=all', { redirect: 'manual', headers: { accept: 'text/html' } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), origin + '/login?next=' + encodeURIComponent('/apps/' + app.name + '/notes?view=all'));
});
test('CF-04 an unauthenticated app API call answers 401', async () => {
  const app = await staticApp(await identity());
  assert.equal((await mf.dispatchFetch(app.url + 'api/items', { redirect: 'manual' })).status, 401);
});
test('CF-04 a cookie-authenticated app write must come from the control origin', async () => {
  const client = await identity(), app = await staticApp(client);
  const write = (from: string) => mf.dispatchFetch(app.url, { method: 'POST', headers: { cookie: client.cookie, origin: from } });
  assert.equal((await write('https://elsewhere.test')).status, 403);
  assert.equal((await write(origin)).status, 404);
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
test('CF-24 the control session serves an app at its path on the control origin', async () => {
  const client = await identity(), app = await staticApp(client);
  assert.equal(app.url, origin + '/apps/' + app.name + '/');
  const page = await mf.dispatchFetch(app.url, { headers: { cookie: client.cookie } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), app.contents);
});
test('CF-24 an app path without its trailing slash redirects to the slash form', async () => {
  const response = await mf.dispatchFetch(origin + '/apps/some-app?view=all', { redirect: 'manual' });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), origin + '/apps/some-app/?view=all');
});
test('CF-24 application names are unique across tenants', async () => {
  const a = await identity(), b = await identity(), name = 'shared-' + randomBytes(4).toString('hex');
  assert.equal((await request('/tenants/' + a.tenant + '/apps', a, { name })).status, 201);
  assert.equal((await request('/tenants/' + b.tenant + '/apps', b, { name })).status, 409);
});
test('CF-24 hosts other than the control origin are unknown', async () => {
  assert.equal((await mf.dispatchFetch('https://app-example.apps.test/')).status, 404);
});
test('CF-26 console files are served under the reserved console path', async () => {
  const response = await mf.dispatchFetch(origin + '/_pneuma-space/console/style.css');
  assert.equal(await response.text(), 'asset /style.css');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('CF-26 root paths outside the console routes answer 404, never a console file', async () => {
  const client = await identity();
  const statuses = await Promise.all(['/style.css', '/app.js', '/index.html', '/favicon.ico'].map(async path => (await mf.dispatchFetch(origin + path, { headers: { cookie: client.cookie } })).status));
  assert.deepEqual(statuses, [404, 404, 404, 404]);
});
test('CF-27 a new app sleeps after 300 idle seconds by default', async () => {
  const client = await identity();
  const app = await (await request('/tenants/' + client.tenant + '/apps', client, { name: 'idle-' + randomBytes(4).toString('hex') })).json() as { id: string };
  const detail = await (await request('/apps/' + app.id, client)).json() as { policy: { idleSeconds: number } };
  assert.equal(detail.policy.idleSeconds, 300);
});
test('CF-03 another tenant cannot reach an app by its path or its control API', async () => {
  const app = await staticApp(await identity()), other = await identity();
  assert.equal((await mf.dispatchFetch(app.url, { headers: { cookie: other.cookie } })).status, 404);
  assert.equal((await request('/apps/' + app.id, other)).status, 404);
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

type App = { id: string; name: string; status: string; createdAt: number; expiresAt: number | null; manager: { name: string; url: string | null } | null; releases: unknown[]; current: { number: number } | null; policy: { idleSeconds: number } };
const named = (name: string) => ({ 'x-pneuma-space-manager': name });
async function created(client: Client, body: Record<string, unknown> = {}): Promise<App> {
  const response = await request('/tenants/' + client.tenant + '/apps', client, { name: 'app-' + randomBytes(4).toString('hex'), ...body });
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json() as App;
}
async function detail(client: Client, app: { id: string }): Promise<App> {
  return await (await request('/apps/' + app.id, client)).json() as App;
}
async function scoped(client: Client, scopes: string[]): Promise<Record<string, string>> {
  const value = await (await request('/tenants/' + client.tenant + '/tokens', client, { label: 'scoped', scopes })).json() as Value;
  return { authorization: 'Bearer ' + value.token };
}
const page = { contract: 'pneuma-space.cf/1', runtime: 'static', entry: 'public/index.html', capabilities: { static: { dir: 'public' } } };
async function upload(client: Client, app: { id: string }, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const bytes = JSON.stringify({ manifest: page, files: [{ path: 'public/index.html', body: Buffer.from('Page ' + randomBytes(4).toString('hex')).toString('base64'), contentType: 'text/html' }] });
  const response = await request('/apps/' + app.id + '/uploads', client, { manifest: page, digest: hash(bytes), bytes: Buffer.byteLength(bytes), ...body }, 'POST', headers);
  if (response.status !== 201) return { response, uploadId: '' };
  const ticket = await response.json() as { url: string; uploadId: string };
  const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS') as unknown as R2Bucket;
  await bucket.put(new URL(ticket.url).pathname.slice('/artifacts/'.length), bytes);
  return { response, uploadId: ticket.uploadId };
}
async function release(client: Client, app: App, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const ephemeral = app.expiresAt !== null ? { ephemeral: true } : {};
  const { uploadId } = await upload(client, app, ephemeral, headers);
  assert.ok(uploadId, 'upload refused');
  return request('/apps/' + app.id + '/releases', client, { uploadId, ...ephemeral, ...body }, 'POST', headers);
}
async function auditRows(app: { id: string }, action: string): Promise<{ user_id: string; result: string; detail: string }[]> {
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  return (await db.prepare('SELECT user_id,result,detail FROM audit WHERE app_id=? AND action=? ORDER BY at,id').bind(app.id, action).all<{ user_id: string; result: string; detail: string }>()).results;
}
/** Purge waits for the last signed upload URL to expire (CF-11); these tests start after it has. */
async function ticketsExpired(app: { id: string }) {
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare('UPDATE uploads SET ticket_expires_at=0 WHERE app_id=?').bind(app.id).run();
}

test('CF-29 an app created ephemeral ends at creation plus the default lifetime, shown in list and detail', async () => {
  const client = await identity(), app = await created(client, { ephemeral: {} }), durable = await created(client);
  assert.equal(app.expiresAt, app.createdAt + 600000);
  const listed = (await (await request('/tenants/' + client.tenant + '/apps', client)).json() as { items: App[] }).items;
  assert.deepEqual([app.id, durable.id].map(id => listed.find(item => item.id === id)?.expiresAt), [app.expiresAt, null]);
  assert.deepEqual([(await detail(client, app)).expiresAt, (await detail(client, durable)).expiresAt], [app.expiresAt, null]);
});
test('CF-29 a lifetime over the deployment maximum is refused and creates nothing', async () => {
  const client = await identity();
  assert.equal((await request('/tenants/' + client.tenant + '/apps', client, { name: 'too-long', ephemeral: { ttlSeconds: 3601 } })).status, 400);
  assert.deepEqual((await (await request('/tenants/' + client.tenant + '/apps', client)).json() as Value).items, []);
});
test('CF-29 an upload that states the other kind is refused and reserves nothing', async () => {
  const client = await identity(), ephemeral = await created(client, { ephemeral: { ttlSeconds: 60 } }), durable = await created(client);
  assert.equal((await upload(client, ephemeral)).response.status, 409);
  assert.equal((await upload(client, durable, { ephemeral: true })).response.status, 409);
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM uploads WHERE app_id IN(?,?)').bind(ephemeral.id, durable.id).first<{ n: number }>())?.n, 0);
});
test('CF-29 a release that states the other kind is refused and writes no release', async () => {
  const client = await identity(), app = await created(client, { ephemeral: {} });
  const { uploadId } = await upload(client, app, { ephemeral: true });
  assert.equal((await request('/apps/' + app.id + '/releases', client, { uploadId })).status, 409);
  assert.deepEqual((await detail(client, app)).releases, []);
});
test('CF-29 a token with the remove scope discards a published ephemeral app, which is then gone', async () => {
  const client = await identity(), app = await created(client, { ephemeral: {} }), token = await scoped(client, ['remove']);
  assert.equal((await release(client, app)).status, 200);
  await ticketsExpired(app);
  const discarded = await request('/apps/' + app.id + '/actions', undefined, { type: 'discard' }, 'POST', token);
  assert.equal(discarded.status, 200, await discarded.clone().text());
  assert.equal((await discarded.json() as App).status, 'purged');
  assert.equal((await request('/apps/' + app.id, client)).status, 404);
  assert.equal((await request('/apps/' + app.id + '/actions', undefined, { type: 'discard' }, 'POST', token)).status, 404);
});
test('CF-29 discard needs the remove scope', async () => {
  const client = await identity(), app = await created(client, { ephemeral: {} });
  assert.equal((await request('/apps/' + app.id + '/actions', undefined, { type: 'discard' }, 'POST', await scoped(client, ['read', 'publish', 'manage']))).status, 403);
});
test('CF-29 discarding a durable app answers 409 and changes nothing', async () => {
  const client = await identity(), app = await staticApp(client);
  assert.equal((await request('/apps/' + app.id + '/actions', client, { type: 'discard' })).status, 409);
  assert.equal((await detail(client, app)).status, 'registered');
});
test('CF-29 discard ends an ephemeral app from draft and from removed', async () => {
  const client = await identity(), draft = await created(client, { ephemeral: {} }), removed = await created(client, { ephemeral: {} });
  await release(client, removed);
  await ticketsExpired(removed);
  assert.equal((await request('/apps/' + removed.id + '/actions', client, { type: 'remove' })).status, 200);
  for (const app of [draft, removed]) assert.equal((await request('/apps/' + app.id + '/actions', client, { type: 'discard' })).status, 200);
  assert.deepEqual(await Promise.all([draft, removed].map(async app => (await request('/apps/' + app.id, client)).status)), [404, 404]);
});
test('CF-29 ephemeral apps count toward the ephemeral quota, not the application quota', async () => {
  const client = await identity(), db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare('UPDATE tenants SET apps_limit=1,ephemeral_limit=1 WHERE id=?').bind(client.tenant).run();
  await created(client);
  await created(client, { ephemeral: {} });
  const create = async (body: Record<string, unknown>) => (await request('/tenants/' + client.tenant + '/apps', client, { name: 'over-' + randomBytes(4).toString('hex'), ...body })).json() as Promise<{ error: { code: string } }>;
  assert.deepEqual([(await create({ ephemeral: {} })).error.code, (await create({})).error.code], ['ephemeral_quota', 'app_quota']);
});
test('CF-29 an ephemeral app that is ending gives its ephemeral slot back at once', async () => {
  const client = await identity(), db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare('UPDATE tenants SET ephemeral_limit=1 WHERE id=?').bind(client.tenant).run();
  const app = await created(client, { ephemeral: {} });
  await upload(client, app, { ephemeral: true });
  assert.equal((await (await request('/apps/' + app.id + '/actions', client, { type: 'discard' })).json() as { pending?: boolean }).pending, true);
  await created(client, { ephemeral: {} });
});
test('CF-29 an ending ephemeral app keeps its name and storage until its cleanup ends', async () => {
  const client = await identity(), db = await mf.getD1Database('PNEUMA_SPACE_DB'), app = await created(client, { ephemeral: {} });
  await upload(client, app, { ephemeral: true });
  await request('/apps/' + app.id + '/actions', client, { type: 'discard' });
  const create = async (name: string) => (await request('/tenants/' + client.tenant + '/apps', client, { name, ephemeral: {} })).json() as Promise<{ error: { code: string } }>;
  const taken = await create(app.name);
  // The ending app still holds 10 MiB, so under a 10 MiB limit the 2 MiB a new app takes does not fit.
  await db.prepare('UPDATE tenants SET storage_limit=? WHERE id=?').bind(10 * 1024 * 1024, client.tenant).run();
  assert.deepEqual([taken.error.code, (await create('other-' + randomBytes(4).toString('hex'))).error.code], ['app_exists', 'ephemeral_quota']);
});
test('CF-29 the ephemeral quota is edited with the other tenant quotas and reported in usage', async () => {
  const client = await identity();
  await created(client, { ephemeral: {} });
  const quota = { apps: 5, ephemeral: 2, awake: 2, requestsPerDay: 10000, storageBytes: 52428800 };
  assert.equal((await request('/admin/tenants/' + client.tenant, owner, { quota }, 'PATCH')).status, 200);
  const usage = await (await request('/tenants/' + client.tenant + '/usage', client)).json() as { quota: { ephemeral: number }; used: { apps: number; ephemeral: number } };
  assert.deepEqual([usage.quota.ephemeral, usage.used.ephemeral, usage.used.apps], [2, 1, 0]);
});
test('CF-29 creation records the end and discard is audited', async () => {
  const client = await identity(), app = await created(client, { ephemeral: {} });
  await request('/apps/' + app.id + '/actions', client, { type: 'discard' });
  assert.equal(JSON.parse((await auditRows(app, 'app.create'))[0].detail).expiresAt, app.expiresAt);
  assert.deepEqual((await auditRows(app, 'app.discard')).map(row => [row.user_id, row.result]), [[client.id, 'ok']]);
});

test('CF-30 an app created with a manager returns it in list and detail, its url as the URL parser writes it', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer', url: 'HTTPS://Deploy.Test/board' } });
  const manager = { name: 'deployer', url: 'https://deploy.test/board' };
  const listed = (await (await request('/tenants/' + client.tenant + '/apps', client)).json() as { items: App[] }).items;
  assert.deepEqual([app.manager, listed.find(item => item.id === app.id)?.manager, (await detail(client, app)).manager], [manager, manager, manager]);
});
test('CF-30 a manager url that is not absolute http or https, too long or with control characters answers 400', async () => {
  const client = await identity();
  for (const url of ['javascript:alert(1)', '/relative', 'https://deploy.test/' + 'a'.repeat(2048), 'https://deploy.test/\u0007']) {
    assert.equal((await request('/tenants/' + client.tenant + '/apps', client, { name: 'bad-url', manager: { name: 'deployer', url } })).status, 400, url);
  }
  assert.deepEqual((await (await request('/tenants/' + client.tenant + '/apps', client)).json() as Value).items, []);
});
test('CF-30 a write without the manager name answers 409 naming the manager, its url and how to name it', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer', url: 'https://deploy.test/board' } });
  const response = await request('/apps/' + app.id + '/actions', client, { type: 'remove' });
  const { error } = await response.json() as { error: { code: string; message: string } };
  assert.equal(response.status, 409);
  for (const part of ['deployer', 'https://deploy.test/board', 'goes around it', 'X-Pneuma-Space-Manager: deployer']) assert.ok(error.message.includes(part), part);
});
test('CF-30 every write that must name the manager answers 409 without it and changes nothing', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer' } });
  assert.equal((await release(client, app, {}, named('deployer'))).status, 200);
  const view = (value: App) => [value.status, value.releases.length, value.current?.number, value.manager, value.policy.idleSeconds];
  const before = view(await detail(client, app));
  const { uploadId } = await upload(client, app, {}, named('deployer'));
  const writes = [
    () => upload(client, app).then(result => result.response),
    () => request('/apps/' + app.id + '/releases', client, { uploadId }),
    ...[{ type: 'rollback', release: 1 }, { type: 'remove' }, { type: 'resume' }, { type: 'purge', confirmation: app.name }, { type: 'discard' }, { type: 'policy', policy: { idleSeconds: 60 } }].map(action => () => request('/apps/' + app.id + '/actions', client, action)),
    () => request('/apps/' + app.id + '/manager', client, undefined, 'DELETE'),
  ];
  for (const write of writes) {
    const response = await write();
    assert.deepEqual([response.status, (await response.json() as { error: { code: string } }).error.code], [409, 'managed']);
  }
  assert.deepEqual(view(await detail(client, app)), before);
});
test('CF-30 naming the manager lets the write through and its audit records the name', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer' } });
  await release(client, app, {}, named('deployer'));
  assert.equal((await request('/apps/' + app.id + '/actions', client, { type: 'remove' }, 'POST', named('deployer'))).status, 200);
  assert.equal(JSON.parse((await auditRows(app, 'app.remove'))[0].detail).namedManager, 'deployer');
});
test('CF-30 runtime actions and reads on a managed app need no name', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer' } });
  await release(client, app, {}, named('deployer'));
  for (const type of ['sleep', 'unquarantine']) assert.equal((await request('/apps/' + app.id + '/actions', client, { type })).status, 200, type);
  for (const section of ['', '/releases', '/state', '/logs', '/events', '/usage', '/jobs']) assert.equal((await request('/apps/' + app.id + section, client)).status, 200, section);
});
test('CF-30 authorization answers before the manager 409', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer' } });
  assert.equal((await request('/apps/' + app.id + '/actions', await identity(), { type: 'remove' })).status, 404);
  assert.equal((await request('/apps/' + app.id + '/actions', undefined, { type: 'remove' }, 'POST', await scoped(client, ['read']))).status, 403);
});
test('CF-30 the request own errors answer the same with or without the manager name', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer' } });
  await release(client, app, {}, named('deployer'));
  for (const headers of [{}, named('deployer')]) {
    assert.equal((await request('/apps/' + app.id + '/actions', client, { type: 'rollback', release: 99 }, 'POST', headers)).status, 404);
    const policy = await request('/apps/' + app.id + '/actions', client, { type: 'policy', policy: { storageBytes: 1000000000 } }, 'POST', headers);
    assert.equal((await policy.json() as { error: { code: string } }).error.code, 'storage_quota');
  }
});
test('CF-30 a malformed manager header answers 400 on an unmanaged app', async () => {
  const client = await identity(), app = await staticApp(client);
  for (const value of ['Deployer', 'deployer, other']) assert.equal((await request('/apps/' + app.id + '/actions', client, { type: 'remove' }, 'POST', named(value))).status, 400, value);
});
test('CF-30 a release carrying a manager makes an unmanaged app managed', async () => {
  const client = await identity(), app = await created(client);
  assert.equal((await release(client, app, { manager: { name: 'deployer', url: 'https://deploy.test/' } })).status, 200);
  assert.deepEqual((await detail(client, app)).manager, { name: 'deployer', url: 'https://deploy.test/' });
  assert.equal((await request('/apps/' + app.id + '/actions', client, { type: 'remove' })).status, 409);
});
test('CF-30 a release that names a manager without a url keeps the url while the name stays', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer', url: 'https://deploy.test/' } });
  await release(client, app, { manager: { name: 'deployer' } }, named('deployer'));
  assert.deepEqual((await detail(client, app)).manager, { name: 'deployer', url: 'https://deploy.test/' });
  await release(client, app, { manager: { name: 'releaser' } }, named('deployer'));
  assert.deepEqual((await detail(client, app)).manager, { name: 'releaser', url: null });
});
test('CF-30 a release with an absent or null manager leaves it as it is', async () => {
  const client = await identity(), manager = { name: 'deployer', url: 'https://deploy.test/' }, app = await created(client, { manager });
  for (const body of [{}, { manager: null }]) {
    assert.equal((await release(client, app, body, named('deployer'))).status, 200);
    assert.deepEqual((await detail(client, app)).manager, manager);
  }
});
test('CF-30 clearing the manager names it and is audited as app.manager', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer' } });
  assert.equal((await request('/apps/' + app.id + '/manager', client, undefined, 'DELETE', named('deployer'))).status, 200);
  assert.equal((await detail(client, app)).manager, null);
  assert.deepEqual((await auditRows(app, 'app.manager')).map(row => JSON.parse(row.detail).namedManager), ['deployer']);
});
test('CF-30 clearing the manager needs the publish scope', async () => {
  const client = await identity(), app = await created(client, { manager: { name: 'deployer' } });
  assert.equal((await request('/apps/' + app.id + '/manager', undefined, undefined, 'DELETE', { ...await scoped(client, ['read', 'manage', 'remove']), ...named('deployer') })).status, 403);
});
test('CF-30 an ephemeral app can also be managed', async () => {
  const client = await identity(), app = await created(client, { ephemeral: {}, manager: { name: 'deployer' } });
  assert.equal((await request('/apps/' + app.id + '/actions', client, { type: 'discard' })).status, 409);
  assert.equal((await request('/apps/' + app.id + '/actions', client, { type: 'discard' }, 'POST', named('deployer'))).status, 200);
});
