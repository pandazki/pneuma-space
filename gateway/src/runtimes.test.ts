import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Instances } from './instances.ts';
import { registered, replica, tempStore, until } from './lifecycle.fakes.ts';
import {
  appName, Conflict, DEFAULT_POLICY, DEFAULT_TENANT, newAppId,
  type AppId, type BundleId, type ImageId, type Lease, type ReleaseNumber, type Runtime, type RunSpec, type RuntimeKind,
} from './model.ts';
import { Backoff, Quarantined, Runtimes } from './runtimes.ts';

class FakeRuntime implements Runtime {
  readonly kind: RuntimeKind;
  readonly released: Lease[] = [];
  readonly calls: string[];
  #held = false;
  constructor(kind: RuntimeKind, calls: string[]) {
    this.kind = kind;
    this.calls = calls;
  }
  async acquire(app: AppId): Promise<Lease> {
    this.calls.push(`${this.kind} acquire`);
    this.#held = true;
    return { app, address: `${this.kind}:8000` };
  }
  release(lease: Lease): void { this.released.push(lease); }
  channel(): void {}
  async retire(): Promise<void> {
    await Promise.resolve();
    this.#held = false;
    this.calls.push(`${this.kind} retired`);
  }
  async reconcile(): Promise<void> {}
  state(): 'awake' | 'none' { return this.#held ? 'awake' : 'none'; }
  since(): null { return null; }
  leases() { return { request: 0, channel: 0, trigger: 0 }; }
  sleepsAt(): null { return null; }
  async logs(): Promise<string> { return ''; }
  health() { return []; }
  async destroyStorage(): Promise<void> {}
}

const RUN = {
  container: { kind: 'container', image: 'sha256:one' as ImageId },
  isolate: { kind: 'isolate', bundle: 'b'.repeat(64) as BundleId, entry: 'src/server.ts' },
} as const;

function facade(kinds: readonly RuntimeKind[]) {
  const app = newAppId();
  let spec: RunSpec = {
    app, name: appName('fixture'), tenant: DEFAULT_TENANT, release: 1 as ReleaseNumber, runtime: RUN.container, injection: { env: {}, storage: [], services: [] }, policy: DEFAULT_POLICY, version: 0,
  };
  const store = tempStore();
  const instances = new Instances(store);
  const calls: string[] = [];
  const fakes = kinds.map((kind) => new FakeRuntime(kind, calls));
  const runtimes = new Runtimes({ runtimes: fakes, specFor: (id) => (id === app ? spec : null), instances });
  const set = (change: Partial<RunSpec>) => { spec = { ...spec, ...change }; };
  return { app, calls, fakes, instances, runtimes, set, store };
}

test('the facade routes a lease back to the runtime that issued it, even after the app moved runtimes', async () => {
  const { app, fakes: [container, isolate], runtimes, set } = facade(['container', 'isolate']);
  const lease = await runtimes.acquire(app, 'request');
  set({ runtime: RUN.isolate });
  runtimes.release(lease);
  assert.deepEqual([container.released, isolate.released], [[lease], []]);
});

test('acquire for a runtime without an implementation rejects with the start-the-profile message', async () => {
  const { app, runtimes, set } = facade(['container']);
  set({ runtime: RUN.isolate });
  await assert.rejects(runtimes.acquire(app, 'request'), (e) => e instanceof Conflict && e.message === 'runtime isolate is not available; start docker compose --profile isolate');
});

test('a wake on the new runtime waits until the runtime named by the instance row retired it (one instance per app)', async () => {
  const { app, calls, instances, runtimes, set, store } = facade(['container', 'isolate']);
  await store.insertInstance({
    app, runtime: 'container', release: 1 as ReleaseNumber, specHash: 'h', epoch: 1, state: 'awake', actor: null, handle: 'c1',
    address: 'c1:8000', node: null, home: null, since: 0, awakeAt: 0, cpuMillis: 0, memoryMb: 0,
  });
  await instances.ready();
  set({ runtime: RUN.isolate });
  await runtimes.acquire(app, 'request');
  assert.deepEqual(calls, ['container retired', 'isolate acquire']);
});

async function guarded(policy: Parameters<typeof registered>[1]) {
  const store = tempStore();
  const clock = { now: 1_000_000 };
  const { app, specFor, set } = await registered(store, policy);
  const r = replica(store, specFor, 'replica-a', { now: () => clock.now });
  await r.lifecycle.reconcile();
  const fail = (reason = 'exit 1') => store.transaction(async (tx) => {
    const quarantine = await r.guard.fail(tx, specFor(app)!, reason);
    await r.instances.refresh(app).catch(() => {});
    return quarantine;
  }).then(async (q) => (await r.instances.refresh(app), q));
  /** Wakes the app, then has its instance crash. */
  const crash = async () => {
    r.lifecycle.release(await r.lifecycle.acquire(app, 'request'));
    const { handle } = (await store.instance(app))!;
    r.driver.end(app, handle!, { ev: 'crashed', reason: 'exit 1' });
    await until('asleep after the crash', () => r.lifecycle.state(app) === 'asleep');
  };
  return { app, clock, crash, fail, set, store, ...r };
}

test('failures older than failure_window_seconds do not count toward max_failures', async () => {
  const { app, clock, fail, guard } = await guarded({ max_failures: 2, failure_window_seconds: 60 });
  await fail();
  clock.now += 60_001;
  await fail();
  assert.equal(guard.quarantine(app), null);
});

test('the Guard quarantines on the max_failures-th failure inside the window, recording reason, time and count', async () => {
  const { app, clock, fail, guard } = await guarded({ max_failures: 2, failure_window_seconds: 60 });
  await fail();
  clock.now += 30_000;
  await fail();
  assert.deepEqual(guard.quarantine(app), { reason: 'exit 1', since: clock.now, failures: 2 });
});

test('acquire on a quarantined app rejects with Quarantined after the backoff has passed', async () => {
  const { app, clock, fail, lifecycle } = await guarded({ max_failures: 1, restart_backoff_seconds: 1 });
  await fail();
  clock.now += 60_000;
  await assert.rejects(lifecycle.acquire(app, 'request'), Quarantined);
});

test('a failed wake backs off: acquire rejects inside restart_backoff_seconds and admits after', async () => {
  const { app, clock, driver, lifecycle } = await guarded({ restart_backoff_seconds: 5 });
  driver.failure = new Error('did not accept TCP');
  await assert.rejects(lifecycle.acquire(app, 'request'), /did not accept TCP/);
  driver.failure = null;
  clock.now += 1000;
  await assert.rejects(lifecycle.acquire(app, 'request'), (e) => e instanceof Backoff && e.retryAfterSeconds === 4);
  clock.now += 4001;
  await lifecycle.acquire(app, 'request');
});

test('a new release clears the quarantine', async () => {
  const { app, fail, guard, lifecycle, set } = await guarded({ max_failures: 1, restart_backoff_seconds: 1 });
  await fail();
  assert.notEqual(guard.quarantine(app), null);
  set({ release: 2 as ReleaseNumber });
  assert.equal(guard.quarantine(app), null);
  await lifecycle.acquire(app, 'request');
});

test('unquarantine clears the quarantine, the failure history and the backoff', async () => {
  const { app, crash, fail, guard, lifecycle } = await guarded({ max_failures: 2, restart_backoff_seconds: 60 });
  await fail();
  await fail();
  await guard.unquarantine(app);
  await lifecycle.acquire(app, 'request');
  await crash();
  assert.equal(guard.quarantine(app), null);
});

test('removing the instance clears the app\'s Guard state, so republishing the same release starts clean', async () => {
  const { app, crash, guard, lifecycle } = await guarded({ max_failures: 1 });
  await crash();
  assert.notEqual(guard.quarantine(app), null);
  await lifecycle.retire(app);
  assert.equal(guard.quarantine(app), null);
});
