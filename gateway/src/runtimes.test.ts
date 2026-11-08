import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventLog } from './events.ts';
import {
  appName, Conflict, DEFAULT_POLICY, DEFAULT_TENANT, newAppId,
  type AppId, type BundleId, type ImageId, type Lease, type Policy, type ReleaseNumber, type Runtime, type RunSpec, type RuntimeKind,
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

function fixture(kinds: readonly RuntimeKind[], policy: Partial<Policy> = {}) {
  const app = newAppId();
  const clock = { now: 1_000_000 };
  let spec: RunSpec = {
    app, name: appName('fixture'), tenant: DEFAULT_TENANT, release: 1 as ReleaseNumber, runtime: RUN.container, injection: { env: {}, storage: [], services: [] }, policy: { ...DEFAULT_POLICY, ...policy },
  };
  const events = new EventLog(() => {});
  const calls: string[] = [];
  const fakes = kinds.map((kind) => new FakeRuntime(kind, calls));
  const runtimes = new Runtimes({ runtimes: fakes, specFor: (id) => (id === app ? spec : null), events, log: events.emit, now: () => clock.now });
  const set = (change: Partial<RunSpec>) => { spec = { ...spec, ...change }; };
  const crash = () => events.emit('crashed', app, { reason: 'exit 1' });
  return { app, calls, clock, crash, events, fakes, runtimes, set };
}

test('the facade routes a lease back to the runtime that issued it, even after the app moved runtimes', async () => {
  const { app, fakes: [container, isolate], runtimes, set } = fixture(['container', 'isolate']);
  const lease = await runtimes.acquire(app, 'request');
  set({ runtime: RUN.isolate });
  runtimes.release(lease);
  assert.deepEqual([container.released, isolate.released], [[lease], []]);
});

test('acquire for a runtime without an implementation rejects with the start-the-profile message', async () => {
  const { app, runtimes, set } = fixture(['container']);
  set({ runtime: RUN.isolate });
  await assert.rejects(runtimes.acquire(app, 'request'), (e) => e instanceof Conflict && e.message === 'runtime isolate is not available; start docker compose --profile isolate');
});

test('a wake on the new runtime waits until the old runtime retired its instance (one instance per app)', async () => {
  const { app, calls, runtimes, set } = fixture(['container', 'isolate']);
  await runtimes.acquire(app, 'request');
  set({ runtime: RUN.isolate });
  await runtimes.acquire(app, 'request');
  assert.deepEqual(calls, ['container acquire', 'container retired', 'isolate acquire']);
});

test('failures older than failure_window_seconds do not count toward max_failures', () => {
  const { app, clock, crash, runtimes } = fixture(['container'], { max_failures: 2, failure_window_seconds: 60 });
  crash();
  clock.now += 60_001;
  crash();
  assert.equal(runtimes.quarantine(app), null);
});

test('the Guard quarantines on the max_failures-th failure inside the window, recording reason, time and count', () => {
  const { app, clock, crash, runtimes } = fixture(['container'], { max_failures: 2, failure_window_seconds: 60 });
  crash();
  clock.now += 30_000;
  crash();
  assert.deepEqual(runtimes.quarantine(app), { reason: 'exit 1', since: clock.now, failures: 2 });
});

test('acquire on a quarantined app rejects with Quarantined after the backoff has passed', async () => {
  const { app, clock, crash, runtimes } = fixture(['container'], { max_failures: 1, restart_backoff_seconds: 1 });
  crash();
  clock.now += 60_000;
  await assert.rejects(runtimes.acquire(app, 'request'), Quarantined);
});

test('a failed wake backs off: acquire rejects inside restart_backoff_seconds and admits after', async () => {
  const { app, clock, events, runtimes } = fixture(['container'], { restart_backoff_seconds: 5 });
  events.emit('waking', app);
  events.emit('asleep', app, { error: 'did not accept TCP' });
  clock.now += 1000;
  await assert.rejects(runtimes.acquire(app, 'request'), (e) => e instanceof Backoff && e.retryAfterSeconds === 4);
  clock.now += 4001;
  assert.deepEqual(await runtimes.acquire(app, 'request'), { app, address: 'container:8000' });
});

test('a new release clears the quarantine', async () => {
  const { app, crash, runtimes, set } = fixture(['container'], { max_failures: 1, restart_backoff_seconds: 1 });
  crash();
  assert.notEqual(runtimes.quarantine(app), null);
  set({ release: 2 as ReleaseNumber });
  assert.equal(runtimes.quarantine(app), null);
  await runtimes.acquire(app, 'request');
});

test('unquarantine clears the quarantine, the failure history and the backoff', async () => {
  const { app, crash, runtimes } = fixture(['container'], { max_failures: 2, restart_backoff_seconds: 60 });
  crash();
  crash();
  runtimes.unquarantine(app);
  await runtimes.acquire(app, 'request');
  crash();
  assert.equal(runtimes.quarantine(app), null);
});

test('removing the instance clears the app\'s Guard state, so republishing the same release starts clean', () => {
  const { app, crash, events, runtimes } = fixture(['container'], { max_failures: 1 });
  crash();
  events.emit('removed', app);
  assert.equal(runtimes.quarantine(app), null);
});
