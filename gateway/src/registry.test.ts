import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Ingress } from './ingress.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { Conflict, InputError, appName, parseManifest, subject, triggerName, type App, type AppId, type BundleId, type Capabilities, type Change, type Store, type StoreOps } from './model.ts';
import { PlatformRegistry } from './registry.ts';
import { FakeRuntime, world } from './registry.fakes.ts';
import { DeliveryScheduler } from './scheduler.ts';

const survey = appName('survey');
const ann = subject('user:ann');

function publish(registry: PlatformRegistry, capabilities: Record<string, unknown>, image = 'example:1', owner = ann) {
  const manifest = parseManifest({ contract: 1, capabilities: capabilities as Capabilities });
  return registry.publish({ name: survey, image, manifest, bundle: null, owner });
}

test('identical inputs publish one release; a new image becomes release 2 under the same app id', async () => {
  const { registry, store } = await world().open();
  const first = await publish(registry, { kv: {} });
  const again = await publish(registry, { kv: {} });
  const second = await publish(registry, { kv: {} }, 'example:2');
  assert.deepEqual([first.number, again.number, second.number], [1, 1, 2]);
  assert.equal(second.app, first.app);
  assert.equal((await store.releases(first.app)).length, 2);
});

test('dropping kv from the manifest suspends its binding and keeps the row', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await publish(registry, { kv: {} });
  assert.deepEqual((await store.bindings(app)).map((b) => b.state), ['active']);
  await publish(registry, {});
  assert.deepEqual((await store.bindings(app)).map((b) => [b.kind, b.state]), [['kv', 'suspended']]);
  assert.deepEqual(w.calls, [['ensure', 'redis', app], ['suspend', 'redis', app]]);
});

test('remove marks the app removed and suspends every binding', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await publish(registry, { kv: {}, files: {} });
  await registry.remove(survey);
  assert.equal(registry.view(survey)?.status, 'removed');
  assert.deepEqual((await store.bindings(app)).map((b) => b.state), ['suspended', 'suspended']);
  assert.deepEqual(w.calls.filter(([verb]) => verb === 'suspend').map(([, p]) => p).sort(), ['redis', 'volume']);
});

test('purge is refused while the app is registered', async () => {
  const { registry } = await world().open();
  await publish(registry, { kv: {} });
  await assert.rejects(registry.purge(survey), Conflict);
});

test('purge after remove destroys every binding and deletes the rows', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await publish(registry, { kv: {}, files: {} });
  await registry.remove(survey);
  await registry.purge(survey);
  assert.deepEqual(w.calls.filter(([verb]) => verb === 'destroy').map(([, p]) => p).sort(), ['redis', 'volume']);
  assert.equal(await store.app(survey), null);
  assert.deepEqual([await store.bindings(app), await store.releases(app), registry.view(survey)], [[], [], null]);
});

test('a purge interrupted after the first destroy finishes on resume after restart', async () => {
  const w = world();
  const { registry } = await w.open();
  const { app } = await publish(registry, { files: {}, kv: {} });
  await registry.remove(survey);
  w.providers.get('redis')!.fail = 'destroy';
  await assert.rejects(registry.purge(survey), /redis destroy failed/);

  const restarted = await w.open();
  assert.equal(restarted.registry.view(survey)?.status, 'purging');
  await restarted.registry.resume();
  assert.equal(await restarted.store.app(survey), null);
  assert.deepEqual(await restarted.store.bindings(app), []);
  assert.deepEqual(w.calls.filter(([verb]) => verb === 'destroy').map(([, p]) => p), ['volume', 'redis', 'volume', 'redis']);
});

test('switching db_backend ensures a second db binding, suspends the first and emits AppChanged', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await publish(registry, { db: {} });
  const changed: AppId[] = [];
  registry.onAppChanged((id) => changed.push(id));
  await registry.setAppPolicy(survey, { db_backend: 'postgres' });
  assert.deepEqual((await store.bindings(app)).map((b) => [b.provider, b.state]), [['postgres', 'active'], ['sqlite', 'suspended']]);
  assert.deepEqual(changed, [app]);
  assert.equal(registry.runSpec(app)?.injection.env.FAKE_POSTGRES, (await store.bindings(app))[0].resource.name);
});

test('a global-only policy field is refused in a per-app override', async () => {
  const { registry } = await world().open();
  await publish(registry, {});
  await assert.rejects(async () => registry.setAppPolicy(survey, { usage_retention_days: 30 } as never), InputError);
});

