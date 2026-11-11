import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { Instances } from './instances.ts';
import { Lifecycle } from './lifecycle.ts';
import { FakeDriver } from './lifecycle.fakes.ts';
import { appName, parseManifest, Stranded, subject, type AppId, type AppName, type Capabilities, type ReplicaId, type RunSpec } from './model.ts';
import { PlatformRegistry } from './registry.ts';
import { fakeKubernetes, world } from './registry.fakes.ts';
import { Runtimes } from './runtimes.ts';
import { SqliteStore } from './store.ts';

/** A registry over a real Lifecycle whose driver starts each app on the node `nodes` names. */
async function platform(nodes: Record<string, string> = {}) {
  const w = world();
  const store = new SqliteStore(join(w.dir, 'operations.sqlite3'));
  const instances = new Instances(store, { replica: 'gw-0' as ReplicaId });
  let registry: PlatformRegistry | null = null;
  const specFor = (app: AppId): RunSpec | null => registry?.runSpec(app) ?? null;
  const driver = new FakeDriver();
  const start = driver.start.bind(driver);
  driver.start = async (slot, spec) => {
    driver.node = nodes[spec.name];
    return start(slot, spec);
  };
  const runtime = new Runtimes({ runtimes: [new Lifecycle(driver, { specFor, instances })], specFor, instances });
  registry = await PlatformRegistry.open({
    store, runtime, guard: w.runtime, infra: w.runtime, bundles: w.bundles, providers: [...w.providers.values()], nodeOf: (app) => instances.row(app)?.node ?? null,
  });
  const awake = async (name: string) => {
    const release = await registry!.publish({ name: appName(name), image: 'example:1', manifest: parseManifest({ contract: 1, capabilities: {} }), bundle: null, owner: subject('user:ann') });
    runtime.release(await runtime.acquire(release.app, 'request'));
    return release.app;
  };
  return { registry, store, driver, awake };
}

test('stop retires the instance and its row ends asleep (AC-OPS-14)', async () => {
  const { registry, store, driver, awake } = await platform();
  const app = await awake('survey');
  await registry.stop(appName('survey'));
  assert.deepEqual([(await store.instance(app))?.state, driver.removed.length], ['asleep', 1]);
});

test('restart leaves the app awake under a new instance (AC-OPS-14)', async () => {
  const { registry, store, awake } = await platform();
  const app = await awake('survey');
  const before = (await store.instance(app))?.handle;
  await registry.restart(appName('survey'));
  const after = await store.instance(app);
  assert.equal(after?.state, 'awake');
  assert.notEqual(after?.handle, before);
});

test('drain stops the instances on the named node and leaves the others awake (AC-OPS-16)', async () => {
  const { registry, store, awake } = await platform({ survey: 'n1', chess: 'n1', widget: 'n2' });
  const apps = Object.fromEntries(await Promise.all(['survey', 'chess', 'widget'].map(async (name) => [name, await awake(name)] as const)));
  const result = await registry.drain('n1');
  assert.deepEqual([...result.stopped].sort(), ['chess', 'survey'] as AppName[]);
  assert.deepEqual(await Promise.all(['survey', 'chess', 'widget'].map(async (name) => (await store.instance(apps[name]!))?.state)), ['asleep', 'asleep', 'awake']);
});

const RUNNER = 'pneuma-space-runner';
const runner = (ordinal: number) => `${RUNNER}-${ordinal}`;

/** An isolate driver that places a first wake on the runner `home` names, as the pool's `place()` does. */
class Placing extends FakeDriver {
  home = runner(0);
  constructor() {
    super('isolate');
  }
  place(): string {
    return this.home;
  }
}

/** A registry over a real isolate Lifecycle on a real store, and KubeInfra over a platform namespace whose runner and gateway hold `replicas`. */
async function runners(t: TestContext, replicas: Record<string, number>) {
  const w = world();
  const store = new SqliteStore(join(w.dir, 'scale.sqlite3'));
  const instances = new Instances(store, { replica: 'gw-0' as ReplicaId });
  await instances.ready();
  t.after(() => instances.close());
  let registry: PlatformRegistry | null = null;
  const specFor = (app: AppId): RunSpec | null => registry?.runSpec(app) ?? null;
  const driver = new Placing();
  const runtime = new Runtimes({ runtimes: [new Lifecycle(driver, { specFor, instances })], specFor, instances });
  const k8s = await fakeKubernetes(t, replicas);
  registry = await PlatformRegistry.open({
    store, runtime, guard: w.runtime, infra: k8s.infra, bundles: w.bundles, providers: [...w.providers.values()], probe: async () => true,
  });
  const code = await w.bundles.put(Readable.from([Buffer.from('app dir')]));
  /** Publishes an isolate app and wakes it once, so its row names `home`. */
  const homed = async (name: string, home: string, capabilities: Capabilities = {}) => {
    driver.home = home;
    const release = await registry!.publish({ name: appName(name), image: null, manifest: parseManifest({ contract: 1, runtime: 'isolate', capabilities }), bundle: code, owner: subject('user:ann') });
    runtime.release(await runtime.acquire(release.app, 'request'));
    assert.equal((await store.instance(release.app))?.home, home);
    return appName(name);
  };
  const purge = async (name: AppName) => {
    await registry!.remove(name);
    await registry!.purge(name);
  };
  return { registry, store, k8s, homed, purge };
}

