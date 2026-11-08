import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DEFAULT_POLICY, DEFAULT_TENANT, NotFound,
  type AppId, type AppName, type BundleId, type CapabilityKind, type DeliveryId, type ImageId, type InvokeRequest,
  type Principal, type ReleaseNumber, type RouteView, type Subject, type Traffic, type TenantName,
} from './model.ts';
import { PATH_ADDRESSING } from './address.ts';
import { LOCAL_CALLER } from './authz.ts';
import { Ingress } from './ingress.ts';
import { Series } from './metrics.ts';
import { RING, requests } from './requests.ts';
import { Unavailable } from './runtimes.ts';

const APP_JS = Buffer.from('console.log("static");');

function view(name: string, kinds: CapabilityKind[], extra: Partial<RouteView> = {}): RouteView {
  return {
    app: `id-${name}` as AppId, name: name as AppName, tenant: DEFAULT_TENANT, access: 'org', status: 'registered', owner: 'user:alice' as Subject,
    release: 1 as ReleaseNumber, image: 'sha256:x' as ImageId, runtime: 'container', kinds: new Set(['route', ...kinds]), bundle: null, staticRoot: '',
    identity: kinds.includes('identity') ? {} : null, policyOverride: {}, ...extra,
  };
}

const VIEWS = new Map([
  view('plain', []),
  view('parked', []),
  view('who', ['identity']),
  view('guest', ['identity'], { identity: { required: false } }),
  view('chat', ['ws']),
  view('mixed', ['static'], { bundle: { id: 'b'.repeat(64) as BundleId, files: { 'app.js': { size: APP_JS.length, etag: 'e1', contentType: 'text/javascript' } } } }),
  view('gone', [], { status: 'removed' }),
  view('counted', [], { tenant: 'acme' as TenantName, runtime: 'isolate' }),
].map((v) => [v.name as string, v]));

const PRINCIPALS: Record<string, Principal> = {
  'Bearer alice': { subject: 'user:alice' as Subject, name: 'Alice' },
  'Bearer bob': { subject: 'user:bob' as Subject, name: 'Bob' },
  'Bearer svc': { subject: 'service:cron' as Subject, name: 'cron' },
};

// Upstream app: /echo returns what arrived, /range answers 206, /hold streams until `finish()`, /drop hangs up, WebSocket clients
// form one room except at /refuse, which answers 500.
let finish: () => void = () => {};
const room = new Set<net.Socket>();
const upstream = http.createServer((req, res) => {
  if (req.url?.startsWith('/echo')) return void res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  if (req.url === '/range') return void res.writeHead(206, { 'content-range': `bytes 2-5/10`, 'x-range': req.headers.range }).end('2345');
  if (req.url === '/hold' || req.url === '/sse') {
    res.writeHead(200, { 'content-type': req.url === '/sse' ? 'text/event-stream' : 'application/octet-stream' });
    res.write('first\n');
    finish = () => res.end('last\n');
    return;
  }
  if (req.url === '/drop') return void req.socket.destroy();
  res.writeHead(404).end();
}).on('upgrade', (req, socket: net.Socket) => {
  if (req.url === '/refuse') return void socket.end('HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\n\r\n');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  room.add(socket);
  socket.on('data', (chunk) => { for (const peer of room) if (peer !== socket) peer.write(chunk); });
  socket.on('close', () => room.delete(socket));
  socket.on('end', () => socket.end());
});

let upstreamPort = 0;
let ingress: Ingress;
let port = 0;
let events: string[] = [];
let retires: (() => void)[] = [];
let invoked: InvokeRequest[] = [];
let addresses: string[] = [];
let flushed: Traffic[][] = [];
let instance: 'asleep' | 'awake' = 'awake';
let waking: Promise<void> = Promise.resolve();
const series = new Series();

