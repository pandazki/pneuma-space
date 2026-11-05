import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventLog } from './events.ts';
import { IsolateRuntime } from './isolate.ts';
import {
  appName, DEFAULT_POLICY, newAppId, NotFound, type AppId, type BundleId, type Policy, type ReleaseNumber, type RunSpec, type StorageBinding,
} from './model.ts';
import type { EventPage } from './runner.ts';
import { serveBundle, startRunner, type RunnerProcess } from './runner.harness.ts';
import { Runtimes, Unavailable } from './runtimes.ts';

async function fixture(t: TestContext, policy: Partial<Policy> = {}, storage: readonly StorageBinding[] = []) {
  const app = newAppId();
  const specs = new Map<AppId, RunSpec>();
  const specFor = (id: AppId) => specs.get(id) ?? null;
  const publish = (release: number) => specs.set(app, {
    app, name: appName('fixture'), release: release as ReleaseNumber, runtime: { kind: 'isolate', bundle: 'b' as BundleId, entry: 'app.mjs' },
    injection: { env: {}, storage }, policy: { ...DEFAULT_POLICY, ...policy },
  });
  publish(1);
  const bundleUrl = await serveBundle(t);
  let runner = await startRunner(t);
  const port = new URL(runner.url).port;
  const events: Record<string, unknown>[] = [];
  const bus = new EventLog(() => {});
  const runtimes: IsolateRuntime[] = [];
  const start = (url = runner.url) => {
    const runtime = new IsolateRuntime({
      runner: url, bundleUrl: () => bundleUrl, specFor, hasRun: async () => true,
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
  const workers = async () => (await (await fetch(`${runner.url}/instances`)).json()) as { app: string; release: number }[];
  const runnerEvents = async () => ((await (await fetch(`${runner.url}/events?after=0`)).json()) as EventPage).events;
  const runtime = start();
  const guarded = () => new Runtimes({ runtimes: [runtime], specFor, events: bus, log: bus.emit });
  return { app, events, publish, start, stopRunner, startRunnerAgain, restartRunner, workers, runnerEvents, guarded, runtime };
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
  await until('asleep while the runner is down', () => runtime.state(app) === 'asleep', 5000);
  assert.deepEqual(events.at(-1), { ev: 'asleep', unavailable: true });
  assert.equal(events.some((e) => e.ev === 'crashed' || e.ev === 'hung'), false);
});

test('a wake while the runner is down is refused as Unavailable and counts no failure toward quarantine', async (t) => {
  const { app, guarded, startRunnerAgain, stopRunner } = await fixture(t, { max_failures: 1 });
  const runtimes = guarded();
  await stopRunner();
  await assert.rejects(runtimes.acquire(app, 'request'), Unavailable);
  assert.equal(runtimes.quarantine(app), null);
  await startRunnerAgain();
  assert.equal(await answer((await runtimes.acquire(app, 'request')).address), 'fixture 1');
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
