import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { parseAppsOrigin } from './address.ts';
import { startAdmin } from './admin.ts';
import { Authority } from './authz.ts';
import { UpstreamIdentity, type UpstreamConfig } from './identity.ts';
import { Ingress } from './ingress.ts';
import { Series } from './metrics.ts';
import { JwtVerifier } from './jwt.ts';
import { appName, parseManifest, subject, type AppId, type AuditRecord, type DeliveryId, type ReplicaId, type TenantName } from './model.ts';
import { world } from './registry.fakes.ts';
import type { PlatformRegistry } from './registry.ts';
import type { SqliteStore } from './store.ts';

const ISSUER = 'https://sso.test';
const A = 'team-a' as TenantName;
const B = 'team-b' as TenantName;
const ed = generateKeyPairSync('ed25519');
const keys = { kind: 'static', text: ed.publicKey.export({ format: 'pem', type: 'spki' }).toString() } as const;

function jwt(sub: string, aud = 'console'): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${b64({ alg: 'EdDSA' })}.${b64({ iss: ISSUER, aud, exp: Date.now() / 1000 + 300, sub, name: sub.toUpperCase() })}`;
  return `${data}.${sign(null, Buffer.from(data), ed.privateKey).toString('base64url')}`;
}

const config = (audience: string): UpstreamConfig => ({
  header: 'x-upstream-jwt', audiences: [audience], userClaim: 'sub', nameClaims: ['name'], groupsClaim: 'groups',
  loginUrl: 'https://sso.test/start?rd={url}', logoutUrl: null, stripCookies: [],
  verifier: new JwtVerifier({ issuer: ISSUER, audiences: [audience], keys }),
});

const w = world();
let registry: PlatformRegistry;
let store: SqliteStore;
let base = '';
let close = async () => {};
const secrets: Record<string, string> = {};
const tokenIds: Record<string, string> = {};
const kv = parseManifest({ contract: 1, capabilities: { kv: {} } });

before(async () => {
  ({ registry, store } = await w.open());
  const authority = new Authority(store, { users: new Set(['root']), groups: new Set() });
  await registry.createTenant(A, 'Team A', ['ana']);
  await registry.setMember(A, 'bob', 'member', false);
  await registry.createTenant(B, 'Team B', ['cid']);
  for (const [name, tenant, owner] of [['alpha', A, 'user:eve'], ['beta', A, 'user:eve'], ['omega', A, 'user:eve'], ['gamma', B, 'user:cid']] as const) {
    await registry.publish({ name: appName(name), image: 'example:1', manifest: kv, bundle: null, owner: subject(owner), tenant });
  }
  for (const [key, who, by] of [['bob', 'user:bob', 'user:bob'], ['ci', `service:${A}.ci`, 'user:ana'], ['old', `service:${A}.old`, 'user:ana']] as const) {
    const issued = await registry.issueTenantToken(A, subject(who), key, subject(by));
    secrets[key] = issued.token;
    tokenIds[key] = issued.id;
  }
  const identity = new UpstreamIdentity(config('console'), authority, registry);
  const server = await startAdmin({
    registry, bundles: w.bundles, runtime: { logs: async () => '', healthOf: () => [] }, guard: w.runtime,
    metrics: { snapshot: () => ({}) as never, events: async () => [] }, nodes: { snapshot: () => ({ source: null, sampledAt: null, nodes: [] }) }, requests: { after: () => [] }, replica: 'r1' as ReplicaId, store, ingressPort: 18080, upstream: { identity, authority },
  }, { port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => void server.close();
});
after(() => close());

/** A user name signs a console JWT; `token:<key>` sends that platform token. Signed-in writes carry Sec-Fetch-Site unless `crossSite`. */
async function call(as: string | null, method: string, path: string, body?: unknown, { crossSite = false, accept }: { crossSite?: boolean; accept?: string } = {}) {
  const headers: Record<string, string> = {};
  if (as?.startsWith('token:')) headers.authorization = `Bearer ${secrets[as.slice('token:'.length)]}`;
  else if (as !== null) headers['x-upstream-jwt'] = jwt(as);
  if (as !== null && !as.startsWith('token:') && !crossSite) headers['sec-fetch-site'] = 'same-origin';
  if (accept) headers.accept = accept;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
  const text = await response.text();
  return { status: response.status, location: response.headers.get('location'), body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

const release = { image: 'example:1', manifest: { contract: 1, capabilities: { kv: {} } } };

/** ADR 0022 item 5 in order: a refused caller, then an allowed one, so a row's write never hides the next row's refusal. `star` marks a row no token may use. */
const TABLE: [row: string, method: string, path: string, body: unknown, allowed: string, refused: string | null, status: number, star?: true][] = [
  ['me', 'GET', '/api/me', undefined, 'dan', null, 401],
  ['health', 'GET', '/api/health', undefined, 'dan', null, 401],
  ['apps', 'GET', '/api/apps', undefined, 'dan', null, 401],
  ['metrics', 'GET', '/api/metrics', undefined, 'root', 'ana', 403, true],
  ['requests', 'GET', '/api/requests', undefined, 'root', 'ana', 403, true],
  ['nodes', 'GET', '/api/nodes', undefined, 'root', 'ana', 403, true],
  ['app detail', 'GET', '/api/apps/alpha', undefined, 'bob', 'cid', 404],
  ['app logs', 'GET', '/api/apps/alpha/logs', undefined, 'token:bob', 'cid', 404],
  ['usage by tenant', 'GET', `/api/usage?tenant=${A}`, undefined, 'bob', 'cid', 403],
  ['usage of an app', 'GET', '/api/usage?app=alpha', undefined, 'bob', 'cid', 404],
  ['usage ranking', 'GET', `/api/usage/apps?tenant=${A}`, undefined, 'bob', 'cid', 403],
  ['usage ranking of every tenant', 'GET', '/api/usage/apps', undefined, 'root', 'ana', 403],
  ['audit', 'GET', `/api/audit?tenant=${A}`, undefined, 'token:ci', 'cid', 403],
  ['release', 'PUT', '/api/apps/alpha/release', release, 'token:ci', 'cid', 404],
  ['bundles', 'POST', '/api/bundles', 'tar bytes', 'bob', 'dan', 403],
  ['global policy', 'PUT', '/api/policy', { idle_seconds: 300 }, 'root', 'ana', 403, true],
  ['app policy', 'PUT', '/api/apps/alpha/policy', { idle_seconds: 5 }, 'bob', 'cid', 404],
  ['access', 'PUT', '/api/apps/alpha/access', { access: 'tenant' }, 'bob', 'cid', 404],
  ['owner', 'PUT', '/api/apps/alpha/owner', { owner: 'user:eve' }, 'ana', 'bob', 403],
  ['move', 'PUT', '/api/apps/beta/tenant', { tenant: B }, 'root', 'ana', 403, true],
  ['tenants', 'GET', '/api/tenants', undefined, 'root', 'ana', 403, true],
  ['create tenant', 'POST', '/api/tenants', { name: 'team-c', display: 'Team C', admins: ['fay'] }, 'root', 'ana', 403, true],
  ['quota', 'GET', `/api/tenants/${A}/quota`, undefined, 'bob', 'cid', 403],
  ['set quota', 'PUT', `/api/tenants/${A}/quota`, { apps: 10 }, 'root', 'ana', 403, true],
  ['members', 'GET', `/api/tenants/${A}/members`, undefined, 'token:bob', 'cid', 403],
  ['add member', 'PUT', `/api/tenants/${A}/members/fay`, { role: 'member' }, 'ana', 'bob', 403, true],
  ['remove member', 'DELETE', `/api/tenants/${A}/members/fay`, undefined, 'ana', 'bob', 403, true],
  ['tokens', 'GET', `/api/tenants/${A}/tokens`, undefined, 'bob', 'cid', 403, true],
  ['issue service token', 'POST', `/api/tenants/${A}/tokens`, { kind: 'service', name: 'deploy' }, 'ana', 'bob', 403, true],
  ['issue personal token', 'POST', `/api/tenants/${A}/tokens`, { kind: 'personal' }, 'bob', 'cid', 403, true],
  ['revoke token', 'DELETE', `/api/tenants/${A}/tokens/<old>`, undefined, 'ana', 'bob', 403, true],
  ['remove', 'POST', '/api/apps/alpha/remove', undefined, 'bob', 'cid', 404],
  ['unquarantine', 'POST', '/api/apps/alpha/unquarantine', undefined, 'bob', 'cid', 404],
  ['purge', 'POST', '/api/apps/alpha/purge', undefined, 'ana', 'bob', 403, true],
];

const pathOf = (path: string) => path.replace('<old>', tokenIds.old!);

test('a platform token gets 403 on every row a token may not use (AC-ID-6)', async () => {
  for (const [row, method, path, body, , , , star] of TABLE) {
    if (!star) continue;
    const got = await call('token:bob', method, pathOf(path), body);
    assert.equal(got.status, 403, row);
    assert.match(got.body.error, /not a token$/, row);
  }
});

test('every endpoint row admits a caller with the role and refuses one without it, a 403 naming the role (AC-ID-6)', async () => {
  for (const [row, method, path, body, allowed, refused, status] of TABLE) {
    const denied = await call(refused, method, pathOf(path), body);
    assert.equal(denied.status, status, `${row}: ${refused ?? 'no credential'}`);
    if (status === 403) assert.match(denied.body.error, /^requires (member|admin) of tenant "[a-z-]+"|^requires (a platform admin|membership of a tenant)/, row);
    const got = await call(allowed, method, pathOf(path), body);
    assert.equal(got.status, 200, `${row}: ${allowed}: ${JSON.stringify(got.body)}`);
  }
});

test('a signed-in write without Sec-Fetch-Site: same-origin gets 403; a token\'s does not need it (AC-ID-7)', async () => {
  const policy = (as: string, crossSite = false) => call(as, 'PUT', '/api/apps/omega/policy', { idle_seconds: 9 }, { crossSite });
  assert.equal((await policy('bob', true)).status, 403);
  assert.equal((await policy('bob')).status, 200);
  assert.equal((await policy('token:ci', true)).status, 200);
});

test('without a credential a browser is sent to the login URL and a program gets 401', async () => {
  const browser = await call(null, 'GET', '/api/apps', undefined, { accept: 'text/html' });
  assert.deepEqual([browser.status, browser.location?.startsWith('https://sso.test/start?rd=')], [303, true]);
  assert.equal((await call(null, 'GET', '/api/apps')).status, 401);
});

test('GET /api/me answers the subject, name, roles per tenant and platformAdmin', async () => {
  assert.deepEqual((await call('ana', 'GET', '/api/me')).body, { subject: 'user:ana', name: 'ANA', roles: { [A]: 'admin' }, platformAdmin: false });
});

test('GET /api/apps lists the caller\'s tenants only; a platform admin gets every app with its tenant, or one tenant with ?tenant=', async () => {
  const names = async (as: string, query = '') => (await call(as, 'GET', `/api/apps${query}`)).body.map((a: { name: string; tenant: string }) => `${a.name}@${a.tenant}`);
  assert.deepEqual(await names('cid'), (await names('root')).filter((n: string) => n.endsWith(`@${B}`)));
  assert.deepEqual(await names('root', `?tenant=${B}`), await names('cid'));
  assert.ok((await names('root')).some((n: string) => n.endsWith(`@${A}`)));
});

test('removing a tenant\'s last admin answers 409; a platform admin may', async () => {
  await registry.createTenant('solo' as TenantName, 'Solo', ['ana']);
  assert.equal((await call('ana', 'DELETE', '/api/tenants/solo/members/ana')).status, 409);
  assert.equal((await call('root', 'DELETE', '/api/tenants/solo/members/ana')).status, 200);
});

test('a service token\'s subject is service:<tenant>.<name>', async () => {
  const issued = await call('ana', 'POST', `/api/tenants/${A}/tokens`, { kind: 'service', name: 'nightly' });
  assert.equal(issued.body.subject, `service:${A}.nightly`);
});

test('a member sees only the tokens they issued; an admin sees every token of the tenant', async () => {
  const issuers = async (as: string) => new Set((await call(as, 'GET', `/api/tenants/${A}/tokens`)).body.map((t: { createdBy: string }) => t.createdBy));
  assert.deepEqual([...await issuers('bob')], ['user:bob']);
  assert.ok((await issuers('ana')).has('user:ana'));
});

test('a move retires the instance and the app lands in the new tenant (ADR 0022 item 3)', async () => {
  await registry.publish({ name: appName('delta'), image: 'example:1', manifest: kv, bundle: null, owner: subject('user:eve'), tenant: A });
  const id = registry.view(appName('delta'))!.app;
  w.runtime.calls.length = 0;
  assert.equal((await call('root', 'PUT', '/api/apps/delta/tenant', { tenant: B })).status, 200);
  assert.ok(w.runtime.calls.includes(`retire ${id}`));
  assert.equal(registry.view(appName('delta'))!.tenant, B);
});

test('adding a member writes started and ok rows with the admin as actor, in the tenant\'s name', async () => {
  await call('ana', 'PUT', `/api/tenants/${A}/members/gus`, { role: 'member' });
  const rows = (await store.audit({ target: 'gus' })).reverse().map(({ actor, actorTenant, tenant, action, targetKind, result }: AuditRecord) => ({ actor, actorTenant, tenant, action, targetKind, result }));
  const row = { actor: 'user:ana', actorTenant: A, tenant: A, action: 'member.add', targetKind: 'member' };
  assert.deepEqual(rows, [{ ...row, result: 'started' }, { ...row, result: 'ok' }]);
});

test('POST /api/tokens is local only', async () => {
  assert.equal((await call('root', 'POST', '/api/tokens', { name: 'ci' })).status, 404);
});

test('a personal token publishes into its tenant with the issuer as owner, and the issuer\'s browser gets X-Pneuma-Space-Owner (AC-ID-8)', async (t) => {
  const personal = await call('bob', 'POST', `/api/tenants/${A}/tokens`, { kind: 'personal' });
  secrets.laptop = personal.body.token;
  const manifest = { contract: 1, capabilities: { identity: {} } };
  assert.equal((await call('token:laptop', 'PUT', '/api/apps/mine/release', { image: 'example:1', manifest })).status, 200);
  const view = registry.view(appName('mine'))!;
  assert.deepEqual([view.tenant, view.owner], [A, 'user:bob']);

  const echo = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const authority = new Authority(store, { users: new Set(), groups: new Set() });
  const identity = new UpstreamIdentity(config('apps'), authority, registry);
  const ingress = new Ingress({
    registry, authority, identity, addressing: parseAppsOrigin('https://*.apps.test'), upstream: { header: 'x-upstream-jwt', stripCookies: [] },
    runtime: { acquire: async (app: AppId) => ({ app, address: `127.0.0.1:${(echo.address() as AddressInfo).port}` }), release() {}, channel() {}, state: () => 'awake' },
    bundles: { open: async () => Readable.from([]) }, scheduler: { invoke: async () => 'd-1' as DeliveryId }, stats: [], async flushStats() {}, async deleteStats() {}, series: new Series(),
  });
  const port = await ingress.listen(0, '127.0.0.1');
  t.after(async () => { await ingress.close(); echo.close(); });
  const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'mine.apps.test', 'x-upstream-jwt': jwt('bob', 'apps') } }, async (res) => {
      let body = '';
      for await (const chunk of res) body += chunk;
      resolve(JSON.parse(body));
    }).on('error', reject);
  });
  assert.equal(headers['x-pneuma-space-owner'], '1');
});
