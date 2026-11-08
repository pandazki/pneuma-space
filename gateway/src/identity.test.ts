import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Authority } from './authz.ts';
import { events, type LifecycleEvent } from './events.ts';
import { LocalIdentity, UpstreamIdentity, issueToken, loadOrCreateSecret, parseIdentityEnv, type UpstreamConfig } from './identity.ts';
import { JwtVerifier } from './jwt.ts';
import { DEFAULT_QUOTA, DEFAULT_TENANT, type Subject, type TenantName, type Token } from './model.ts';
import { SqliteStore } from './store.ts';

const secret = randomBytes(32);
const issued = issueToken('service:ci' as Subject);
const tokens = new Map<string, Token>([[issued.hash, { id: '1', tenant: DEFAULT_TENANT, subject: issued.subject, label: 'ci', hash: issued.hash, createdBy: 'local', createdAt: 0, revokedAt: null }]]);
const identity = new LocalIdentity(secret, { token: async (hash) => tokens.get(hash) ?? null, memberships: async () => [] });

const server = createServer((request, response) => void identity.serve(request, response)).listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function request(headers: IncomingHttpHeaders, method = 'GET', url = '/apps/survey/'): IncomingMessage {
  return { method, url, headers } as IncomingMessage;
}

function cookie(payload: object, key: Buffer = secret): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `pneuma_space_session=${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

function login(name: string, next = '/apps/survey/?q=1', at = base()): Promise<Response> {
  return fetch(`${at}/_pneuma-space/login`, {
    method: 'POST',
    body: new URLSearchParams({ name, next }),
    redirect: 'manual',
  });
}

test('a cookie the platform did not sign, a tampered one and an expired one are challenged', async () => {
  const valid = cookie({ sub: 'user:ana', name: 'ana', iat: Date.now() });
  const tampered = valid.replace(/=[^.]+/, `=${Buffer.from('{"sub":"user:bob","name":"bob","iat":0}').toString('base64url')}`);
  for (const value of [
    cookie({ sub: 'user:ana', name: 'ana', iat: Date.now() }, randomBytes(32)),
    tampered,
    cookie({ sub: 'user:ana', name: 'ana', iat: Date.now() - 31 * 24 * 3600 * 1000 }),
  ]) {
    assert.deepEqual(await identity.authenticate(request({ cookie: value })), { status: 401 });
  }
});

test('a bearer token the platform never issued is challenged', async () => {
  assert.deepEqual(await identity.authenticate(request({ authorization: `Bearer ${issueToken('service:ci' as Subject).token}` })), { status: 401 });
});

test('an issued token authenticates as service:<name>', async () => {
  assert.deepEqual(await identity.authenticate(request({ authorization: `Bearer ${issued.token}` })), { subject: 'service:ci', name: 'ci' });
});

test('a browser is sent to the login page with its path as next; other clients get 401', async () => {
  assert.deepEqual(
    await identity.authenticate(request({ accept: 'text/html,application/xhtml+xml' }, 'GET', '/apps/survey/a?b=1')),
    { status: 303, location: '/_pneuma-space/login?next=%2Fapps%2Fsurvey%2Fa%3Fb%3D1' },
  );
  assert.deepEqual(await identity.authenticate(request({ accept: 'text/html' }, 'POST')), { status: 401 });
  assert.deepEqual(await identity.authenticate(request({ accept: 'application/json' })), { status: 401 });
});

test('login with an invalid name is 400 and sets no cookie', async () => {
  const response = await login('Ana Smith');
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('login sets a cookie that authenticates as user:<name> and returns to next', async () => {
  const response = await login('ana');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/apps/survey/?q=1');
  const session = response.headers.get('set-cookie')!.split(';')[0];
  assert.deepEqual(await identity.authenticate(request({ cookie: `theme=dark; ${session}` })), { subject: 'user:ana', name: 'ana' });
});

test('login never redirects outside /apps/', async () => {
  for (const next of ['https://evil.example/apps/', '//evil.example/apps/', '/api/apps']) {
    assert.equal((await login('ana', next)).headers.get('location'), '/');
  }
});

test('under subdomain addressing login returns to any path on the app\'s host and to no other host', async (t) => {
  const subdomain = new LocalIdentity(secret, { token: async () => null, memberships: async () => [] }, 'subdomain');
  const host = createServer((request, response) => void subdomain.serve(request, response)).listen(0);
  t.after(() => host.close());
  await once(host, 'listening');
  const at = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  const back = async (next: string) => (await login('ana', next, at)).headers.get('location');
  assert.deepEqual([await back('/board?id=7'), await back('//evil.example/'), await back('/\\evil.example/')], ['/board?id=7', '/', '/']);
});

test('the platform secret is created once and read back on the next start', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pneuma-space-secret-')), 'pneuma-space.secret');
  const first = loadOrCreateSecret(path);
  assert.equal(first.length, 32);
  assert.deepEqual(loadOrCreateSecret(path), first);
});

const ed = generateKeyPairSync('ed25519');
const ISSUER = 'https://upstream.example';
const DESIGN = 'design' as TenantName;

function jwt(claims: object): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${b64({ alg: 'EdDSA' })}.${b64({ iss: ISSUER, aud: 'apps', exp: Date.now() / 1000 + 300, sub: 'ana', ...claims })}`;
  return `${data}.${sign(null, Buffer.from(data), ed.privateKey).toString('base64url')}`;
}

