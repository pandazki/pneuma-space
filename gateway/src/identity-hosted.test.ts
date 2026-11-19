import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { test, type TestContext } from 'node:test';
import { parseHostedEnv } from './hosted-config.ts';
import { HostedSessions } from './hosted-sessions.ts';
import { HostedIdentity, HOSTED_DEVELOPMENT_PATH, HOSTED_COMPLETE_PATH } from './identity-hosted.ts';
import { LOGIN_PATH, LOGOUT_PATH, newAppId, appName, DEFAULT_TENANT, subject, type App, type ReleaseNumber } from './model.ts';
import { SqliteStore } from './store.ts';

const control = 'http://localhost:58081';
const appOrigin = 'http://notes.apps.localhost:58080';
const app: App = { name: appName('notes'), id: newAppId(), tenant: DEFAULT_TENANT, access: 'tenant', owner: subject('user:alice'), status: 'registered', current: 1 as ReleaseNumber, policyOverride: {}, registeredAt: 1, version: 1 };

async function fixture(t: TestContext, storedApp: App = app) {
  const store = new SqliteStore(':memory:');
  const sessions = new HostedSessions(store);
  const identity = new HostedIdentity(parseHostedEnv({ PNEUMA_SPACE_HOSTED_DEVELOPMENT: 'true', PNEUMA_SPACE_HOSTED_CONTROL_ORIGIN: control, PNEUMA_SPACE_APPS_ORIGIN: 'http://*.apps.localhost:58080' }), sessions, {
    tokens: { token: async () => null, memberships: async () => [] },
    register: async (identity) => ({ user: identity.subject, name: identity.name, tenant: DEFAULT_TENANT }),
    app: async (name) => name === storedApp.name ? storedApp : null,
    authorizeApp: async (auth) => auth.subject === 'user:alice',
  });
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/probe') res.end(JSON.stringify(await identity.identify(req)));
      else await identity.serve(req, res);
    } catch (error) { res.writeHead(500).end(String(error)); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => { server.close(); await once(server, 'close'); await store.close(); });
  const send = (path: string, options: { host?: string; method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path, method: options.method ?? 'GET', headers: { host: options.host ?? new URL(control).host, ...options.headers } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject); req.end(options.body);
  });
  const login = async (user = 'alice') => {
    const page = await send(LOGIN_PATH);
    const state = /name="state" value="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(state);
    const cookie = page.headers['set-cookie']![0]!.split(';')[0]!;
    return send(HOSTED_DEVELOPMENT_PATH, { method: 'POST', headers: { cookie, origin: control }, body: new URLSearchParams({ user, state }).toString() });
  };
  return { send, login, sessions };
}

const sessionCookie = (headers: IncomingHttpHeaders): string => headers['set-cookie']!.find((v) => v.startsWith('pneuma-space-control='))!.split(';')[0]!;

test('AC-SAAS-3 local login is browser-bound and sets a host-only HttpOnly control cookie', async (t) => {
  const { send, login } = await fixture(t);
  const page = await send(LOGIN_PATH);
  const state = /name="state" value="([^"]+)"/.exec(page.body)?.[1];
  assert.ok(state);
  assert.equal((await send(HOSTED_DEVELOPMENT_PATH, { method: 'POST', headers: { origin: control }, body: new URLSearchParams({ user: 'alice', state }).toString() })).status, 401);
  const result = await login();
  assert.equal(result.status, 303);
  const cookie = result.headers['set-cookie']![0]!;
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(JSON.parse((await send('/probe', { headers: { cookie: sessionCookie(result.headers) } })).body).subject, 'user:alice');
});

test('AC-SAAS-4 logout requires Origin and CSRF and invalidates the next request', async (t) => {
  const { send, login } = await fixture(t);
  const cookie = sessionCookie((await login()).headers);
  const auth = JSON.parse((await send('/probe', { headers: { cookie } })).body);
  assert.equal((await send(LOGOUT_PATH, { method: 'POST', headers: { cookie } })).status, 403);
  assert.equal((await send(LOGOUT_PATH, { method: 'POST', headers: { cookie, origin: 'http://other.localhost', 'x-pneuma-space-csrf': auth.csrf } })).status, 403);
  assert.equal((await send(LOGOUT_PATH, { method: 'POST', headers: { cookie, origin: control, 'x-pneuma-space-csrf': auth.csrf } })).status, 204);
  assert.equal(JSON.parse((await send('/probe', { headers: { cookie } })).body), 'invalid');
});

test('AC-SAAS-5 app login completes on the exact app host and removes the grant code', async (t) => {
  const { send, login } = await fixture(t);
  const cookie = sessionCookie((await login()).headers);
  const start = await send(`${LOGIN_PATH}?next=%2Fdocument%3Fx%3D1`, { host: new URL(appOrigin).host });
  const central = new URL(start.headers.location!);
  const grant = await send(central.pathname + central.search, { headers: { cookie } });
  assert.equal(grant.status, 303);
  const completion = new URL(grant.headers.location!);
  assert.equal(completion.origin, appOrigin);
  assert.equal(completion.pathname, HOSTED_COMPLETE_PATH);
  const nonce = start.headers['set-cookie']![0]!.split(';')[0]!;
  const finish = await send(completion.pathname + completion.search, { host: completion.host, headers: { cookie: nonce } });
  assert.equal(finish.status, 303);
  assert.equal(finish.headers.location, '/document?x=1');
  assert.equal((await send(completion.pathname + completion.search, { host: completion.host, headers: { cookie: nonce } })).status, 401);
});

test('AC-SAAS-6 another account receives no private-app grant', async (t) => {
  const { send, login } = await fixture(t);
  const cookie = sessionCookie((await login('bob')).headers);
  const start = await send(LOGIN_PATH, { host: new URL(appOrigin).host });
  const central = new URL(start.headers.location!);
  const grant = await send(central.pathname + central.search, { headers: { cookie } });
  assert.equal(grant.status, 403);
  assert.equal(grant.headers.location, undefined);
});

test('AC-SAAS-14 forged forwarded host and malformed bearer cannot use a control cookie', async (t) => {
  const { send, login } = await fixture(t);
  const cookie = sessionCookie((await login()).headers);
  assert.equal(JSON.parse((await send('/probe', { host: 'evil.example', headers: { cookie, 'x-forwarded-host': new URL(control).host } })).body), 'invalid');
  assert.equal(JSON.parse((await send('/probe', { headers: { cookie, authorization: 'Bearer invalid' } })).body), 'invalid');
});

for (const inactive of [{ ...app, status: 'purging' as const }, { ...app, current: null }]) {
  test(`AC-SAAS-5 app login rejects ${inactive.status === 'purging' ? 'purging app' : 'unreleased app'}`, async (t) => {
    const { send } = await fixture(t, inactive);
    assert.equal((await send(LOGIN_PATH, { host: new URL(appOrigin).host })).status, 400);
  });
}