before(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
  ingress = new Ingress({
    registry: { view: (name) => VIEWS.get(name) ?? null, policy: () => DEFAULT_POLICY },
    runtime: {
      async acquire(app, kind) {
        events.push(`acquire ${kind}`);
        await waking;
        if (app === ('id-nope' as AppId)) throw new NotFound('no run spec');
        if (app === ('id-parked' as AppId)) throw new Unavailable('isolate');
        return { app, address: addresses.shift() ?? `127.0.0.1:${upstreamPort}` };
      },
      release: () => void events.push('release'),
      state: () => instance,
      channel: (_lease, onRetire) => {
        events.push('channel');
        retires.push(onRetire);
      },
    },
    identity: {
      async identify(req) {
        const who = PRINCIPALS[req.headers.authorization ?? ''];
        return who ? { via: 'local', ...who } : 'absent';
      },
      challenge: () => ({ status: 401 }),
      async serve(_req, res) {
        res.end('login page');
      },
    },
    authority: { callerOf: async () => LOCAL_CALLER },
    addressing: PATH_ADDRESSING,
    upstream: null,
    bundles: { open: async () => Readable.from([APP_JS]) },
    scheduler: {
      async invoke(request) {
        if (request.trigger !== 'report') throw new NotFound('undeclared');
        invoked.push(request);
        return 'd-1' as DeliveryId;
      },
    },
    stats: [],
    flushStats: async (stats) => void flushed.push(stats),
    async deleteStats() {},
    series,
  });
  port = await ingress.listen(0, '127.0.0.1');
});

after(async () => {
  await ingress.close();
  upstream.closeAllConnections();
  upstream.close();
});

function reset(): void {
  events = [];
  retires = [];
  invoked = [];
  flushed = [];
}

type Got = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(path: string, init: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject).end(init.body);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await sleep(10);
  assert.ok(predicate(), `timed out; events: ${events.join(', ')}`);
}

const lastSeq = () => requests.after(0, RING).at(-1)?.seq ?? 0;

async function websocket(path: string): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  const [head] = await once(socket, 'data');
  assert.match(String(head), /^HTTP\/1\.1 101/);
  return socket;
}

/** Holds every acquire until the returned function is called. */
function holdWakes(): () => void {
  let open = () => {};
  waking = new Promise((resolve) => (open = resolve));
  return open;
}

const frame = (text: string) => Buffer.concat([Buffer.from([0x81, text.length]), Buffer.from(text)]);

test('forged X-Pneuma-Space headers never reach the app (AC-FORM-2)', async () => {
  const got = await request('/apps/plain/echo', { headers: { 'x-pneuma-space-subject': 'user:alice', 'X-Pneuma-Space-Owner': '1', 'x-forwarded-prefix': '/evil' } });
  const { headers } = JSON.parse(got.body);
  assert.equal(headers['x-pneuma-space-subject'], undefined);
  assert.equal(headers['x-pneuma-space-owner'], undefined);
  assert.equal(headers['x-forwarded-prefix'], '/apps/plain');
});

test('forged headers spelled with underscores never reach the app (INV-5)', async () => {
  const got = await request('/apps/guest/echo', { headers: { X_Pneuma_Space_Subject: 'user:alice', 'x-pneuma_space-owner': '1' } });
  const forged = Object.keys(JSON.parse(got.body).headers).filter((name) => name.replaceAll('_', '-').startsWith('x-pneuma-space-'));
  assert.deepEqual(forged, []);
});

test('the identity provider\'s subject reaches the app in place of a forged one (AC-FORM-2)', async () => {
  const got = await request('/apps/who/echo?q=1', { headers: { authorization: 'Bearer bob', 'x-pneuma-space-subject': 'user:alice' } });
  const { url, headers } = JSON.parse(got.body);
  assert.equal(url, '/echo?q=1');
  assert.equal(headers['x-pneuma-space-subject'], 'user:bob');
  assert.equal(headers['x-pneuma-space-name'], 'Bob');
});

test('X-Pneuma-Space-Owner is set only for the owner (AC-FORM-3)', async () => {
  const owner = JSON.parse((await request('/apps/who/echo', { headers: { authorization: 'Bearer alice' } })).body);
  const other = JSON.parse((await request('/apps/who/echo', { headers: { authorization: 'Bearer bob', 'x-pneuma-space-owner': '1' } })).body);
  assert.equal(owner.headers['x-pneuma-space-owner'], '1');
  assert.equal(other.headers['x-pneuma-space-owner'], undefined);
});