const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'pneuma-space-identity-')), 'pneuma-space.sqlite3'));
after(() => store.close());
await store.putTenant({ name: DESIGN, display: 'Design', quota: DEFAULT_QUOTA, createdAt: 0 });
const authority = new Authority(store, { users: new Set(), groups: new Set() });
const staticKeys = new JwtVerifier({ issuer: ISSUER, audiences: ['apps'], keys: { kind: 'static', text: ed.publicKey.export({ format: 'pem', type: 'spki' }).toString() } });

function upstream(config: Partial<UpstreamConfig> = {}): UpstreamIdentity {
  return new UpstreamIdentity({
    header: 'authorization', verifier: staticKeys, audiences: ['apps'], userClaim: 'sub', nameClaims: ['name', 'email'], groupsClaim: 'groups',
    loginUrl: 'https://sso.example/start?rd={url}', logoutUrl: null, stripCookies: [], ...config,
  }, authority, { sighted: async () => {} });
}

async function personalToken(user: string, tenant: TenantName): Promise<{ secret: string; row: Token }> {
  const secret = randomBytes(32).toString('base64url');
  const row: Token = {
    id: randomBytes(4).toString('hex'), tenant, subject: `user:${user}` as Subject, label: 'laptop', hash: createHash('sha256').update(secret).digest('hex'),
    createdBy: `user:${user}` as Subject, createdAt: 0, revokedAt: null,
  };
  await store.putToken(row);
  return { secret, row };
}

test('an empty variable, as compose.yaml passes an unset one, means its default', () => {
  const upstreamEnv = { PNEUMA_SPACE_IDENTITY: 'upstream', PNEUMA_SPACE_IDENTITY_HEADER: 'x-jwt', PNEUMA_SPACE_IDENTITY_JWKS_URL: 'https://sso.example/jwks', PNEUMA_SPACE_IDENTITY_ISSUER: ISSUER, PNEUMA_SPACE_IDENTITY_AUDIENCE: 'apps' };
  const empty = Object.fromEntries(['KEYS_FILE', 'USER_CLAIM', 'NAME_CLAIMS', 'GROUPS_CLAIM', 'LOGIN_URL', 'LOGOUT_URL', 'STRIP_COOKIES'].map((k) => [`PNEUMA_SPACE_IDENTITY_${k}`, '']));
  assert.deepEqual(parseIdentityEnv({ PNEUMA_SPACE_IDENTITY: '' }), { kind: 'local' });
  assert.deepEqual(parseIdentityEnv({ ...upstreamEnv, ...empty, PNEUMA_SPACE_CONSOLE_AUDIENCE: '' }), parseIdentityEnv(upstreamEnv));
});

test('upstream: the JWT is read with and without a Bearer prefix', async () => {
  const value = jwt({ name: 'Ana' });
  const expected = { via: 'upstream', subject: 'user:ana', name: 'Ana', groups: [] };
  assert.deepEqual(await upstream().identify(request({ authorization: `Bearer ${value}` })), expected);
  assert.deepEqual(await upstream({ header: 'x-upstream-jwt' }).identify(request({ 'x-upstream-jwt': value })), expected);
});

test('upstream: a non-JWT Authorization value is a platform token', async () => {
  const { secret } = await personalToken('ben', DESIGN);
  await store.putMembership({ tenant: DESIGN, user: 'ben', role: 'member' });
  const auth = await upstream().identify(request({ authorization: `Bearer ${secret}` }));
  assert.equal(typeof auth === 'object' && auth.via, 'token');
});

