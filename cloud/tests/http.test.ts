import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalBackend } from '../adapters/local/backend.ts';
import { developmentIdentity } from '../adapters/local/development-login.ts';
import { productionConfig, type CloudConfig } from '../core/config.ts';
import { DEFAULT_LIMITS } from '../core/model.ts';
import { createRouter } from '../http/router.ts';
import { appOrigin, cookieNames } from '../http/tenant.ts';
import { appRequest, appResponse } from '../http/security.ts';
import { serveStatic } from '../http/static.ts';
import { prepareArtifact } from '../core/artifacts.ts';

const config: CloudConfig = { controlOrigin: 'http://localhost:8787', appsDomain: 'apps.localhost:8787', secureCookies: false, enabled: true, limits: DEFAULT_LIMITS };
const names = cookieNames(false);
const source = `export default { async fetch(request, app) {
  if(new URL(request.url).pathname === '/inspect') return Response.json({ headers:Object.fromEntries(request.headers), identity:app.identity },{headers:{'set-cookie':'pneuma-space-control=forged; Domain=localhost'}});
  if(new URL(request.url).pathname === '/cookie') return new Response('cookie',{headers:{'set-cookie':'custom=ok; Domain=localhost; Path=/'}});
  let row=await app.records.get('count');
  if(request.method === 'POST') { const result=await app.records.commit([{kind:'put',key:'count',expected:row?.revision ?? null,value:(row?.value ?? 0)+1}]); if(!result.ok)return new Response('conflict',{status:409}); row=await app.records.get('count'); }
  return Response.json(row ?? {value:0});
} };`;
const artifact = { manifest: { contract: 2, runtime: 'fetch', abi: 'pneuma-space.fetch/1', entry: 'app.mjs', capabilities: { records: {}, identity: {}, static: { dir: 'public' } } }, source, assets: [{ path: 'index.html', contentType: 'text/html', body: btoa('private static data') }] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-http-'));
  const backend = new LocalBackend(directory, config);
  cleanups.push(async () => { backend.close(); await rm(directory, { recursive: true, force: true }); });
  const route = createRouter({ config, backend, identity: developmentIdentity(config.controlOrigin), consoleHtml: '<html>console</html>' });
  const accounts = await Promise.all(['alice', 'bob'].map(subject => backend.register({ provider: 'local', subject, name: subject })));
  const sessions = await Promise.all(accounts.map(account => backend.tenant(account.tenant).createSession(account)));
  const control = (index: number, path: string, method = 'GET', body?: unknown, headers: HeadersInit = {}) => route(new Request(config.controlOrigin + path, {
    method, headers: { cookie: `${names.control}=${sessions[index].credential}`, origin: config.controlOrigin, 'x-pneuma-space-csrf': sessions[index].csrf,
      ...(method === 'PUT' ? { 'idempotency-key': crypto.randomUUID() } : {}), ...Object.fromEntries(new Headers(headers)) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const tokenResponse = await control(0, '/api/tokens', 'POST', { label: 'cli', scopes: ['read', 'publish', 'invoke', 'remove', 'export'], appIds: null, expiresAt: Date.now() + 3600_000 });
  const token = await tokenResponse.json() as { token: string; metadata: { id: string } };
  assert.equal(tokenResponse.status, 201);
  const publish = await control(0, '/api/apps/counter/release', 'PUT', artifact);
  assert.equal(publish.status, 200, await publish.clone().text());
  const origin = appOrigin(config, accounts[0].tenant, 'counter');
  return { backend, route, accounts, sessions, control, token, origin };
}

test('AC-C-5 another account cannot list or manage the owner application', async () => {
  const f = await fixture();
  assert.deepEqual(await (await f.control(1, '/api/apps')).json(), []);
  assert.equal((await f.control(1, '/api/apps/counter')).status, 404);
  assert.equal((await f.control(1, '/api/apps/counter/remove', 'POST', {})).status, 404);
});

test('AC-C-5 static content requires an application credential', async () => {
  const f = await fixture();
  const response = await f.route(new Request(f.origin + '/'));
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /private static/);
});

test('AC-C-5 another tenant token cannot invoke a dynamic handler', async () => {
  const f = await fixture();
  const token = await (await f.control(1, '/api/tokens', 'POST', { label: 'bob', scopes: ['invoke'], appIds: null, expiresAt: Date.now() + 3600_000 })).json() as { token: string };
  const response = await f.route(new Request(f.origin + '/count', { method: 'POST', headers: { authorization: 'Bearer ' + token.token } }));
  assert.equal(response.status, 404);
  const state = await f.route(new Request(f.origin + '/count', { headers: { authorization: 'Bearer ' + f.token.token } }));
  assert.equal((await state.json() as { value: number }).value, 0);
});

test('AC-C-6 a control write rejects a foreign Origin', async () => {
  const f = await fixture();
  assert.equal((await f.control(0, '/api/apps/counter/remove', 'POST', {}, { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.control(0, '/api/apps/counter')).status, 200);
});

test('AC-C-6 a control write rejects a missing CSRF value', async () => {
  const f = await fixture();
  assert.equal((await f.control(0, '/api/apps/counter/remove', 'POST', {}, { 'x-pneuma-space-csrf': '' })).status, 403);
});

test('AC-C-7 app navigation exchanges a grant and cleans the callback URL', async () => {
  const f = await fixture();
  const entry = await f.route(new Request(f.origin + '/count?q=1', { headers: { 'sec-fetch-mode': 'navigate' } }));
  assert.equal(entry.status, 303);
  const authorize = new URL(entry.headers.get('location')!);
  const grant = await f.control(0, authorize.pathname + authorize.search);
  assert.equal(grant.status, 303);
  const callback = await f.route(new Request(grant.headers.get('location')!, { headers: { cookie: entry.headers.getSetCookie()[0].split(';')[0] } }));
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), f.origin + '/count?q=1');
  assert.ok(callback.headers.getSetCookie().some(value => value.startsWith(names.app + '=pas1.')));
});

test('AC-C-6 logout invalidates the browser application session', async () => {
  const f = await fixture();
  const entry = await f.route(new Request(f.origin + '/count', { headers: { 'sec-fetch-mode': 'navigate' } }));
  const authorize = new URL(entry.headers.get('location')!);
  const grant = await f.control(0, authorize.pathname + authorize.search);
  const callback = await f.route(new Request(grant.headers.get('location')!, { headers: { cookie: entry.headers.getSetCookie()[0].split(';')[0] } }));
  const appCookie = callback.headers.getSetCookie().find(value => value.startsWith(names.app + '='))!.split(';')[0];
  assert.equal((await f.route(new Request(f.origin + '/count', { headers: { cookie: appCookie } }))).status, 200);
  assert.equal((await f.control(0, '/auth/logout', 'POST', {})).status, 204);
  assert.equal((await f.route(new Request(f.origin + '/count', { headers: { cookie: appCookie } }))).status, 401);
});

test('AC-C-8 application input loses platform credentials and receives authoritative headers', async () => {
  const f = await fixture();
  const response = await f.route(new Request(f.origin + '/inspect', { headers: { authorization: 'Bearer ' + f.token.token,
    cookie: `${names.control}=${f.sessions[0].credential}; userPreference=yes`, connection: 'X-Pneuma-Space-Subject',
    'x-pneuma-space-subject': 'user:attacker', 'x-pneuma-space-test': 'forged' } }));
  assert.equal(response.status, 200);
  const body = await response.json() as { headers: Record<string, string>; identity: { subject: string } };
  assert.equal(body.headers.authorization, undefined);
  assert.equal(body.headers.cookie, 'userPreference=yes');
  assert.equal(body.headers.connection, undefined);
  assert.equal(body.headers['x-pneuma-space-test'], undefined);
  assert.equal(body.headers['x-pneuma-space-subject'], body.identity.subject);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('AC-C-8 application cookies cannot target a parent domain', async () => {
  const f = await fixture();
  const response = await f.route(new Request(f.origin + '/cookie', { headers: { authorization: 'Bearer ' + f.token.token } }));
  assert.equal(response.headers.get('set-cookie'), 'custom=ok; Path=/');
  assert.match(response.headers.get('content-security-policy')!, /worker-src 'none'/);
});

test('AC-C-8 all adjacent reserved identity headers are removed', () => {
  const request = appRequest(new Request('http://test.localhost', { headers: {
    'x-pneuma-space-a': 'a', 'x-pneuma-space-b': 'b', 'x-pneuma-space-c': 'c',
  } }), null);
  assert.deepEqual([...request.headers], []);
});

test('AC-C-8 trusted display names keep the existing header encoding', () => {
  const request = appRequest(new Request('http://test.localhost'), { subject: 'user:x', owner: 'user:x', name: 'A B/张%' });
  assert.equal(request.headers.get('x-pneuma-space-name'), 'A B/%E5%BC%A0%25');
});

test('AC-C-8 platform CSP is a separate policy from application directives', () => {
  const response = appResponse(new Response('', { headers: { 'content-security-policy': "frame-ancestors *; worker-src *" } }));
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors *; worker-src *, worker-src 'none'; frame-ancestors 'none'");
});

test('AC-C-19 static responses obey the active response limit', async () => {
  const prepared = await prepareArtifact(artifact, DEFAULT_LIMITS);
  await assert.rejects(serveStatic(new Request('http://test.localhost/'), prepared.artifact, 1), { status: 413 });
});

test('AC-C-19 static retrieval cannot outlive its admission deadline', async () => {
  const f = await fixture();
  const fastConfig = { ...config, limits: { ...config.limits, deadlineMs: 1 } };
  const endpoint = f.backend.tenant(f.accounts[0].tenant);
  const route = createRouter({ config: fastConfig, identity: developmentIdentity(config.controlOrigin), consoleHtml: '', backend: {
    ...f.backend, register: identity => f.backend.register(identity), runtime: f.backend.runtime,
    tenant: () => ({ ...endpoint, ensureOwner: account => endpoint.ensureOwner(account), createSession: account => endpoint.createSession(account), control: request => endpoint.control(request), admit: async (request, name) => {
      const admission = await endpoint.admit(request, name);
      return admission instanceof Response ? admission : { ...admission, expiresAt: Date.now() + 1 };
    } }),
    artifacts: { put: (...args) => f.backend.artifacts.put(...args), destroy: id => f.backend.artifacts.destroy(id), get: async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return f.backend.artifacts.get(...args);
    } },
  } });
  assert.equal((await route(new Request(f.origin + '/', { headers: { authorization: 'Bearer ' + f.token.token } }))).status, 504);
  await new Promise(resolve => setTimeout(resolve, 40));
});

test('AC-C-3 revocation rejects the next HTTP admission', async () => {
  const f = await fixture();
  assert.equal((await f.control(0, '/api/tokens/' + f.token.metadata.id + '/revoke', 'POST', {})).status, 200);
  assert.equal((await f.route(new Request(f.origin + '/count', { headers: { authorization: 'Bearer ' + f.token.token } }))).status, 403);
});

test('AC-C-16 a removed export restores into another local storage directory', async () => {
  const f = await fixture();
  const headers = { authorization: 'Bearer ' + f.token.token };
  const written = await f.route(new Request(f.origin + '/count', { method: 'POST', headers }));
  const stored = await written.json();
  assert.equal((await f.control(0, '/api/apps/counter/remove', 'POST', {})).status, 200);
  const archive = await (await f.control(0, '/api/apps/counter/export')).json();
  const destination = await fixture();
  const restored = await destination.control(0, '/api/apps/restored/import', 'PUT', archive);
  assert.equal(restored.status, 200, await restored.clone().text());
  const published = await destination.control(0, '/api/apps/restored/release', 'PUT', artifact);
  assert.equal(published.status, 200, await published.clone().text());
  const origin = appOrigin(config, destination.accounts[0].tenant, 'restored');
  const response = await destination.route(new Request(origin + '/count', { headers: { authorization: 'Bearer ' + destination.token.token } }));
  assert.deepEqual(await response.json(), stored);
});

test('AC-C-22 production rejects shared control and app sites', () => {
  assert.throws(() => productionConfig({ PNEUMA_SPACE_CONTROL_ORIGIN: 'https://space.deepaste.ai', PNEUMA_SPACE_APPS_DOMAIN: 'apps.deepaste.ai' }), /separate/);
});

test('AC-C-22 production rejects an insecure control origin', () => {
  assert.throws(() => productionConfig({ PNEUMA_SPACE_CONTROL_ORIGIN: 'http://space.deepaste.ai' }), /HTTPS/);
});

test('AC-C-22 production rejects missing identity secrets', () => {
  assert.throws(() => productionConfig({ PNEUMA_SPACE_CONTROL_ORIGIN: 'https://space.deepaste.ai', PNEUMA_SPACE_APPS_DOMAIN: 'apps.unrelated.test', PNEUMA_SPACE_SESSION_KEY: 'x'.repeat(32) }), /GITHUB_CLIENT_ID/);
});
