import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { KubeClient, KubeError, tokenFile, type Pod } from './kube.ts';
import { Unavailable } from './runtimes.ts';

type Seen = { method: string; url: URL; authorization: string };

async function fake(t: TestContext, handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void): Promise<{ server: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://fake');
    seen.push({ method: req.method!, url, authorization: req.headers.authorization ?? '' });
    req.resume();
    handler(req, res, url);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const client = (server: string, timeoutMs?: number) => new KubeClient({ server, token: async () => 't', namespace: 'apps', timeoutMs });

const pod = (name: string, resourceVersion = '1'): Pod => ({ metadata: { name, resourceVersion }, spec: { containers: [{ name: 'app', image: 'i' }] } });

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('the token file is read again for every request, so a rotated token is sent', async (t) => {
  const { server, seen } = await fake(t, (_req, res) => json(res, 200, pod('p')));
  const path = join(await mkdtemp(join(tmpdir(), 'kube-')), 'token');
  await writeFile(path, 'first\n');
  const kube = new KubeClient({ server, token: tokenFile(path), namespace: 'apps' });
  await kube.get('pods', 'p');
  await writeFile(path, 'second\n');
  await kube.get('pods', 'p');
  assert.deepEqual(seen.map((s) => s.authorization), ['Bearer first', 'Bearer second']);
});

test('a 409 on Pod create throws KubeError AlreadyExists even when the body is not a Status', async (t) => {
  const { server } = await fake(t, (_req, res) => res.writeHead(409).end('conflict'));
  const error = await client(server).create('pods', pod('p')).catch((e: unknown) => e);
  assert.ok(error instanceof KubeError);
  assert.equal(error.reason, 'AlreadyExists');
});

test('a Status body becomes a KubeError with its status, reason and message', async (t) => {
  const { server } = await fake(t, (_req, res) => json(res, 422, { kind: 'Status', code: 422, reason: 'Invalid', message: 'spec.containers: Required value' }));
  const error = await client(server).create('pods', pod('p')).catch((e: unknown) => e);
  assert.ok(error instanceof KubeError);
  assert.deepEqual([error.status, error.reason, error.message], [422, 'Invalid', 'spec.containers: Required value']);
});

test('watch yields events whose bytes are split across chunks, inside a line and inside a character', async (t) => {
  const events = Buffer.from(
    `${JSON.stringify({ type: 'ADDED', object: { metadata: { name: 'p', resourceVersion: '2', labels: { note: 'café' } } } })}\n` +
      `${JSON.stringify({ type: 'DELETED', object: { metadata: { name: 'p', resourceVersion: '3' } } })}\n`,
  );
  const cut = events.indexOf('é') + 1;
  const { server } = await fake(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(events.subarray(0, cut));
    await sleep(20);
    res.write(events.subarray(cut));
  });
  const controller = new AbortController();
  const seen: string[] = [];
  for await (const event of client(server).watch('pods', { resourceVersion: '1', signal: controller.signal })) {
    seen.push(`${event.type} ${event.type === 'BOOKMARK' ? '' : event.object.metadata.labels?.note ?? ''}`);
    if (seen.length === 2) controller.abort();
  }
  assert.deepEqual(seen, ['ADDED café', 'DELETED ']);
});

test('watch on 410 Gone lists once and continues from the list resourceVersion', async (t) => {
  const { server, seen } = await fake(t, (_req, res, url) => {
    if (!url.searchParams.has('watch')) return json(res, 200, { metadata: { resourceVersion: '20' }, items: [] });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.searchParams.get('resourceVersion') === '10') {
      res.end(`${JSON.stringify({ type: 'ERROR', object: { kind: 'Status', code: 410, reason: 'Expired', message: 'too old' } })}\n`);
    } else {
      res.write(`${JSON.stringify({ type: 'ADDED', object: pod('fresh', '21') })}\n`);
    }
  });
  const controller = new AbortController();
  let first;
  for await (const event of client(server).watch('pods', { resourceVersion: '10', signal: controller.signal })) {
    first = event;
    controller.abort();
  }
  assert.equal(first?.type === 'ADDED' && first.object.metadata.name, 'fresh');
  assert.equal(seen.filter((s) => !s.url.searchParams.has('watch')).length, 1);
  assert.deepEqual(seen.filter((s) => s.url.searchParams.has('watch')).map((s) => s.url.searchParams.get('resourceVersion')), ['10', '20']);
});

test('watch ends without error when its signal aborts', async (t) => {
  const { server } = await fake(t, (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).flushHeaders());
  const controller = new AbortController();
  const done = (async () => {
    for await (const _ of client(server).watch('nodes', { signal: controller.signal }));
  })();
  await sleep(20);
  controller.abort();
  await done;
});

test('log passes tailLines and container in the query and returns the text', async (t) => {
  const { server, seen } = await fake(t, (_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('line 1\nline 2\n'));
  const text = await client(server).log('p', { tailLines: 200, container: 'app' });
  assert.equal(text, 'line 1\nline 2\n');
  assert.equal(seen[0].url.pathname, '/api/v1/namespaces/apps/pods/p/log');
  assert.deepEqual([seen[0].url.searchParams.get('tailLines'), seen[0].url.searchParams.get('container')], ['200', 'app']);
});

test('a refused connection throws Unavailable', async () => {
  const closed = http.createServer().listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = (closed.address() as AddressInfo).port;
  closed.close();
  await once(closed, 'close');
  await assert.rejects(client(`http://127.0.0.1:${port}`).list('pods'), Unavailable);
});

test('a call with no answer inside its timeout rejects as Unavailable', async (t) => {
  const { server } = await fake(t, () => {});
  await assert.rejects(client(server, 50).get('persistentvolumeclaims', 'c'), Unavailable);
});