test('an unauthenticated caller of an identity app gets the provider\'s challenge', async () => {
  reset();
  assert.equal((await request('/apps/who/echo')).status, 401);
  assert.deepEqual(events, []);
});

test('an anonymous visitor of an app with identity required false reaches it with no identity headers', async () => {
  reset();
  const got = await request('/apps/guest/echo', { headers: { 'x-pneuma-space-subject': 'user:alice' } });
  assert.equal(got.status, 200);
  const { headers } = JSON.parse(got.body);
  assert.equal(headers['x-pneuma-space-subject'], undefined);
  assert.equal(headers['x-pneuma-space-name'], undefined);
  assert.equal(headers['x-pneuma-space-owner'], undefined);
});

test('a signed-in visitor of an app with identity required false still gets the identity headers', async () => {
  const { headers } = JSON.parse((await request('/apps/guest/echo', { headers: { authorization: 'Bearer alice' } })).body);
  assert.equal(headers['x-pneuma-space-subject'], 'user:alice');
  assert.equal(headers['x-pneuma-space-owner'], '1');
});

test('Range reaches the app unchanged and its 206 comes back unchanged', async () => {
  const got = await request('/apps/plain/range', { headers: { range: 'bytes=2-5' } });
  assert.equal(got.status, 206);
  assert.equal(got.headers['x-range'], 'bytes=2-5');
  assert.equal(got.headers['content-range'], 'bytes 2-5/10');
  assert.equal(got.body, '2345');
});

test('two WebSocket clients talk through the app on channel leases released at close (AC-COLLAB-1)', async () => {
  reset();
  const [a, b] = [await websocket('/apps/chat/'), await websocket('/apps/chat/')];
  await waitFor(() => room.size === 2);
  a.write(frame('hello'));
  const [got] = await once(b, 'data');
  assert.deepEqual(got, frame('hello'));
  assert.deepEqual(events, ['acquire request', 'channel', 'acquire request', 'channel']);
  a.end();
  b.end();
  await waitFor(() => events.filter((e) => e === 'release').length === 2);
});

test('on_retire closes an open WebSocket with 1001 (AC-COLLAB-4)', async () => {
  reset();
  const client = await websocket('/apps/chat/');
  const received: Buffer[] = [];
  client.on('data', (c: Buffer) => received.push(c));
  retires[0]();
  await once(client, 'end');
  assert.deepEqual(Buffer.concat(received), Buffer.from([0x88, 0x02, 0x03, 0xe9]));
  await waitFor(() => events.includes('release'));
  client.destroy();
});