test('clearing db_backend is refused once the app has a db binding', async () => {
  const { registry } = await world().open();
  await publish(registry, { db: {} });
  await assert.rejects(registry.setAppPolicy(survey, { db_backend: null }), Conflict);
});

test('a publish that fails after one ensure is adopted by the next publish after restart', async () => {
  const w = world();
  const { registry, store } = await w.open();
  w.providers.get('s3')!.fail = 'ensure';
  await assert.rejects(publish(registry, { kv: {}, object: {} }), /s3 ensure failed/);
  const id = (await store.app(survey))!.id;
  const [kvRow] = await store.bindings(id);

  const restarted = await w.open();
  const release = await publish(restarted.registry, { kv: {}, object: {} });
  assert.equal(release.app, id);
  const rows = await restarted.store.bindings(id);
  assert.deepEqual(rows.map((b) => [b.kind, b.state]), [['kv', 'active'], ['object', 'active']]);
  assert.deepEqual(rows[0].resource, kvRow.resource);
});

test('the first publish requires an owner', async () => {
  const { registry, store } = await world().open();
  await assert.rejects(publish(registry, {}, 'example:1', null as never), InputError);
  assert.equal(await store.app(survey), null);
});

test('owner is ignored after the first publish and changed by setOwner', async () => {
  const { registry } = await world().open();
  await publish(registry, {});
  await publish(registry, {}, 'example:2', subject('user:bob'));
  assert.equal(registry.view(survey)?.owner, ann);
  await registry.setOwner(survey, subject('user:bob'));
  assert.equal(registry.view(survey)?.owner, 'user:bob');
});

test('after purge, a stats flush and a scheduler reload leave no row of the app behind', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await publish(registry, { cron: { triggers: { nightly: {} } } });
  const scheduler = new DeliveryScheduler({ store, runtime: w.runtime, view: (id) => registry.schedule(id), log: () => {} });
  await scheduler.invoke({ app, trigger: triggerName('nightly'), caller: ann, idempotencyKey: null, body: new Uint8Array() });
  const ingress = new Ingress({
    registry, runtime: w.runtime, bundles: w.bundles, scheduler,
    identity: { authenticate: async () => ({ status: 401 }), serve: async () => {} },
    stats: [{ app, requests: 3, errors: 0, lastAccessAt: 1 }],
    flushStats: (stats) => store.putStats(stats),
    deleteStats: (id) => store.deleteStats(id),
  });
  registry.onAppChanged((id) => {
    void scheduler.reload(id);
    if (registry.schedule(id) === null) void ingress.forget(id);
  });
  await registry.remove(survey);
  await registry.purge(survey);
  await ingress.flush();
  assert.deepEqual([await store.stats(), await store.deliveries({ app })], [[], []]);
});

test('purge deletes the bundles only its releases reference and keeps one shared with another app or not yet published', async () => {
  const w = world();
  const { registry } = await w.open();
  const put = (text: string) => w.bundles.put(Readable.from([Buffer.from(text)]));
  const site = (name: string, bundle: BundleId) => registry.publish({
    name: appName(name), image: null, manifest: parseManifest({ contract: 1, capabilities: { static: { dir: 'dist' } } }), bundle, owner: ann,
  });
  const [shared, own] = [await put('shared'), await put('own')];
  await site('survey', shared);
  await site('survey', own);
  await site('blog', shared);
  const pending = await put('pending');
  await registry.remove(survey);
  await registry.purge(survey);
  assert.deepEqual([...w.bundles.stored].sort(), [shared, pending].sort());
});

test('a purge interrupted while the app had a live container finishes when reconcile runs before resume', async () => {
  const w = world();
  const { registry } = await w.open();
  const { app } = await publish(registry, { files: {} });
  await registry.remove(survey);
  w.runtime.containers.add(app);
  w.runtime.reconciled = false;
  await assert.rejects(registry.purge(survey), Conflict);

  const restarted = await w.open();
  await w.runtime.reconcile();
  await restarted.registry.resume();
  assert.equal(await restarted.store.app(survey), null);
});

test('a second remove retries a suspend that failed during the first', async () => {
  const w = world();
  const { registry } = await w.open();
  const { app } = await publish(registry, { kv: {} });
  w.providers.get('redis')!.fail = 'suspend';
  await registry.remove(survey);
  await registry.remove(survey);
  assert.deepEqual(w.calls.filter(([verb]) => verb === 'suspend'), [['suspend', 'redis', app], ['suspend', 'redis', app]]);
});

