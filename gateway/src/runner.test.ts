import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EventPage, Listed, RunnerEvent, Started, StartRequest } from './runner.ts';
import { serveBundle, startRunner, witness, type RunnerProcess } from './runner.harness.ts';

/** The fixture reaches the shim's port and Node's internal one through async_hooks, as any app can. */
const reach = (app: string, extra: Record<string, string> = {}) => ({ env: { PNEUMA_SPACE_APP: app, PNEUMA_SPACE_RELEASE: '1', REACH: '1', ...extra } });

const HEALTHY = { PNEUMA_SPACE_RUNNER_WORKER_HEAP_MB: '64', PNEUMA_SPACE_RUNNER_WORKER_OFFHEAP_MB: '128' };

async function call<T>(runner: RunnerProcess, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(runner.url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return (response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text) as T;
}

type Started2 = Started & { get(path: string): Promise<string>; fire(path: string): void };

async function start(runner: RunnerProcess, bundleUrl: string, app: string, extra: Partial<StartRequest> = {}): Promise<Started2> {
  const request: StartRequest = { release: 1, spec: 's', bundleUrl, entry: 'app.mjs', env: { PNEUMA_SPACE_APP: app, PNEUMA_SPACE_RELEASE: '1' }, storage: [], heapMb: 1024, readyMs: 5000, ...extra };
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

/** A terminated worker's server stops accepting; a hung or stuck one's still completes the TCP handshake. */
async function closed(port: number, timeoutMs = 2000): Promise<boolean> {
  for (const end = performance.now() + timeoutMs; performance.now() < end; await sleep(50)) {
    const refused = await new Promise<boolean>((ok) => {
      const socket = connect(port, '127.0.0.1').once('connect', () => { socket.destroy(); ok(false); }).once('error', () => ok(true));
    });
    if (refused) return true;
  }
  return false;
}

function fifo(runner: RunnerProcess): string {
  const path = join(runner.data, 'fifo');
  execFileSync('mkfifo', [path]);
  return path;
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
  assert.ok(await closed(app.port), 'the hung worker is terminated');
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
  assert.ok(await closed(app.port), 'the worker over budget is terminated');
  assert.equal((await call<{ ok: boolean }>(runner, 'GET', '/health')).ok, true);
  assert.equal(await stopWitness(), 0);
});

test('a start asking more memory than the runner\'s caps runs at the caps and reports them', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'greedy', { heapMb: 1024 });
  assert.deepEqual([app.heapMb, app.offheapMb], [64, 128]);
});

test('a worker started with memory_mb 64 under higher caps is ended oom holding Buffers past 64 MiB (AC-OPS-3)', async (t) => {
  const runner = await startRunner(t, { PNEUMA_SPACE_RUNNER_WORKER_HEAP_MB: '64', PNEUMA_SPACE_RUNNER_WORKER_OFFHEAP_MB: '512' });
  const app = await start(runner, await serveBundle(t), 'small', { heapMb: 64 });
  assert.equal(await app.get('/buffers'), 'held');
  const { event } = await nextEvent(runner, app.worker, 3000);
  assert.deepEqual([event.ev, event.reason], ['oom', 'offheap']);
});

// Atomics.wait is not this case: terminate() interrupts it in about 1 ms (spike S4, and measured again in node:24-alpine).
test('a worker blocked in a native call is reported stuck within 10 s and a new worker for the app starts', async (t) => {
  const { runner, bundleUrl, stopWitness } = await drill(t);
  const env = { PNEUMA_SPACE_APP: 'blocked', PNEUMA_SPACE_RELEASE: '1', FIFO: fifo(runner) };
  const app = await start(runner, bundleUrl, 'blocked', { env });
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
  const again = await start(runner, bundleUrl, 'blocked', { env });
  assert.equal(await again.get('/'), 'blocked 1');
  assert.equal(await stopWitness(), 0);
});

test('a stuck count past PNEUMA_SPACE_RUNNER_STUCK_LIMIT aborts the runner', async (t) => {
  const runner = await startRunner(t, { ...HEALTHY, PNEUMA_SPACE_RUNNER_STUCK_LIMIT: '0' });
  const app = await start(runner, await serveBundle(t), 'blocked', { env: { FIFO: fifo(runner) } });
  app.fire('/fifo');
  assert.equal(await Promise.race([runner.exited, sleep(12_000, 'still running')]), 'SIGABRT');
});