test('an undeclared ws capability answers 426', async () => {
  const socket = net.connect(port, '127.0.0.1');
  socket.write('GET /apps/plain/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [head] = await once(socket, 'data');
  assert.match(String(head), /^HTTP\/1\.1 426/);
  socket.destroy();
});

test('an SSE response holds a channel lease until the stream ends', async () => {
  reset();
  const res = await new Promise<http.IncomingMessage>((resolve) => http.get({ host: '127.0.0.1', port, path: '/apps/plain/sse' }, resolve));
  await once(res, 'data');
  assert.deepEqual(events, ['acquire request', 'channel']);
  finish();
  res.resume();
  await once(res, 'end');
  await waitFor(() => events.includes('release'));
});

test('a client that disconnects mid-response leaves the lease until the app finishes', async () => {
  reset();
  const req = http.get({ host: '127.0.0.1', port, path: '/apps/plain/hold' });
  const [res] = await once(req, 'response') as [http.IncomingMessage];
  await once(res, 'data');
  req.destroy();
  await sleep(100);
  assert.deepEqual(events, ['acquire request']);
  finish();
  await waitFor(() => events.includes('release'));
});

test('a refused connect is retried once with a fresh lease', async () => {
  reset();
  const dead = net.createServer();
  await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
  addresses = [`127.0.0.1:${(dead.address() as net.AddressInfo).port}`];
  dead.close();
  const got = await request('/apps/plain/echo');
  assert.equal(got.status, 200);
  assert.deepEqual(events.slice(0, 3), ['acquire request', 'release', 'acquire request']);
});

test('a bundle file is served without acquiring and other paths wake the app (AC-STATIC-3, INV-10)', async () => {
  reset();
  const file = await request('/apps/mixed/app.js');
  assert.equal(file.body, APP_JS.toString());
  assert.equal(file.headers.etag, '"e1"');
  assert.deepEqual(events, []);
  assert.equal((await request('/apps/mixed/api/x')).status, 404);
  assert.deepEqual(events.slice(0, 1), ['acquire request']);
});

test('a removed app answers 404 on every path', async () => {
  for (const path of ['/apps/gone', '/apps/gone/', '/apps/gone/x', '/apps/gone/_pneuma-space/trigger/report']) {
    assert.equal((await request(path, { method: path.includes('trigger') ? 'POST' : 'GET' })).status, 404, path);
  }
});

test('a missing trailing slash redirects with 308 and an unknown app is 404', async () => {
  const got = await request('/apps/plain?x=1');
  assert.equal(got.status, 308);
  assert.equal(got.headers.location, '/apps/plain/?x=1');
  assert.equal((await request('/apps/nobody/')).status, 404);
});

test('dot segments resolve before routing, so none reaches the app under _pneuma-space/ or above its root', async () => {
  reset();
  for (const path of ['/apps/plain/a/../_pneuma-space/trigger/report', '/apps/plain/a/%2e%2E/_pneuma-space/trigger/report', '/apps/plain/a\\..\\_pneuma-space/trigger/report']) {
    assert.equal((await request(path, { method: 'POST' })).status, 401, path);
  }
  assert.equal((await request('/apps/plain/a/../../plain/echo')).status, 400);
  assert.deepEqual(events, []);
});

test('a trigger call without a service subject or the owner is 403', async () => {
  reset();
  const got = await request('/apps/plain/_pneuma-space/trigger/report', { method: 'POST', headers: { authorization: 'Bearer bob' } });
  assert.equal(got.status, 403);
  assert.deepEqual(invoked, []);
});

test('a service trigger call becomes a delivery with its Idempotency-Key and body', async () => {
  reset();
  const got = await request('/apps/plain/_pneuma-space/trigger/report', {
    method: 'POST', headers: { authorization: 'Bearer svc', 'idempotency-key': 'k1' }, body: 'payload',
  });
  assert.equal(got.status, 202);
  assert.deepEqual(JSON.parse(got.body), { delivery: 'd-1' });
  assert.equal(invoked[0].caller, 'service:cron');
  assert.equal(invoked[0].idempotencyKey, 'k1');
  assert.equal(Buffer.from(invoked[0].body).toString(), 'payload');
  assert.deepEqual(events, []);
});

test('stats count every request to an app, static included, and flush hands them over', async () => {
  reset();
  const before = ingress.snapshot().find((s) => s.app === 'id-mixed')?.requests ?? 0;
  await request('/apps/mixed/app.js');
  await request('/apps/mixed/app.js');
  await ingress.flush();
  const mixed = flushed[0].find((s) => s.app === 'id-mixed')!;
  assert.equal(mixed.requests, before + 2);
  assert.ok(mixed.lastAccessAt! > Date.now() - 5000);
});

test('the gateway-root login page is delegated to the identity provider', async () => {
  assert.equal((await request('/_pneuma-space/login?next=/apps/who/')).body, 'login page');
});

test('a proxied request leaves one record with its status and whether it found the app asleep (AC-P-15)', async () => {
  const from = lastSeq();
  instance = 'asleep';
  await request('/apps/plain/echo?x=1');
  instance = 'awake';
  await waitFor(() => requests.after(from, RING).length === 1);
  const [record] = requests.after(from, RING);
  assert.deepEqual([record.app, record.kind, record.path, record.status, record.cold], ['id-plain', 'request', '/apps/plain/echo', 200, true]);
  assert.ok(record.waitMs! <= record.ms);
});

test('a WebSocket leaves one ws record when it closes, with how long it was open (AC-P-15)', async () => {
  const from = lastSeq();
  const socket = await websocket('/apps/chat/');
  await sleep(120);
  assert.deepEqual(requests.after(from, RING), []);
  socket.end();
  await waitFor(() => requests.after(from, RING).length === 1);
  const [record] = requests.after(from, RING);
  assert.deepEqual([record.kind, record.status], ['ws', 101]);
  assert.ok(record.ms >= 120, `${record.ms} ms`);
});

test('a client that gives up during the wake is recorded as unanswered, counted but not as an error (AC-P-15)', async () => {
  reset();
  const from = lastSeq();
  const errors = ingress.snapshot().find((s) => s.app === 'id-plain')?.errors ?? 0;
  const wake = holdWakes();
  const req = http.request({ host: '127.0.0.1', port, path: '/apps/plain/echo' }).on('error', () => {});
  req.end();
  await waitFor(() => events.includes('acquire request'));
  req.destroy();
  await waitFor(() => requests.after(from, RING).length === 1);
  wake();
  const [record] = requests.after(from, RING);
  assert.deepEqual([record.status, record.error], [0, 'client closed the connection']);
  assert.equal(ingress.snapshot().find((s) => s.app === 'id-plain')!.errors, errors);
});

test('a WebSocket closed during the wake leaves one unanswered ws record (AC-P-15)', async () => {
  reset();
  const from = lastSeq();
  const wake = holdWakes();
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {}).write('GET /apps/chat/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await waitFor(() => events.includes('acquire request'));
  socket.destroy();
  await waitFor(() => requests.after(from, RING).length === 1);
  wake();
  await waitFor(() => events.includes('release'));
  const records = requests.after(from, RING);
  assert.deepEqual(records.map((r) => [r.kind, r.status, r.error]), [['ws', 0, 'client closed the connection']]);
});

test('a WebSocket upgrade the app refuses is recorded with the app\'s status (AC-P-15)', async () => {
  const from = lastSeq();
  const socket = net.connect(port, '127.0.0.1');
  socket.write('GET /apps/chat/refuse HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [head] = await once(socket, 'data');
  assert.match(String(head), /^HTTP\/1\.1 500/);
  socket.destroy();
  await waitFor(() => requests.after(from, RING).length === 1);
  assert.deepEqual(requests.after(from, RING).map((r) => [r.kind, r.status]), [['ws', 500]]);
});

test('a request the app hangs up on is recorded as a 502 with the reason (AC-P-15)', async () => {
  const from = lastSeq();
  assert.equal((await request('/apps/plain/drop')).status, 502);
  await waitFor(() => requests.after(from, RING).length === 1);
  const [record] = requests.after(from, RING);
  assert.equal(record.status, 502);
  assert.match(record.error ?? '', /socket hang up|ECONNRESET/);
});

test('a runtime without an implementation answers 503 with the start-the-profile message', async () => {
  const got = await request('/apps/parked/');
  assert.deepEqual([got.status, JSON.parse(got.body).error], [503, 'runtime isolate is not available; start docker compose --profile isolate']);
});

test('a Guard answer counts as a request but not as an app error', async () => {
  const before = ingress.snapshot().find((s) => s.app === 'id-parked') ?? { requests: 0, errors: 0 };
  await request('/apps/parked/');
  await waitFor(() => (ingress.snapshot().find((s) => s.app === 'id-parked')?.requests ?? 0) > before.requests);
  const after = ingress.snapshot().find((s) => s.app === 'id-parked')!;
  assert.deepEqual([after.requests - before.requests, after.errors], [1, before.errors]);
});

test('a request counts under its tenant, runtime and kind', async () => {
  await request('/apps/counted/echo');
  await waitFor(() => series.render().includes('pneuma_space_requests_total{tenant="acme",runtime="isolate",kind="request"} 1\n'));
});
