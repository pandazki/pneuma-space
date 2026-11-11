import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { serve } from './serve.ts';
import type { Context, Delivery } from './serve.ts';
import { ws } from './ws.ts';

// The gateway's rule from docs/app-contract.md: `%`, control characters and non-ASCII bytes as percent-encoded UTF-8, every other byte literal.
const encode = (name: string) =>
  name.replace(/[\x00-\x1f%\x7f-\u{10ffff}]/gu, (ch) => [...Buffer.from(ch)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''));
const NAMES = ['alice', '审查用户', '100% real', 'a+b c', '日本語 & <b>', 'Ünï %41 码'];
const signedIn = (name: string) => ({ 'x-pneuma-space-subject': 'user:ann', 'x-pneuma-space-name': name });

async function capture(path: string, init: RequestInit = {}) {
  const seen: { ctx?: Context; delivery?: Delivery } = {};
  const server = serve((ctx) => void ((seen.ctx = ctx), ctx.res.end()), {
    port: 0,
    triggers: { tick: (delivery) => void (seen.delivery = delivery) },
  });
  await once(server, 'listening');
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init);
  await res.arrayBuffer();
  server.close();
  return { status: res.status, ...seen };
}

test('url is relative to the app address whether or not the prefix was already stripped', async () => {
  const headers = { 'x-forwarded-prefix': '/apps/demo' };
  const full = await capture('/apps/demo/items?page=2', { headers });
  const stripped = await capture('/items?page=2', { headers });
  assert.equal(full.ctx?.prefix, '/apps/demo');
  assert.equal(full.ctx && full.ctx.url.pathname + full.ctx.url.search, '/items?page=2');
  assert.equal(stripped.ctx && stripped.ctx.url.pathname + stripped.ctx.url.search, '/items?page=2');
});

test('identity comes from the X-Pneuma-Space headers and is null without a subject', async () => {
  const owner = await capture('/', { headers: { 'x-pneuma-space-subject': 'user:ann', 'x-pneuma-space-name': 'Ann', 'x-pneuma-space-owner': '1' } });
  const anonymous = await capture('/');
  assert.deepEqual(owner.ctx?.identity, { subject: 'user:ann', name: 'Ann', owner: true });
  assert.equal(anonymous.ctx?.identity, null);
});

test('the display name is the gateway-encoded header decoded', async () => {
  for (const name of NAMES) assert.equal((await capture('/', { headers: signedIn(encode(name)) })).ctx?.identity?.name, name);
});

test('a WebSocket upgrade gets the same display name as a request, decoded once', async () => {
  let connected = (_name: string) => {};
  let requested = '';
  const server = serve((ctx) => void ((requested = ctx.identity!.name), ctx.res.end()), { port: 0 });
  ws(server, (socket) => connected(socket.identity!.name));
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  try {
    for (const name of NAMES) {
      await (await fetch(`http://127.0.0.1:${port}/`, { headers: signedIn(encode(name)) })).arrayBuffer();
      const upgraded = new Promise<string>((resolve) => (connected = resolve));
      const client = net.connect(port, '127.0.0.1');
      client.write(
        'GET /live HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          `X-Pneuma-Space-Subject: user:ann\r\nX-Pneuma-Space-Name: ${encode(name)}\r\n\r\n`,
      );
      const upgradedName = await upgraded;
      client.destroy();
      assert.deepEqual([requested, upgradedName], [name, name]);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('a name header that is not valid percent-encoding is kept as sent and the request is served', async () => {
  for (const raw of ['%', '%E5%AE', '%ZZ']) {
    const got = await capture('/', { headers: signedIn(raw) });
    assert.deepEqual([got.status, got.ctx?.identity?.name], [200, raw]);
  }
});

test('a trigger POST reaches the registered function with its delivery and answers 204', async () => {
  const got = await capture('/_pneuma-space/trigger/tick', {
    method: 'POST',
    headers: { 'x-pneuma-space-delivery': 'd1', 'x-pneuma-space-attempt': '2', 'x-pneuma-space-scheduled-for': '2026-01-01T00:00:00Z' },
  });
  assert.equal(got.status, 204);
  assert.equal(got.ctx, undefined);
  assert.deepEqual({ ...got.delivery, body: got.delivery?.body.length }, {
    id: 'd1', attempt: 2, scheduledFor: '2026-01-01T00:00:00Z', subject: null, body: 0,
  });
});