test('upstream: the user id comes from sub by default and from the configured claim', async () => {
  const value = jwt({ sub: 'x-123', email: 'ana@example.com' });
  assert.equal((await upstream().authenticate(request({ authorization: value })) as { subject: string }).subject, 'user:x-123');
  assert.equal((await upstream({ userClaim: 'email' }).authenticate(request({ authorization: value })) as { subject: string }).subject, 'user:ana@example.com');
});

test('upstream: a non-ASCII display name reaches the Principal unchanged', async () => {
  assert.equal((await upstream().authenticate(request({ authorization: jwt({ name: '李雷' }) })) as { name: string }).name, '李雷');
});

test('upstream: a user claim outside the subject grammar is 401 and logs identity-rejected with the claim name only', async () => {
  const seen: LifecycleEvent[] = [];
  events.onEvent((event) => event.ev === 'identity-rejected' && seen.push(event));
  const browser = request({ authorization: jwt({ sub: 'ana smith' }), accept: 'text/html' });
  assert.deepEqual(await upstream().authenticate(browser), { status: 401 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.claim, 'sub');
  assert.ok(!JSON.stringify(seen[0]).includes('ana smith'));
});

test('upstream: a browser without a JWT is sent to the login URL with its encoded absolute address', async () => {
  const browser = request({ accept: 'text/html', host: 'survey.apps.example', 'x-forwarded-proto': 'https' }, 'GET', '/a?b=1');
  assert.deepEqual(await upstream().authenticate(browser), { status: 303, location: 'https://sso.example/start?rd=https%3A%2F%2Fsurvey.apps.example%2Fa%3Fb%3D1' });
});

test('upstream: an API client without a JWT gets 401', async () => {
  assert.deepEqual(await upstream().authenticate(request({ accept: 'application/json' })), { status: 401 });
});

test('upstream: with no usable key the answer is 503 and never a redirect', async () => {
  const down = new JwtVerifier({ issuer: ISSUER, audiences: ['apps'], keys: { kind: 'jwks', url: 'https://keys.example/jwks', fetch: async () => { throw new Error('down'); } } });
  const identity = upstream({ verifier: down });
  const browser = request({ authorization: jwt({}), accept: 'text/html' });
  const failure = await identity.identify(browser);
  assert.equal(failure, 'keys-unavailable');
  assert.deepEqual(identity.challenge(browser, failure as 'keys-unavailable'), { status: 503, error: 'identity keys unavailable' });
});

test('upstream: login refuses a next that leaves this host', async () => {
  const login = createServer((req, res) => void upstream().serve(req, res)).listen(0);
  after(() => login.close());
  const port = (login.address() as AddressInfo).port;
  for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example/']) {
    const response = await fetch(`http://127.0.0.1:${port}/_pneuma-space/login?next=${encodeURIComponent(next)}`, { redirect: 'manual', headers: { authorization: jwt({}) } });
    assert.equal(response.status, 400, next);
  }
});

test('upstream: a personal token stops working once its issuer leaves the tenant', async () => {
  const { secret } = await personalToken('cleo', DESIGN);
  await store.putMembership({ tenant: DESIGN, user: 'cleo', role: 'member' });
  assert.equal(typeof await upstream().identify(request({ authorization: `Bearer ${secret}` })), 'object');
  await store.deleteMembership(DESIGN, 'cleo');
  assert.deepEqual(await upstream().authenticate(request({ authorization: `Bearer ${secret}` })), { status: 401 });
});

test('upstream: a revoked token is 401', async () => {
  const { secret, row } = await personalToken('dan', DESIGN);
  await store.putMembership({ tenant: DESIGN, user: 'dan', role: 'member' });
  assert.equal(typeof await upstream().identify(request({ authorization: `Bearer ${secret}` })), 'object');
  await store.revokeToken(row.id, 1);
  assert.deepEqual(await upstream().authenticate(request({ authorization: `Bearer ${secret}` })), { status: 401 });
});

test('upstream mode with a required key missing exits with a one-line reason before listening', () => {
  const run = spawnSync(process.execPath, [join(import.meta.dirname, 'main.ts')], {
    env: { PATH: process.env.PATH, PNEUMA_SPACE_IDENTITY: 'upstream', PNEUMA_SPACE_DATA: mkdtempSync(join(tmpdir(), 'pneuma-space-main-')) }, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'pneuma-space: PNEUMA_SPACE_IDENTITY_HEADER is required when PNEUMA_SPACE_IDENTITY=upstream\n');
});
