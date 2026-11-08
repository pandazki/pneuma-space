import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventLog } from './events.ts';
import { Instances } from './instances.ts';
import { IsolateRuntime, StaticPool } from './isolate.ts';
import { CURRENT, register, tempStore } from './lifecycle.fakes.ts';
import {
  appName, DEFAULT_POLICY, DEFAULT_TENANT, newAppId, NotFound, type AppId, type BundleId, type Policy, type ReleaseNumber, type ReplicaId, type RunSpec, type StorageBinding,
} from './model.ts';
import type { EventPage } from './runner.ts';
import { serveBundle, startRunner, type RunnerProcess } from './runner.harness.ts';
import { AppGuard, Runtimes, Unavailable } from './runtimes.ts';

async function fixture(t: TestContext, policy: Partial<Policy> = {}, storage: readonly StorageBinding[] = [], env: Record<string, string> = {}) {
  const app = newAppId();
  const specs = new Map<AppId, RunSpec>();
  const specFor = (id: AppId) => specs.get(id) ?? null;
  const store = tempStore();
  const publish = (release: number, id = app) => {
    const spec: RunSpec = {
      app: id, name: appName(id === app ? 'fixture' : `fixture-${id}`), tenant: DEFAULT_TENANT, release: release as ReleaseNumber, runtime: { kind: 'isolate', bundle: 'b' as BundleId, entry: 'app.mjs' },
      injection: { env, storage, services: [] }, policy: { ...DEFAULT_POLICY, ...policy }, version: CURRENT,
    };
    register(store, spec);
    specs.set(id, spec);
  };
  publish(1);
  /** A second app on the same runner. */
  const other = newAppId();
  publish(1, other);
  const bundleUrl = await serveBundle(t);
  let runner = await startRunner(t);
  const port = new URL(runner.url).port;
  const events: Record<string, unknown>[] = [];
  const bus = new EventLog(() => {});
  const runtimes: IsolateRuntime[] = [];
  let guard!: AppGuard;
  let instances!: Instances;
  /** A gateway process: its own mirror of the shared store, under the same replica name, as a restart keeps the host name. */
  const start = (url = runner.url) => {
    instances = new Instances(store, { replica: 'gateway' as ReplicaId });
    guard = new AppGuard({ instances, specFor, log: bus.emit });
    const runtime = new IsolateRuntime({
      pool: new StaticPool(url), bundleUrl: () => bundleUrl, specFor, hasRun: async () => true, instances, guard,
      log: (ev, id, extra) => {
        if (id === app) events.push({ ev, ...extra });
        bus.emit(ev, id, extra);
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(() => { for (const runtime of runtimes) runtime.close(); });
  const stopRunner = () => runner.stop();
  /** A new runner on the same port and data, as compose's restart policy would start it. */
  const startRunnerAgain = async (): Promise<RunnerProcess> => (runner = await startRunner(t, { PNEUMA_SPACE_RUNNER_PORT: port }, runner.data));
  const restartRunner = async () => {
    await stopRunner();
    return startRunnerAgain();
  };
  const pauseRunner = () => process.kill(runner.pid, 'SIGSTOP');
  const resumeRunner = () => process.kill(runner.pid, 'SIGCONT');
  const workers = async () => (await (await fetch(`${runner.url}/instances`)).json()) as { app: string; release: number }[];
  const runnerEvents = async () => ((await (await fetch(`${runner.url}/events?after=0`)).json()) as EventPage).events;
  const runtime = start();
  const shared = { guard, instances };
  const guarded = () => Object.assign(new Runtimes({ runtimes: [runtime], specFor, instances: shared.instances }), { quarantine: (id: AppId) => shared.guard.quarantine(id) });
  /** A start from outside this gateway, as one that died mid-start would have left it. */
  const startElsewhere = (id: AppId, env: Record<string, string>) => void fetch(`${runner.url}/instances/${id}`, {
    method: 'POST', body: JSON.stringify({ release: 1, spec: 'elsewhere', bundleUrl, entry: 'app.mjs', env, storage: [], heapMb: 1024, readyMs: 8000 }),
  }).catch(() => {});
  return { app, other, events, publish, start, startElsewhere, stopRunner, pauseRunner, resumeRunner, startRunnerAgain, restartRunner, workers, runnerEvents, guarded, runtime };
}

const answer = async (address: string) => (await fetch(`http://${address}/`)).text();
async function until(what: string, condition: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !condition(); await sleep(10)) assert.ok(Date.now() < end, `timed out waiting for ${what}`);
}

test('concurrent acquires on a sleeping isolate app start one worker and get an address that answers', async (t) => {
  const { app, runtime, workers } = await fixture(t);
  const started = performance.now();
  const [a, b] = await Promise.all([runtime.acquire(app, 'request'), runtime.acquire(app, 'request')]);
  t.diagnostic(`cold wake (download, unpack, worker, listen): ${Math.round(performance.now() - started)} ms`);
  assert.equal(a.address, b.address);
  assert.equal(await answer(a.address), 'fixture 1');
  assert.equal((await workers()).length, 1);
});

test('acquire rejects with NotFound when the app has no isolate RunSpec', async (t) => {
  const { runtime } = await fixture(t);
  await assert.rejects(runtime.acquire(newAppId(), 'request'), NotFound);
});

test('a held lease keeps the worker past idle_seconds; after release the reaper stops it', async (t) => {
  const { app, runtime, workers } = await fixture(t, { idle_seconds: 1 });
  const lease = await runtime.acquire(app, 'request');
  await sleep(2500);
  assert.equal(runtime.state(app), 'awake');
  runtime.release(lease);
  await until('idle stop', () => runtime.state(app) === 'asleep', 4000);
  assert.deepEqual(await workers(), []);
});

test('retire waits for the held lease, then the worker ends through its SIGTERM handler; the next acquire runs the new release', async (t) => {
  const { app, publish, runtime, runnerEvents, workers } = await fixture(t);
  const lease = await runtime.acquire(app, 'request');
  publish(2);
  const retired = runtime.retire(app);
  await sleep(500);
  assert.equal(runtime.state(app), 'draining');
  runtime.release(lease);
  await retired;
  assert.deepEqual(await workers(), []);
  assert.deepEqual((await runnerEvents()).filter((e) => e.ev === 'exit').map((e) => [e.code, e.reason]), [[0, 'stopped']], 'the fixture exits 0 on SIGTERM');
  assert.equal(await answer((await runtime.acquire(app, 'request')).address), 'fixture 2');
});

test('a worker that exits on its own while awake emits crashed, then asleep', async (t) => {
  const { app, events, runtime } = await fixture(t);
  await runtime.reconcile();
  const lease = await runtime.acquire(app, 'request');
  runtime.release(lease);
  await fetch(`http://${lease.address}/exit`).catch(() => {});
  await until('exit event', () => runtime.state(app) === 'asleep', 3000);
  assert.deepEqual(events.slice(-2), [{ ev: 'crashed', reason: 'worker exited with code 3' }, { ev: 'asleep', external: true }]);
});

test('a worker the runner reports hung emits hung, then asleep', async (t) => {
  const { app, events, runtime } = await fixture(t);
  await runtime.reconcile();
  const lease = await runtime.acquire(app, 'request');
  runtime.release(lease);
  void fetch(`http://${lease.address}/hang`).catch(() => {});
  await until('hung event', () => runtime.state(app) === 'asleep', 7000);
  assert.deepEqual(events.slice(-2).map((e) => e.ev), ['hung', 'asleep']);
});

test('a restarted gateway adopts the running worker as awake at the same address', async (t) => {
  const { app, runtime, start } = await fixture(t);
  const lease = await runtime.acquire(app, 'request');
  runtime.close();
  const next = start();
  await next.reconcile();
  assert.equal(next.state(app), 'awake');
  assert.equal((await next.acquire(app, 'request')).address, lease.address);
});

test('a runner restart marks its instances asleep and the next acquire wakes the app on the new runner', async (t) => {
  const { app, events, runtime, restartRunner } = await fixture(t);
  await runtime.reconcile();
  runtime.release(await runtime.acquire(app, 'request'));
  await restartRunner();
  await until('asleep after runner restart', () => runtime.state(app) === 'asleep', 5000);
  assert.equal(events.some((e) => e.ev === 'crashed'), false);
  assert.equal(await answer((await runtime.acquire(app, 'request')).address), 'fixture 1');
});

test('an awake isolate app whose runner stops answering goes asleep as unavailable, not as a failure', async (t) => {
  const { app, events, runtime, stopRunner } = await fixture(t);
  await runtime.reconcile();
  runtime.release(await runtime.acquire(app, 'request'));
  await stopRunner();
  await until('asleep while the runner is down', () => runtime.state(app) === 'asleep', 20_000);
  assert.deepEqual(events.at(-1), { ev: 'asleep', unavailable: true });
  assert.equal(events.some((e) => e.ev === 'crashed' || e.ev === 'hung'), false);
});

test('a wake while the runner is down is refused as Unavailable and counts no failure toward quarantine', async (t) => {
  const { app, guarded, stopRunner } = await fixture(t, { max_failures: 1 });
  const runtimes = guarded();
  await stopRunner();
  await assert.rejects(runtimes.acquire(app, 'request'), Unavailable);
  assert.equal(runtimes.quarantine(app), null);
});

test('the first wake after the runner is back answers', async (t) => {
  const { app, guarded, startRunnerAgain, stopRunner } = await fixture(t, { max_failures: 1 });
  const runtimes = guarded();
  await stopRunner();
  await runtimes.acquire(app, 'request').catch(() => {});
  await startRunnerAgain();
  assert.equal(await answer((await runtimes.acquire(app, 'request')).address), 'fixture 1');
});

test('a start during which the runner dies counts as a failed wake', async (t) => {
  const { app, guarded, stopRunner, workers } = await fixture(t, { max_failures: 1 }, [], { START_BUSY_MS: '3000' });
  const runtimes = guarded();
  const wake = runtimes.acquire(app, 'request');
  // Stop only once the runner holds the start; a stop before the POST is sent is classified unavailable, not a failure.
  for (const deadline = Date.now() + 5000; !(await workers()).some((w) => w.app === app); await sleep(50)) {
    assert.ok(Date.now() < deadline, 'the start reached the runner');
  }
  await stopRunner();
  await assert.rejects(wake);
  assert.notEqual(runtimes.quarantine(app), null);
});

async function leftRunning(t: TestContext) {
  const fixed = await fixture(t);
  const { app, pauseRunner, resumeRunner, runtime } = fixed;
  await runtime.reconcile();
  runtime.release(await runtime.acquire(app, 'request'));
  pauseRunner();
  await until('asleep while the runner is paused', () => runtime.state(app) === 'asleep', 25_000);
  resumeRunner();
  return fixed;
}

test('a worker left running while the runner did not answer is stopped once it answers', async (t) => {
  const { workers } = await leftRunning(t);
  for (const end = Date.now() + 12_000; (await workers()).length > 0; await sleep(100)) assert.ok(Date.now() < end, 'the untracked worker is stopped');
});

test('the first wake after the runner answers again succeeds', async (t) => {
  const { app, runtime } = await leftRunning(t);
  assert.equal(await answer((await runtime.acquire(app, 'request')).address), 'fixture 1');
});

// Longer than the three 2 s poll timeouts, interleaved with recovery probes, that once gave up on the runner.
test('a runner whose main thread stalls 12 s marks no instance unavailable', async (t) => {
  const { app, events, pauseRunner, resumeRunner, runtime } = await fixture(t);
  await runtime.reconcile();
  runtime.release(await runtime.acquire(app, 'request'));
  pauseRunner();
  await sleep(12_000);
  resumeRunner();
  await sleep(2000);
  assert.equal(runtime.state(app), 'awake');
  assert.equal(events.some((e) => e.unavailable), false);
});

test('one app writing 64 MiB to stdout leaves it and the other app awake and available', async (t) => {
  const { app, other, events, runtime } = await fixture(t);
  await runtime.reconcile();
  const [burst] = await Promise.all([app, other].map(async (id) => {
    const lease = await runtime.acquire(id, 'request');
    runtime.release(lease);
    return lease;
  }));
  assert.equal(await (await fetch(`http://${burst.address}/burst`)).text(), 'written');
  await sleep(12_000);
  assert.deepEqual([runtime.state(app), runtime.state(other)], ['awake', 'awake']);
  assert.equal(events.some((e) => e.unavailable), false);
});

const staleRunner = async (t: TestContext) => {
  let deletes = 0;
  const logged: Record<string, unknown>[] = [];
  const runner = { listed: [{ app: 'stale', release: 1, spec: 's', worker: '1:1', state: 'listening', port: 1, since: 0 }] };
  const fake = createServer((q, s) => {
    const json = (body: unknown) => s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (q.method === 'DELETE') {
      if (++deletes === 1) return s.writeHead(500).end('{"error":"failed"}');
      runner.listed = [];
      return s.writeHead(204).end();
    }
    if (q.url!.startsWith('/events')) return json({ startedAt: 1, seq: 0, events: [] });
    if (q.url === '/instances') return json(runner.listed);
    json({ ok: true, startedAt: 1, stuck: 0, workers: runner.listed.length });
  }).listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const runtime = new IsolateRuntime({ pool: new StaticPool(`http://127.0.0.1:${(fake.address() as AddressInfo).port}`), bundleUrl: () => '', specFor: () => null, hasRun: async () => true, instances: new Instances(tempStore()), log: (ev, _app, extra) => logged.push({ ev, ...extra }) });
  t.after(() => { runtime.close(); fake.close(); });
  return { runner, runtime, logged };
};

test('a gateway starts against a runner that lists a stale worker but fails to remove it, and logs it unreachable', async (t) => {
  const { runtime, logged } = await staleRunner(t);
  await runtime.reconcile();
  assert.deepEqual(logged.filter((e) => e.ev === 'runner-unreachable').map((e) => e.worker), ['1:1']);
});

test('a stale worker whose removal failed at gateway start is removed by the recovery poll', async (t) => {
  const { runner, runtime, logged } = await staleRunner(t);
  await runtime.reconcile();
  for (const end = Date.now() + 8000; runner.listed.length > 0; await sleep(100)) assert.ok(Date.now() < end, 'the stale worker is removed');
  assert.deepEqual(logged.find((e) => e.ev === 'runner-recovered'), { ev: 'runner-recovered', runner: 'runner', stopped: 1, failed: 0 });
});

test('a worker another gateway started that has not listened yet is stopped by the recovery poll', async (t) => {
  const { app, runtime, runnerEvents, startElsewhere } = await fixture(t);
  startElsewhere(app, { START_BUSY_MS: '3000' });
  // Inside its 3 s of startup, so the gateway finds it starting.
  await sleep(500);
  await runtime.reconcile();
  const stopped = async () => (await runnerEvents()).some((e) => e.app === app && e.ev === 'exit' && e.reason === 'stopped');
  for (const end = Date.now() + 15_000; !(await stopped()); await sleep(100)) assert.ok(Date.now() < end, 'the untracked worker is stopped');
});

// A stopped compose service has no name on the platform network; `.invalid` never resolves (RFC 6761).
test('destroyStorage without the runner fails as Unavailable and keeps the directory; with it the directory is gone', async (t) => {
  const storage = [{ id: 'pneuma-space-files-s1', target: '/data/files', env: { PNEUMA_SPACE_FILES_DIR: '{dir}' } }];
  const { app, runtime, start } = await fixture(t, {}, storage);
  const lease = await runtime.acquire(app, 'request');
  const dir = await (await fetch(`http://${lease.address}/files`)).text();
  runtime.release(lease);
  await runtime.retire(app);
  await assert.rejects(start('http://runner.invalid:8082').destroyStorage(app, storage[0].id), Unavailable);
  assert.equal(existsSync(dir), true);
  await runtime.destroyStorage(app, storage[0].id);
  assert.equal(existsSync(dir), false);
});

test('logs returns what the worker printed', async (t) => {
  const { app, runtime } = await fixture(t);
  await runtime.acquire(app, 'request');
  assert.match(await runtime.logs(app, 10), /fixture ready/);
});
