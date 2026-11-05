import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { IsolateRuntime } from './isolate.ts';
import {
  appName, DEFAULT_POLICY, newAppId, NotFound, type AppId, type BundleId, type Policy, type ReleaseNumber, type RunSpec,
} from './model.ts';
import { serveBundle, startRunner, type RunnerProcess } from './runner.harness.ts';

async function fixture(t: TestContext, policy: Partial<Policy> = {}) {
  const app = newAppId();
  const specs = new Map<AppId, RunSpec>();
  const publish = (release: number) => specs.set(app, {
    app, name: appName('fixture'), release: release as ReleaseNumber, runtime: { kind: 'isolate', bundle: 'b' as BundleId, entry: 'app.mjs' },
    injection: { env: {}, storage: [] }, policy: { ...DEFAULT_POLICY, ...policy },
  });
  publish(1);
  const bundleUrl = await serveBundle(t);
  let runner = await startRunner(t);
  const events: Record<string, unknown>[] = [];
  const runtimes: IsolateRuntime[] = [];
  const start = () => {
    const runtime = new IsolateRuntime({
      runner: runner.url, bundleUrl: () => bundleUrl, specFor: (id) => specs.get(id) ?? null,
      log: (ev, id, extra) => { if (id === app) events.push({ ev, ...extra }); },
    });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(() => { for (const runtime of runtimes) runtime.close(); });
  /** Kills the runner and starts a new one on the same port and data, as compose's restart policy would. */
  const restartRunner = async (): Promise<RunnerProcess> => {
    await runner.stop();
    runner = await startRunner(t, { PNEUMA_SPACE_RUNNER_PORT: new URL(runner.url).port }, runner.data);
    return runner;
  };
  const workers = async () => (await (await fetch(`${runner.url}/instances`)).json()) as { app: string; release: number }[];
  return { app, events, publish, start, restartRunner, workers, runtime: start() };
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

test('retire waits for the held lease, then removes the worker; the next acquire runs the new release', async (t) => {
  const { app, publish, runtime, workers } = await fixture(t);
  const lease = await runtime.acquire(app, 'request');
  publish(2);
  const retired = runtime.retire(app);
  await sleep(500);
  assert.equal(runtime.state(app), 'draining');
  runtime.release(lease);
  await retired;
  assert.deepEqual(await workers(), []);
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

test('logs returns what the worker printed', async (t) => {
  const { app, runtime } = await fixture(t);
  await runtime.acquire(app, 'request');
  assert.match(await runtime.logs(app, 10), /fixture ready/);
});