test('runSpec, which every acquire reads, makes no store read', async () => {
  const w = world();
  const { store } = await w.open();
  let reads = 0;
  const counting = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? (...args: unknown[]) => (reads++, value.apply(target, args)) : value;
    },
  });
  const registry = await PlatformRegistry.open({ store: counting, runtime: w.runtime, guard: w.runtime, infra: w.runtime, bundles: w.bundles, providers: [...w.providers.values()] });
  const { app } = await publish(registry, { kv: {} });
  reads = 0;
  for (let i = 0; i < 3; i++) assert.equal(registry.runSpec(app)?.release, 1);
  assert.equal(reads, 0);
});

test('republishing a removed app starts its schedules at the republish, not at the reused release', async () => {
  const { registry } = await world().open();
  const { app } = await publish(registry, { cron: { triggers: { nightly: { schedule: '0 3 * * *' } } } });
  await registry.remove(survey);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const republishedAt = Date.now();
  const again = await publish(registry, { cron: { triggers: { nightly: { schedule: '0 3 * * *' } } } });
  assert.equal(again.number, 1);
  assert.ok(registry.schedule(app)!.publishedAt >= republishedAt);
});

test('the listing carries the sleepsAt the Runtime answers', async () => {
  const w = world();
  const { store } = await w.open();
  const runtime = Object.assign(new FakeRuntime(), { sleepsAt: () => 1_800_000_000_000 });
  const registry = await PlatformRegistry.open({ store, runtime, guard: runtime, infra: runtime, bundles: w.bundles, providers: [...w.providers.values()] });
  await publish(registry, {});
  assert.equal((await registry.listing())[0].sleepsAt, 1_800_000_000_000);
});

test('publish derives runtime container from an image and isolate from a code bundle', async () => {
  const w = world();
  w.services.add('runner');
  const { registry } = await w.open();
  const bundle = await w.bundles.put(Readable.from([Buffer.from('app dir')]));
  const manifest = parseManifest({ contract: 1, capabilities: { kv: {} } });
  const container = await publish(registry, { kv: {} });
  const isolate = await registry.publish({ name: appName('quiz'), image: null, manifest, bundle, owner: ann });
  assert.deepEqual([container.runtime, isolate.runtime], ['container', 'isolate']);
  assert.deepEqual(registry.runSpec(isolate.app)?.runtime, { kind: 'isolate', bundle, entry: 'src/server.ts' });
});

test('an isolate publish while the runner is absent is refused with Conflict', async () => {
  const w = world();
  const { registry } = await w.open();
  const bundle = await w.bundles.put(Readable.from([Buffer.from('app dir')]));
  const manifest = parseManifest({ contract: 1, runtime: 'isolate', capabilities: {} });
  await assert.rejects(registry.publish({ name: survey, image: null, manifest, bundle, owner: ann }), (e) => e instanceof Conflict && /--profile isolate/.test(e.message));
});

test('republishing an unchanged isolate app returns the current release while the runner is absent (INV-6)', async () => {
  const w = world();
  w.services.add('runner');
  const { registry } = await w.open();
  const bundle = await w.bundles.put(Readable.from([Buffer.from('app dir')]));
  const request = { name: survey, image: null, manifest: parseManifest({ contract: 1, runtime: 'isolate', capabilities: {} }), bundle, owner: ann };
  const first = await registry.publish(request);
  w.services.delete('runner');
  assert.deepEqual(await registry.publish(request), first);
});

test('a refresh that read an older app version than the view holds is not applied', async () => {
  const w = world();
  const { store } = await w.open();
  let stale: App | null = null;
  const listeners: ((change: Change) => void)[] = [];
  const reads = new Proxy(store, {
    get(target, key) {
      if (key === 'onChange') return (listener: (change: Change) => void) => listeners.push(listener);
      if (key === 'transaction') {
        return <T>(fn: (tx: StoreOps) => Promise<T>) => target.transaction((tx) => fn(stale ? { ...tx, app: async () => stale } : tx));
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Store;
  const registry = await PlatformRegistry.open({
    store: reads, runtime: w.runtime, guard: w.runtime, infra: w.runtime, bundles: w.bundles, providers: [...w.providers.values()],
  });
  await publish(registry, {});
  const older = await store.app(survey);
  await registry.setOwner(survey, subject('user:bob'));
  stale = older;
  for (const listener of listeners) listener({ kind: 'app', name: survey });
  await sleep(50);
  assert.equal(registry.view(survey)?.owner, 'user:bob');
});
