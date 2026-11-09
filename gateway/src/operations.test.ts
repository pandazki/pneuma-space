import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Instances } from './instances.ts';
import { Lifecycle } from './lifecycle.ts';
import { FakeDriver } from './lifecycle.fakes.ts';
import { appName, parseManifest, subject, type AppId, type AppName, type ReplicaId, type RunSpec } from './model.ts';
import { PlatformRegistry } from './registry.ts';
import { world } from './registry.fakes.ts';
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