const refusal = (homes: readonly (readonly [string, string])[]) => (error: unknown) =>
  error instanceof Stranded && error.workload === RUNNER && JSON.stringify(error.homes.map((h) => [h.app, h.home])) === JSON.stringify(homes)
  && homes.every(([app, home]) => error.message.includes(`${app} (${home})`));

test('a runner scale-down that removes no replica an instance row names as home reaches Kubernetes once (ADR 0032)', async (t) => {
  const { registry, k8s, homed } = await runners(t, { [RUNNER]: 3 });
  await homed('notes', runner(0), { files: {} });
  await homed('quiz', runner(1));
  await registry.scale(RUNNER, 2);
  assert.deepEqual([k8s.seen, k8s.replicas[RUNNER]], [[`PATCH /apis/apps/v1/namespaces/pneuma-space/statefulsets/${RUNNER}/scale`], 2]);
});

for (const [kind, capabilities] of [['files', { files: {} }], ['no storage', {}]] as const) {
  test(`an app with ${kind} homed on the replica a scale-down removes refuses it before any Kubernetes call, until the app is purged (ADR 0032)`, async (t) => {
    const { registry, k8s, homed, purge } = await runners(t, { [RUNNER]: 3 });
    const notes = await homed('notes', runner(2), capabilities);
    await assert.rejects(registry.scale(RUNNER, 2), refusal([['notes', runner(2)]]));
    assert.deepEqual([k8s.seen, k8s.replicas[RUNNER]], [[], 3]);
    await purge(notes);
    await registry.scale(RUNNER, 2);
    assert.equal(k8s.replicas[RUNNER], 2);
  });
}

test('an asleep app homed on a replica a scale-down removes refuses it (ADR 0032)', async (t) => {
  const { registry, store, k8s, homed } = await runners(t, { [RUNNER]: 3 });
  const notes = await homed('notes', runner(2));
  await registry.stop(notes);
  assert.equal((await store.instance(registry.view(notes)!.app))?.state, 'asleep');
  await assert.rejects(registry.scale(RUNNER, 2), refusal([['notes', runner(2)]]));
  assert.deepEqual(k8s.seen, []);
});

test('a removed app not yet purged, homed on a replica a scale-down removes, refuses it (ADR 0032)', async (t) => {
  const { registry, k8s, homed } = await runners(t, { [RUNNER]: 3 });
  await registry.remove(await homed('notes', runner(2), { files: {} }));
  await assert.rejects(registry.scale(RUNNER, 2), refusal([['notes', runner(2)]]));
  assert.deepEqual(k8s.seen, []);
});

test('a runner scale-down past two replicas holding homes names both replicas and both apps (ADR 0032)', async (t) => {
  const { registry, k8s, homed } = await runners(t, { [RUNNER]: 3 });
  await homed('notes', runner(0));
  await homed('quiz', runner(2));
  await homed('chess', runner(1), { files: {} });
  await assert.rejects(registry.scale(RUNNER, 1), refusal([['chess', runner(1)], ['quiz', runner(2)]]));
  assert.deepEqual(k8s.seen, []);
});

test('a runner scale-up is accepted with homes on every replica (ADR 0032)', async (t) => {
  const { registry, k8s, homed } = await runners(t, { [RUNNER]: 2 });
  await homed('notes', runner(0), { files: {} });
  await homed('quiz', runner(1), { files: {} });
  await registry.scale(RUNNER, 3);
  assert.equal(k8s.replicas[RUNNER], 3);
});

test('a gateway scale-down is never refused by runner homes (ADR 0032)', async (t) => {
  const { registry, k8s, homed } = await runners(t, { [RUNNER]: 3, 'pneuma-space-gateway': 3 });
  await homed('notes', runner(2), { files: {} });
  await registry.scale('pneuma-space-gateway', 1);
  assert.deepEqual(k8s.replicas, { [RUNNER]: 3, 'pneuma-space-gateway': 1 });
});

test('a home already on a replica the StatefulSet no longer has refuses every count that still leaves it out, scale-ups included (ADR 0032 item 4)', async (t) => {
  const { registry, k8s, homed } = await runners(t, { [RUNNER]: 2 });
  await homed('notes', runner(3));
  await assert.rejects(registry.scale(RUNNER, 3), refusal([['notes', runner(3)]]));
  await registry.scale(RUNNER, 4);
  assert.equal(k8s.replicas[RUNNER], 4);
});
