import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAppsOrigin } from './address.ts';
import { Authority } from './authz.ts';
import { UpstreamIdentity, type Identity, type UpstreamConfig } from './identity.ts';
import { Ingress } from './ingress.ts';
import { Series } from './metrics.ts';
import { JwtVerifier } from './jwt.ts';
import {
  DEFAULT_POLICY, QuotaExceeded,
  type Access, type AppId, type AppName, type BundleId, type CapabilityKind, type DeliveryId, type ImageId, type Membership,
  type ReleaseNumber, type RouteView, type Subject, type TenantName, type Token,
} from './model.ts';

const ISSUER = 'https://sso.test';
const TEAM = 'team-a' as TenantName;
const OTHER = 'team-b' as TenantName;
const ed = generateKeyPairSync('ed25519');
const APP_JS = Buffer.from('console.log(1)');

function jwt(sub: string, name = sub): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${b64({ alg: 'EdDSA' })}.${b64({ iss: ISSUER, aud: 'apps', exp: Date.now() / 1000 + 300, sub, name })}`;
  return `${data}.${sign(null, Buffer.from(data), ed.privateKey).toString('base64url')}`;
}

const serviceSecret = randomBytes(32).toString('base64url');
const TOKENS = new Map<string, Token>([[createHash('sha256').update(serviceSecret).digest('hex'), {
  id: 't1', tenant: OTHER, subject: `service:${OTHER}.ci` as Subject, label: 'ci', hash: '', createdBy: 'user:bob' as Subject, createdAt: 0, revokedAt: null,
}]]);
const MEMBERS: Membership[] = [{ tenant: TEAM, user: 'ana', role: 'member' }, { tenant: OTHER, user: 'bob', role: 'member' }];
const authority = new Authority({
  token: async (hash) => TOKENS.get(hash) ?? null,
  memberships: async ({ user }) => MEMBERS.filter((m) => m.user === user),
  onChange() {},
}, { users: new Set(), groups: new Set() });

const CONFIG: UpstreamConfig = {
  header: 'x-upstream-jwt', audiences: ['apps'], userClaim: 'sub', nameClaims: ['name'], groupsClaim: 'groups',
  loginUrl: 'https://sso.test/start?rd={url}', logoutUrl: null, stripCookies: ['_sso'],
  verifier: new JwtVerifier({ issuer: ISSUER, audiences: ['apps'], keys: { kind: 'static', text: ed.publicKey.export({ format: 'pem', type: 'spki' }).toString() } }),
};
const keysDown = new JwtVerifier({ issuer: ISSUER, audiences: ['apps'], keys: { kind: 'jwks', url: 'https://sso.test/jwks', fetch: async () => { throw new Error('down'); } } });
const upstreamIdentity = (config: Partial<UpstreamConfig> = {}) => new UpstreamIdentity({ ...CONFIG, ...config }, authority, { sighted: async () => {} });
let identity: Identity = upstreamIdentity();

function view(name: string, access: Access, kinds: CapabilityKind[] = []): RouteView {
  return {
    app: `id-${name}` as AppId, name: name as AppName, tenant: TEAM, access, status: 'registered', owner: 'user:ana' as Subject,
    release: 1 as ReleaseNumber, image: 'sha256:x' as ImageId, runtime: 'container', kinds: new Set(['route', 'static', 'ws', ...kinds]),
    bundle: { id: 'b'.repeat(64) as BundleId, files: { 'app.js': { size: APP_JS.length, etag: 'e1', contentType: 'text/javascript' } } },
    staticRoot: '', identity: kinds.includes('identity') ? {} : null, policyOverride: {},
  };
}

const VIEWS = new Map([view('open', 'public'), view('org', 'org'), view('team', 'tenant'), view('who', 'org', ['identity']), view('full', 'org')].map((v) => [v.name as string, v]));

const app = http.createServer((req, res) => {
  if (req.url === '/cookie') return void res.writeHead(200, { 'set-cookie': ['a=1; Domain=apps.test; Path=/', 'b=2; path=/; domain=.apps.test; HttpOnly'] }).end('ok');
  res.end(JSON.stringify({ url: req.url, headers: req.headers }));
}).on('upgrade', (_req, socket: net.Socket) => {
  socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: a=1; Domain=apps.test; Path=/\r\n\r\n');
});

let ingress: Ingress;
let port = 0;
let acquired = 0;

before(async () => {
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appPort = (app.address() as net.AddressInfo).port;
  ingress = new Ingress({
    registry: { view: (name) => VIEWS.get(name) ?? null, policy: () => DEFAULT_POLICY },
    runtime: {
      async acquire(id) {
        acquired += 1;
        if (id === ('id-full' as AppId)) throw new QuotaExceeded(TEAM, { resource: 'awake', used: 20, limit: 20, ask: 1 });
        return { app: id, address: `127.0.0.1:${appPort}` };
      },
      release() {},
      channel() {},
      state: () => 'awake',
    },
    identity: { identify: (req) => identity.identify(req), challenge: (req, failure) => identity.challenge(req, failure), serve: (req, res) => identity.serve(req, res) },
    authority,
    addressing: parseAppsOrigin('https://*.apps.test'),
    upstream: { header: CONFIG.header, stripCookies: CONFIG.stripCookies },
    bundles: { open: async () => Readable.from([APP_JS]) },
    scheduler: { invoke: async () => 'd-1' as DeliveryId },
    stats: [],
    async flushStats() {},
    async deleteStats() {},
    series: new Series(),
  });
  port = await ingress.listen(0, '127.0.0.1');
});

after(async () => {
  await ingress.close();
  app.closeAllConnections();
  app.close();
});

type Got = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(host: string, path: string, headers: http.OutgoingHttpHeaders = {}, method = 'GET'): Promise<Got> {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

const echo = async (host: string, headers: http.OutgoingHttpHeaders = {}) => JSON.parse((await request(host, '/echo', headers)).body);

const CALLERS: Record<string, http.OutgoingHttpHeaders> = {
  'no credential': {},
  'a user outside the tenant': { 'x-upstream-jwt': jwt('bob') },
  'a member': { 'x-upstream-jwt': jwt('ana') },
  'another tenant\'s token': { authorization: `Bearer ${serviceSecret}` },
};

const ACCESS_TABLE: [app: string, caller: string, status: number][] = [
  ['open', 'no credential', 200], ['open', 'a user outside the tenant', 200], ['open', 'a member', 200], ['open', 'another tenant\'s token', 200],
  ['org', 'no credential', 401], ['org', 'a user outside the tenant', 200], ['org', 'a member', 200], ['org', 'another tenant\'s token', 200],
  ['team', 'no credential', 401], ['team', 'a user outside the tenant', 403], ['team', 'a member', 200], ['team', 'another tenant\'s token', 403],
];

test('subdomain mode routes <name>.<domain> with the whole path and an empty X-Forwarded-Prefix (AC-K8S-10)', async () => {
  const { url, headers } = JSON.parse((await request('Open.apps.test:8443', '/apps/open/x?q=1')).body);
  assert.equal(url, '/apps/open/x?q=1');
  assert.equal(headers['x-forwarded-prefix'], '');
});

test('subdomain mode answers 404 for an unknown label, a nested label and another domain (AC-K8S-10)', async () => {
  for (const host of ['nobody.apps.test', 'a.open.apps.test', 'open.apps.example', 'apps.test']) assert.equal((await request(host, '/')).status, 404, host);
});

test('a dynamic path answers the access table (AC-ID-4)', async () => {
  for (const [name, caller, status] of ACCESS_TABLE) assert.equal((await request(`${name}.apps.test`, '/echo', CALLERS[caller])).status, status, `${name}, ${caller}`);
});

test('a static file answers the same access table (AC-ID-4)', async () => {
  acquired = 0;
  for (const [name, caller, status] of ACCESS_TABLE) assert.equal((await request(`${name}.apps.test`, '/app.js', CALLERS[caller])).status, status, `${name}, ${caller}`);
  assert.equal(acquired, 0);
});

test('a static file of a non-public app is private to the browser; a public app\'s keeps the shared cache header', async () => {
  assert.equal((await request('team.apps.test', '/app.js', CALLERS['a member'])).headers['cache-control'], 'private, no-cache');
  assert.equal((await request('open.apps.test', '/app.js')).headers['cache-control'], 'public, max-age=60');
});

test('a browser without a JWT is sent to the login URL with its absolute address (AC-ID-2)', async () => {
  const got = await request('org.apps.test', '/a?b=1', { accept: 'text/html', 'x-forwarded-proto': 'https' });
  assert.deepEqual([got.status, got.headers.location], [303, 'https://sso.test/start?rd=https%3A%2F%2Forg.apps.test%2Fa%3Fb%3D1']);
});

test('with no usable key a browser gets 503 and no redirect', async (t) => {
  identity = upstreamIdentity({ verifier: keysDown });
  t.after(() => (identity = upstreamIdentity()));
  const got = await request('org.apps.test', '/', { accept: 'text/html', 'x-upstream-jwt': jwt('ana') });
  assert.deepEqual([got.status, got.headers.location], [503, undefined]);
});

test('the identity header and the listed upstream cookies never reach the app; other cookies do (AC-ID-1)', async () => {
  const { headers } = await echo('org.apps.test', { 'x-upstream-jwt': jwt('ana'), cookie: '_sso=secret; theme=dark' });
  assert.deepEqual([headers['x-upstream-jwt'], headers.cookie], [undefined, 'theme=dark']);
  const alone = await echo('org.apps.test', { 'x-upstream-jwt': jwt('ana'), cookie: '_sso=secret' });
  assert.equal(alone.headers.cookie, undefined);
});

test('X-Pneuma-Space-Name percent-encodes non-ASCII and leaves an M1 name as it is (AC-ID-1)', async () => {
  assert.equal((await echo('who.apps.test', { 'x-upstream-jwt': jwt('lilei', '李雷 100%') })).headers['x-pneuma-space-name'], '%E6%9D%8E%E9%9B%B7 100%25');
  assert.equal((await echo('who.apps.test', { 'x-upstream-jwt': jwt('ana', 'ana@example.com') })).headers['x-pneuma-space-name'], 'ana@example.com');
});

test('Set-Cookie reaches the client without Domain (AC-ID-10)', async () => {
  const got = await request('org.apps.test', '/cookie', CALLERS['a member']);
  assert.deepEqual(got.headers['set-cookie'], ['a=1; Path=/', 'b=2; path=/; HttpOnly']);
});

test('Set-Cookie on a WebSocket upgrade response reaches the client without Domain (AC-ID-10)', async () => {
  const socket = net.connect(port, '127.0.0.1');
  socket.write(`GET / HTTP/1.1\r\nHost: org.apps.test\r\nX-Upstream-Jwt: ${jwt('ana')}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  const [head] = await once(socket, 'data');
  socket.destroy();
  assert.match(String(head), /^HTTP\/1\.1 101[\s\S]*\r\nSet-Cookie: a=1; Path=\/\r\n\r\n$/);
});

test('a wake refused by the tenant quota answers 503 with Retry-After and is not an app error', async () => {
  const counter = () => ingress.snapshot().find((s) => s.app === 'id-full') ?? { requests: 0, errors: 0 };
  const before = counter();
  const got = await request('full.apps.test', '/', CALLERS['a member']);
  assert.deepEqual([got.status, got.headers['retry-after'], got.body], [503, '30', 'tenant team-a uses 20 of its awake quota of 20; retry in 30 s\n']);
  while (counter().requests === before.requests) await sleep(10);
  assert.equal(counter().errors, before.errors);
});

test('another tenant\'s service token may call a trigger of an org app but not of a tenant app (AC-ID-9)', async () => {
  const call = (name: string) => request(`${name}.apps.test`, '/_pneuma-space/trigger/report', CALLERS['another tenant\'s token'], 'POST');
  assert.equal((await call('org')).status, 202);
  assert.equal((await call('team')).status, 403);
});
