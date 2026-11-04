import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from './serve.ts';
import type { Context, Delivery } from './serve.ts';

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

test('identity comes from the X-Pneuma headers and is null without a subject', async () => {
  const owner = await capture('/', { headers: { 'x-pneuma-subject': 'user:ann', 'x-pneuma-name': 'Ann', 'x-pneuma-owner': '1' } });
  const anonymous = await capture('/');
  assert.deepEqual(owner.ctx?.identity, { subject: 'user:ann', name: 'Ann', owner: true });
  assert.equal(anonymous.ctx?.identity, null);
});

test('a trigger POST reaches the registered function with its delivery and answers 204', async () => {
  const got = await capture('/_pneuma/trigger/tick', {
    method: 'POST',
    headers: { 'x-pneuma-delivery': 'd1', 'x-pneuma-attempt': '2', 'x-pneuma-scheduled-for': '2026-01-01T00:00:00Z' },
  });
  assert.equal(got.status, 204);
  assert.equal(got.ctx, undefined);
  assert.deepEqual({ ...got.delivery, body: got.delivery?.body.length }, {
    id: 'd1', attempt: 2, scheduledFor: '2026-01-01T00:00:00Z', subject: null, body: 0,
  });
});
