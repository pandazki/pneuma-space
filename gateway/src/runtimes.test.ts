import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventLog } from './events.ts';
import {
  appName, Conflict, DEFAULT_POLICY, newAppId,
  type AppId, type BundleId, type ImageId, type Lease, type Policy, type ReleaseNumber, type Runtime, type RunSpec, type RuntimeKind,
} from './model.ts';
import { Backoff, Quarantined, Runtimes } from './runtimes.ts';

class FakeRuntime implements Runtime {
  readonly kind: RuntimeKind;
  readonly released: Lease[] = [];
  constructor(kind: RuntimeKind) {
    this.kind = kind;
  }
  async acquire(app: AppId): Promise<Lease> { return { app, address: `${this.kind}:8000` }; }
  release(lease: Lease): void { this.released.push(lease); }
  channel(): void {}
  async retire(): Promise<void> {}
  async reconcile(): Promise<void> {}
  state(): 'none' { return 'none'; }
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
    app, name: appName('fixture'), release: 1 as ReleaseNumber, runtime: RUN.container, injection: { env: {}, storage: [] }, policy: { ...DEFAULT_POLICY, ...policy },
  };
  const events = new EventLog(() => {});
  const fakes = kinds.map((kind) => new FakeRuntime(kind));
  const runtimes = new Runtimes({ runtimes: fakes, specFor: (id) => (id === app ? spec : null), events, log: events.emit, now: () => clock.now });
  const set = (change: Partial<RunSpec>) => { spec = { ...spec, ...change }; };
  return { app, clock, events, fakes, runtimes, set };
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

test('the Guard quarantines after max_failures within the window, and acquire then rejects', async () => {
  const { app, clock, events, runtimes } = fixture(['container'], { max_failures: 3, failure_window_seconds: 60, restart_backoff_seconds: 1 });
  const crash = () => { clock.now += 2000; events.emit('crashed', app, { reason: 'exit 1' }); };
  crash();
  crash();
  clock.now += 60_000;
  crash();
  crash();
  assert.equal(runtimes.quarantine(app), null);
  clock.now += 1000;
  await runtimes.acquire(app, 'request');
  crash();
  assert.deepEqual(runtimes.quarantine(app), { reason: 'exit 1', since: clock.now, failures: 3 });
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
  const { app, events, runtimes, set } = fixture(['container'], { max_failures: 1, restart_backoff_seconds: 1 });
  events.emit('crashed', app, { reason: 'exit 1' });
  assert.notEqual(runtimes.quarantine(app), null);
  set({ release: 2 as ReleaseNumber });
  assert.equal(runtimes.quarantine(app), null);
  await runtimes.acquire(app, 'request');
});