const post = (runner: RunnerProcess, app: string, request: StartRequest) => fetch(`${runner.url}/instances/${app}`, { method: 'POST', body: JSON.stringify(request) });

test('a worker blocked before it listens fails its start at the ready timeout', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const request: StartRequest = { release: 1, spec: 's', bundleUrl: await serveBundle(t), entry: 'app.mjs', env: { START_FIFO: fifo(runner) }, storage: [], heapMb: 1024, readyMs: 6000 };
  const response = await post(runner, 'blocked', request);
  assert.deepEqual([response.status, (await response.json()).error], [502, 'worker did not listen on PNEUMA_SPACE_PORT within 6000 ms']);
});

test('a hung worker that is also stopped while it is being terminated counts once as stuck', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'blocked', { env: { FIFO: fifo(runner) } });
  app.fire('/fifo');
  await nextEvent(runner, app.worker, 5000);
  await call(runner, 'DELETE', '/instances/blocked?drain=0');
  const page = await call<EventPage>(runner, 'GET', '/events?after=0');
  assert.deepEqual(page.events.filter((e) => e.worker === app.worker && e.ev !== 'ready').map((e) => [e.ev, e.reason]), [['hung', 'no answer to the watchdog for 3000 ms'], ['exit', 'stuck']]);
  assert.equal((await call<{ stuck: number }>(runner, 'GET', '/health')).stuck, 1);
});

test('a worker past the off-heap budget before it listens is ended oom inside the ready timeout', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const started = performance.now();
  const response = await post(runner, 'early', { release: 1, spec: 's', bundleUrl: await serveBundle(t), entry: 'app.mjs', env: { START_BUFFERS: '1' }, storage: [], heapMb: 1024, readyMs: 8000 });
  assert.equal(response.status, 502);
  assert.ok(performance.now() - started < 8000, 'ended before the ready timeout');
  const page = await call<EventPage>(runner, 'GET', '/events?after=0');
  assert.deepEqual(page.events.map((e) => [e.ev, e.reason]), [['oom', 'offheap']]);
});

test('a worker that runs 5 s of synchronous startup inside its ready timeout starts and is not reported hung', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'slow', { env: { PNEUMA_SPACE_APP: 'slow', PNEUMA_SPACE_RELEASE: '1', START_BUSY_MS: '5000' }, readyMs: 8000 });
  assert.equal(await app.get('/'), 'slow 1');
});

test('process.kill, process.abort and child_process are unavailable inside a worker', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'escape');
  assert.deepEqual(JSON.parse(await app.get('/escape')), { kill: 'undefined', abort: 'undefined', child: 'ERR_ACCESS_DENIED' });
});

// A nested worker gets a fresh process object, so the shim's removal of process.kill would not reach it.
test('new Worker throws inside a worker and the runner keeps running', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'nested');
  assert.deepEqual(JSON.parse(await app.get('/worker')), { imported: 'ERR_ACCESS_DENIED', builtin: 'ERR_ACCESS_DENIED' });
  await sleep(500);
  assert.equal((await call<{ ok: boolean }>(runner, 'GET', '/health')).ok, true);
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

test('module.register throws inside a worker and the runner keeps running', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'hooks');
  assert.equal(await app.get('/register'), 'ERR_ACCESS_DENIED');
  await sleep(500);
  assert.equal((await call<{ ok: boolean }>(runner, 'GET', '/health')).ok, true);
});

test('an app that listens on another server first is reached on PNEUMA_SPACE_PORT', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'decoy', { env: { PNEUMA_SPACE_APP: 'decoy', PNEUMA_SPACE_RELEASE: '1', DECOY: '1' } });
  assert.equal(await app.get('/'), 'decoy 1');
});

test('lines past a worker\'s log budget are dropped with one notice', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'blank');
  assert.equal(await app.get('/blank'), 'printed');
  for (const end = performance.now() + 5000; ; await sleep(50)) {
    if (/dropped \d+ lines$/.test(await call<string>(runner, 'GET', '/logs/blank?tail=200000'))) break;
    assert.ok(performance.now() < end, 'the drop notice arrived');
  }
});

