import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EventPage, RunnerEvent, Started, StartRequest } from './runner.ts';
import { serveBundle, startRunner, witness, type RunnerProcess } from './runner.harness.ts';

const HEALTHY = { PNEUMA_SPACE_RUNNER_WORKER_HEAP_MB: '64', PNEUMA_SPACE_RUNNER_WORKER_OFFHEAP_MB: '128' };

async function call<T>(runner: RunnerProcess, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(runner.url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return (response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text) as T;
}

type Started2 = Started & { get(path: string): Promise<string>; fire(path: string): void };

async function start(runner: RunnerProcess, bundleUrl: string, app: string, extra: Partial<StartRequest> = {}): Promise<Started2> {
  const request: StartRequest = { release: 1, spec: 's', bundleUrl, entry: 'app.mjs', env: { PNEUMA_SPACE_APP: app, PNEUMA_SPACE_RELEASE: '1' }, storage: [], readyMs: 5000, ...extra };
  const started = await call<Started>(runner, 'POST', `/instances/${app}`, request);
  const url = (path: string) => `http://127.0.0.1:${started.port}${path}`;
  return { ...started, get: async (path) => (await fetch(url(path))).text(), fire: (path) => void fetch(url(path)).catch(() => {}) };
}

async function nextEvent(runner: RunnerProcess, worker: string, timeoutMs: number): Promise<{ event: RunnerEvent; ms: number }> {
  const started = performance.now();
  for (;;) {
    const page = await call<EventPage>(runner, 'GET', '/events?after=0');
    const event = page.events.find((e) => e.worker === worker && e.ev !== 'ready');
    if (event) return { event, ms: performance.now() - started };
    assert.ok(performance.now() - started < timeoutMs, `no terminal event for ${worker} within ${timeoutMs} ms`);
    await sleep(50);
  }
}

async function drill(t: TestContext, env: Record<string, string> = {}) {
  const runner = await startRunner(t, { ...HEALTHY, ...env });
  const bundleUrl = await serveBundle(t);
  const other = await start(runner, bundleUrl, 'witness');
  const stopWitness = witness(`http://127.0.0.1:${other.port}/`);
  t.after(() => void stopWitness());
  return { runner, bundleUrl, stopWitness };
}

test('a worker starts from the bundle and answers on the port the runner reports', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'a1');
  assert.equal(await app.get('/'), 'a1 1');
});

test('a busy-looping worker is reported hung and terminated within 5 s while other workers keep answering', async (t) => {
  const { runner, bundleUrl, stopWitness } = await drill(t);
  const app = await start(runner, bundleUrl, 'loop');
  app.fire('/hang');
  const { event, ms } = await nextEvent(runner, app.worker, 5000);
  assert.equal(event.ev, 'hung');
  t.diagnostic(`hung reported after ${Math.round(ms)} ms`);
  assert.deepEqual(await call(runner, 'GET', '/instances').then((list: any) => list.map((i: any) => i.app)), ['witness']);
  assert.equal(await stopWitness(), 0);
});

test('a worker past its heap limit is reported oom while other workers keep answering', async (t) => {
  const { runner, bundleUrl, stopWitness } = await drill(t);
  const app = await start(runner, bundleUrl, 'heap');
  app.fire('/heap');
  const { event } = await nextEvent(runner, app.worker, 10_000);
  assert.deepEqual([event.ev, event.reason], ['oom', 'heap']);
  assert.equal(await stopWitness(), 0);
});

test('a worker holding Buffers past the off-heap budget is reported oom and the runner keeps running', async (t) => {
  const { runner, bundleUrl, stopWitness } = await drill(t);
  const app = await start(runner, bundleUrl, 'buffers');
  assert.equal(await app.get('/buffers'), 'held');
  const { event } = await nextEvent(runner, app.worker, 3000);
  assert.deepEqual([event.ev, event.reason], ['oom', 'offheap']);
  assert.equal((await call<{ ok: boolean }>(runner, 'GET', '/health')).ok, true);
  assert.equal(await stopWitness(), 0);
});

// Atomics.wait is not this case: terminate() interrupts it in about 1 ms (spike S4, and measured again in node:24-alpine).
test('a worker blocked in a native call is reported stuck within 10 s and a new worker for the app starts', async (t) => {
  const { runner, bundleUrl, stopWitness } = await drill(t);
  const fifo = join(runner.data, 'fifo');
  execFileSync('mkfifo', [fifo]);
  const app = await start(runner, bundleUrl, 'blocked', { env: { PNEUMA_SPACE_APP: 'blocked', PNEUMA_SPACE_RELEASE: '1', FIFO: fifo } });
  app.fire('/fifo');
  const started = performance.now();
  await nextEvent(runner, app.worker, 5000);
  for (;;) {
    const page = await call<EventPage>(runner, 'GET', '/events?after=0');
    if (page.events.some((e) => e.worker === app.worker && e.ev === 'exit' && e.reason === 'stuck')) break;
    assert.ok(performance.now() - started < 10_000, 'stuck within 10 s');
    await sleep(100);
  }
  t.diagnostic(`stuck reported after ${Math.round(performance.now() - started)} ms`);
  assert.equal((await call<{ stuck: number }>(runner, 'GET', '/health')).stuck, 1);
  const again = await start(runner, bundleUrl, 'blocked', { env: { PNEUMA_SPACE_APP: 'blocked', PNEUMA_SPACE_RELEASE: '1', FIFO: fifo } });
  assert.equal(await again.get('/'), 'blocked 1');
  assert.equal(await stopWitness(), 0);
});

test('process.kill, process.abort and child_process are unavailable inside a worker', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'escape');
  assert.deepEqual(JSON.parse(await app.get('/escape')), { kill: 'undefined', abort: 'undefined', child: 'ERR_ACCESS_DENIED' });
});

test('a storage binding is a directory under the app that {dir} names, and destroy deletes it', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const storage = [{ id: 'pneuma-space-files-s1', env: { PNEUMA_SPACE_FILES_DIR: '{dir}' } }];
  const app = await start(runner, await serveBundle(t), 's1', { storage });
  const dir = join(runner.data, 'apps', 's1', 'storage', 'pneuma-space-files-s1');
  assert.equal(await app.get('/files'), dir);
  assert.equal(readFileSync(join(dir, 'kept'), 'utf8'), 'kept');
  await call(runner, 'DELETE', '/instances/s1?drain=1000');
  await call(runner, 'DELETE', '/storage/s1/pneuma-space-files-s1');
  assert.equal(existsSync(dir), false);
});