// The shim lets 1024 empty lines a second through, and the notice is one more.
test('100 000 empty lines leave at most 1000 log entries', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'blank');
  assert.equal(await app.get('/blank'), 'printed');
  await sleep(2000);
  const entries = (await call<string>(runner, 'GET', '/logs/blank?tail=200000')).split('\n').length;
  assert.ok(entries <= 1000, `${entries} entries`);
});

test('a .tmp- directory a killed extraction left is swept at runner start', async (t) => {
  const first = await startRunner(t, HEALTHY);
  const tmp = join(first.data, 'apps', 'a1', '.tmp-1-1');
  mkdirSync(tmp, { recursive: true });
  await first.stop();
  await startRunner(t, HEALTHY, first.data);
  assert.equal(existsSync(tmp), false);
});

test('a bundle download that does not finish fails the start at the ready timeout', { timeout: 5000 }, async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const silent = createServer(() => {}).listen(0, '127.0.0.1');
  t.after(() => { silent.closeAllConnections(); silent.close(); });
  await once(silent, 'listening');
  const response = await post(runner, 'slow', { release: 1, spec: 's', bundleUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/b.tar`, entry: 'app.mjs', env: {}, storage: [], heapMb: 1024, readyMs: 1000 });
  assert.deepEqual([response.status, (await response.json()).error], [502, 'bundle download did not finish within the ready timeout']);
});

test('two starts of one app at once get the same worker', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const bundleUrl = await serveBundle(t);
  const [a, b] = await Promise.all([start(runner, bundleUrl, 'twice'), start(runner, bundleUrl, 'twice')]);
  assert.equal(a.worker, b.worker);
});

test('v8.setFlagsFromString throws inside a worker and the runner keeps running', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'flags');
  assert.equal(await app.get('/flags'), 'ERR_ACCESS_DENIED');
  await sleep(500);
  assert.equal((await call<{ ok: boolean }>(runner, 'GET', '/health')).ok, true);
});

test('parentPort is null inside a worker', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'parent');
  assert.equal(await app.get('/parent'), 'null');
});

/** The slowest answer to /health while `work` runs: the delay the runner's main thread adds to every worker's pong. */
async function stall(runner: RunnerProcess, work: Promise<unknown>): Promise<number> {
  let done = false;
  void work.finally(() => { done = true; });
  let worst = 0;
  for (const end = performance.now() + 3000; !done || performance.now() < end; await sleep(20)) {
    const sent = performance.now();
    await call(runner, 'GET', '/health');
    worst = Math.max(worst, performance.now() - sent);
  }
  return worst;
}

test('a worker writing 64 MiB to stdout in one call delays the runner\'s main thread by under 500 ms', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'burst');
  const worst = await stall(runner, app.get('/burst'));
  t.diagnostic(`slowest /health during the burst: ${Math.round(worst)} ms`);
  assert.ok(worst < 500, `${Math.round(worst)} ms`);
});

test('a worker writing 64 MiB to stdout in one call leaves at most 256 KiB in its log', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'burst');
  assert.equal(await app.get('/burst'), 'written');
  await sleep(1500);
  const logs = await call<string>(runner, 'GET', '/logs/burst?tail=1000000');
  assert.ok(Buffer.byteLength(logs) <= 256 * 2 ** 10, `${Buffer.byteLength(logs)} bytes`);
});

// Each stall delays a 1 s tick by more than 1 s whatever its phase, which reset every ping under the earlier pause-gap rule.
test('a hung worker is reported within 10 s while the runner stalls 2.05 s every 4.5 s', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'loop');
  let stalling = true;
  const stalls = (async () => {
    while (stalling) {
      await sleep(2450);
      process.kill(runner.pid, 'SIGSTOP');
      await sleep(2050);
      process.kill(runner.pid, 'SIGCONT');
    }
  })();
  app.fire('/hang');
  const { event, ms } = await nextEvent(runner, app.worker, 10_000).finally(() => { stalling = false; return stalls; });
  t.diagnostic(`hung reported after ${Math.round(ms)} ms`);
  assert.equal(event.ev, 'hung');
});

test('a runner stopped for 10 s while a worker is 1.5 s busy reports no worker hung once it continues', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'paused');
  app.fire('/busy');
  // Past one tick, so a ping is outstanding when the runner stops.
  await sleep(1100);
  process.kill(runner.pid, 'SIGSTOP');
  await sleep(10_000);
  process.kill(runner.pid, 'SIGCONT');
  await sleep(4000);
  const page = await call<EventPage>(runner, 'GET', '/events?after=0');
  assert.deepEqual(page.events.filter((e) => e.worker === app.worker && e.ev !== 'ready'), []);
});

test('/instances lists a worker that has not listened yet as starting', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  void post(runner, 'early', { release: 1, spec: 's', bundleUrl: await serveBundle(t), entry: 'app.mjs', env: { START_BUSY_MS: '2000' }, storage: [], heapMb: 1024, readyMs: 5000 }).catch(() => {});
  let listed: Listed[] = [];
  for (const end = performance.now() + 3000; listed.length === 0; await sleep(50)) {
    assert.ok(performance.now() < end, 'the worker is listed');
    listed = await call<Listed[]>(runner, 'GET', '/instances');
  }
  assert.deepEqual(listed.map((i) => [i.state, i.port]), [['starting', null]]);
});

test('a worker that logs in a 1.5 s console.log loop stays inside its 64 MiB heap', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'chatter');
  assert.equal(await app.get('/chatter'), 'printed');
  const page = await call<EventPage>(runner, 'GET', '/events?after=0');
  assert.deepEqual(page.events.filter((e) => e.ev !== 'ready'), []);
});

test('a line written in several writes is one log entry', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'partial');
  assert.equal(await app.get('/partial'), 'written');
  let logs = '';
  for (const end = performance.now() + 2000; !logs.includes('tial'); await sleep(50)) {
    assert.ok(performance.now() < end, 'the line arrived');
    logs = await call<string>(runner, 'GET', '/logs/partial');
  }
  assert.ok(logs.split('\n').includes('partial'), JSON.stringify(logs));
});

test('an app that patches every MessagePort prototype method is not handed the shim\'s port through them', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'patched');
  assert.equal(await app.get('/patched'), 'false');
});

test('process.stdin, stdout, stderr and the console\'s streams have no kPort property', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'stdio');
  assert.equal(await app.get('/stdio'), '[]');
});

test('a forged message from a worker is ignored and counted', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'forger', reach('forger'));
  assert.equal(await app.get('/forge'), 'posted');
  assert.equal((await nextEvent(runner, app.worker, 2000)).event.ev, 'forged');
  assert.equal((await call<{ forged: number }>(runner, 'GET', '/health')).forged, 1);
  assert.equal(await app.get('/'), 'forger 1');
});

test('a worker that sends three forged messages is ended as forged', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'forger', reach('forger'));
  for (let i = 0; i < 3; i++) await app.get('/forge').catch(() => {});
  let ends: (string | undefined)[][] = [];
  for (const end = performance.now() + 3000; !ends.some(([ev]) => ev === 'exit'); await sleep(50)) {
    assert.ok(performance.now() < end, 'the worker is ended');
    ends = (await call<EventPage>(runner, 'GET', '/events?after=0')).events.filter((e) => e.ev !== 'ready').map((e) => [e.ev, e.reason]);
  }
  assert.deepEqual(ends, [['forged', undefined], ['forged', undefined], ['forged', undefined], ['exit', 'forged']]);
});

test('a bogus message on a worker\'s stdio port leaves the runner and the other workers running', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const bundleUrl = await serveBundle(t);
  const other = await start(runner, bundleUrl, 'other');
  const app = await start(runner, bundleUrl, 'bogus', reach('bogus'));
  assert.equal(await app.get('/bogus'), 'posted');
  for (const end = performance.now() + 2000; (await call<{ internal: number }>(runner, 'GET', '/health')).internal === 0; await sleep(50)) {
    assert.ok(performance.now() < end, 'the fault was counted');
  }
  assert.equal(await other.get('/'), 'other 1');
});

test('a forged listening with another app\'s port is counted and the forger\'s route answers the forger', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const bundleUrl = await serveBundle(t);
  const victim = await start(runner, bundleUrl, 'victim');
  const forger = await start(runner, bundleUrl, 'forger', reach('forger', { HIJACK: String(victim.port) }));
  assert.equal(await forger.get('/'), 'forger 1');
  const page = await call<EventPage>(runner, 'GET', '/events?after=0');
  assert.deepEqual(page.events.filter((e) => e.worker === forger.worker && e.ev !== 'ready').map((e) => e.ev), ['forged']);
});

test('a forged worker error on Node\'s internal port ends the worker while the other workers keep answering', async (t) => {
  const { runner, bundleUrl, stopWitness } = await drill(t);
  const app = await start(runner, bundleUrl, 'forger', reach('forger'));
  assert.equal(await app.get('/oom'), 'posting');
  assert.ok(await closed(app.port, 3000), 'the worker is terminated');
  for (const end = performance.now() + 3000; ; await sleep(50)) {
    if ((await call<Listed[]>(runner, 'GET', '/instances')).every((i) => i.app === 'witness')) break;
    assert.ok(performance.now() < end, 'the instance exited');
  }
  assert.equal(await stopWitness(), 0);
});

test('an app that throws undefined ends as crashed with that text, not as a runner fault', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'thrower');
  assert.equal(await app.get('/undefined'), 'thrown');
  const { event } = await nextEvent(runner, app.worker, 3000);
  assert.deepEqual([event.ev, event.reason], ['exit', 'undefined']);
  assert.equal((await call<{ internal: number }>(runner, 'GET', '/health')).internal, 0);
});

test('a sparse log array is counted as forged and nothing of it lands in the log', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'sparse', reach('sparse'));
  assert.equal(await app.get('/sparse'), 'posted');
  assert.equal((await nextEvent(runner, app.worker, 3000)).event.ev, 'forged');
  assert.equal(await call<string>(runner, 'GET', '/logs/sparse'), 'fixture ready');
});

test('a final line with no newline is logged when the worker exits', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  const app = await start(runner, await serveBundle(t), 'tail');
  assert.equal(await app.get('/tail'), 'written');
  await nextEvent(runner, app.worker, 3000);
  assert.deepEqual((await call<string>(runner, 'GET', '/logs/tail')).split('\n'), ['fixture ready', 'tail']);
});

/** Two consecutive ports nothing is bound to. */
async function freePair(): Promise<number> {
  const bindable = (port: number) => new Promise<boolean>((ok) => {
    const probe = createServer().once('error', () => ok(false)).listen(port, () => probe.close(() => ok(true)));
  });
  for (;;) {
    const low = 20_000 + Math.floor(Math.random() * 10_000);
    if ((await bindable(low)) && (await bindable(low + 1))) return low;
  }
}

test('worker ports advance round-robin and a freed port is not handed out again within its cooldown', async (t) => {
  const low = await freePair();
  const runner = await startRunner(t, { ...HEALTHY, PNEUMA_SPACE_RUNNER_PORT_RANGE: `${low}-${low + 1}` });
  const bundleUrl = await serveBundle(t);
  const ports: number[] = [];
  for (const _ of [1, 2]) {
    ports.push((await start(runner, bundleUrl, 'a')).port);
    await call(runner, 'DELETE', '/instances/a');
  }
  assert.deepEqual(ports, [low, low + 1]);
  const third = await fetch(`${runner.url}/instances/a`, {
    method: 'POST', body: JSON.stringify({ release: 1, spec: 's', bundleUrl, entry: 'app.mjs', env: {}, storage: [], heapMb: 64, readyMs: 5000 }),
  });
  assert.equal(third.status, 503);
});

test('a worker line is also written to the runner stdout as one JSON line', async (t) => {
  const runner = await startRunner(t, HEALTHY);
  await start(runner, await serveBundle(t), 'printer');
  for (const end = Date.now() + 5000; !runner.stdout.some((l) => l.includes('fixture ready')); await sleep(50)) assert.ok(Date.now() < end, 'the line reached stdout');
  const line = JSON.parse(runner.stdout.find((l) => l.includes('fixture ready'))!);
  assert.deepEqual({ ...line, t: typeof line.t }, { t: 'number', app: 'printer', release: 1, stream: 'stdout', line: 'fixture ready' });
});
