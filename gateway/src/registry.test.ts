import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Ingress } from './ingress.ts';
import { Series } from './metrics.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Conflict, DEFAULT_TENANT, InputError, QuotaExceeded, appName, managerName, parseManifest, subject, tenantName, triggerName,
  type App, type AppId, type BundleId, type Capabilities, type Change, type ManagerName, type PublishRequest, type ReleaseNumber, type Store, type StoreOps,
} from './model.ts';
import { PlatformRegistry } from './registry.ts';
import { replicaContract } from './registry.contract.ts';
import { FakeRuntime, world } from './registry.fakes.ts';
import { SqliteSession, SqliteStore } from './store.ts';
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
    stats: [{ app, lastAccessAt: 1 }],
    flushStats: (stats) => store.putStats(stats),
    deleteStats: (id) => store.deleteStats(id),
    series: new Series(),
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

/** Ingress as main wires its Stats for `registry`, loaded from `store` now. */
async function statsOn(registry: PlatformRegistry, store: Store) {
  const ingress = new Ingress({
    registry, stats: await store.stats(), flushStats: (stats) => store.putStats(stats), deleteStats: (id) => store.deleteStats(id),
  } as never);
  registry.onAppChanged((id) => void (registry.schedule(id) === null && ingress.forget(id)));
  return ingress;
}

test('a purge through one replica leaves no Stats row once both replicas flush, and later flushes keep it gone (#19)', async () => {
  const w = world();
  const { store, registry: one } = await w.open();
  const two = await w.replica(store);
  const { app } = await publish(one, {});
  const blog = await one.publish({ name: appName('blog'), image: 'example:1', manifest: parseManifest({ contract: 1, capabilities: {} }), bundle: null, owner: ann });
  await store.putStats([app, blog.app].map((id) => ({ app: id, requests: 1, errors: 0, lastAccessAt: 1 })));
  for (let waited = 0; two.view(appName('blog')) === null; waited += 5) {
    assert.ok(waited < 2000, 'the other replica loaded blog');
    await sleep(5);
  }
  const ingresses = [await statsOn(one, store), await statsOn(two, store)];
  await one.remove(survey);
  await one.purge(survey);
  for (let waited = 0; two.view(survey) !== null; waited += 5) {
    assert.ok(waited < 2000, 'the other replica dropped survey');
    await sleep(5);
  }
  for (let round = 0; round < 3; round++) for (const ingress of ingresses) await ingress.flush();
  assert.deepEqual((await store.stats()).map((s) => s.app), [blog.app]);
});

test('a Stats row whose app is gone is not loaded at startup and is deleted by the first flush (#19)', async () => {
  const { store, registry } = await world().open();
  const { app } = await publish(registry, {});
  await store.putStats([app, 'a-gone' as AppId].map((id) => ({ app: id, requests: 1, errors: 0, lastAccessAt: 1 })));
  const ingress = await statsOn(registry, store);
  assert.deepEqual(ingress.snapshot().map((s) => s.app), [app]);
  await ingress.flush();
  assert.deepEqual((await store.stats()).map((s) => s.app), [app]);
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

async function quotaWorld(quota: Record<string, number | null>) {
  const w = world();
  const opened = await w.open();
  await opened.registry.createTenant(blue, 'Blue', ['ann']);
  await opened.registry.setQuota(blue, quota);
  return { ...opened, w };
}

const blue = tenantName('blue');

function publishIn(registry: PlatformRegistry, name: string, capabilities: Record<string, unknown>, image = 'example:1') {
  const manifest = parseManifest({ contract: 1, capabilities: capabilities as Capabilities });
  return registry.publish({ name: appName(name), image, manifest, bundle: null, owner: ann, tenant: blue });
}

test('a republish of an app is never refused, even with the tenant over its apps and storage quotas', async () => {
  const { registry } = await quotaWorld({ apps: 1, storage_gb: 1 });
  await publishIn(registry, 'one', { files: {} });
  await registry.setQuota(blue, { apps: 0, storage_gb: 0 });
  assert.equal((await publishIn(registry, 'one', { files: {} }, 'example:2')).number, 2);
});

test('storage_gb counts only bindings a publish would create, and only files and SQLite ones', async () => {
  const { registry } = await quotaWorld({ storage_gb: 2 });
  await publishIn(registry, 'one', { files: {}, db: {} });
  await publishIn(registry, 'one', { files: {}, db: {}, kv: {}, object: {} }, 'example:2');
  await assert.rejects(publishIn(registry, 'two', { db: {} }), (error: unknown) =>
    error instanceof QuotaExceeded && JSON.stringify(error.refusal) === JSON.stringify({ resource: 'storage_gb', used: 2, limit: 2, ask: 1 }));
});

test('AC-SAAS-8 revocation during preparation leaves the previous release active', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const first = await publish(registry, { kv: {} });
  const provider = w.providers.get('redis')!;
  const ensure = provider.ensure.bind(provider);
  let authorized = true;
  provider.ensure = async (...args) => {
    const resource = await ensure(...args);
    authorized = false;
    return resource;
  };
  await assert.rejects(registry.publish({
    name: survey, image: 'example:2', manifest: parseManifest({ contract: 1, capabilities: { kv: {} } }), bundle: null, owner: ann,
    authorize: async () => { if (!authorized) throw new Conflict('credential revoked'); },
  }), /credential revoked/);
  assert.equal((await store.app(survey))?.current, first.number);
  assert.equal((await store.releases(first.app)).length, 1);
  assert.equal((await store.bindings(first.app))[0].state, 'active');
});

test('AC-SAAS-6 hosted default access changes new apps only', async () => {
  const w = world();
  const { store, registry } = await w.open();
  await publish(registry, {});
  const hosted = await PlatformRegistry.open({ store, runtime: w.runtime, guard: w.runtime, infra: w.runtime, bundles: w.bundles, providers: [], defaultAccess: 'tenant' });
  await hosted.publish({ name: appName('private-app'), image: 'example:1', manifest: parseManifest({ contract: 1, capabilities: {} }), bundle: null, owner: ann });
  assert.equal((await store.app(appName('private-app')))?.access, 'tenant');
  assert.equal((await store.app(survey))?.access, 'org');
});

replicaContract('SQLite', async () => {
  const store = new SqliteStore(join(world().dir, 'replicas.sqlite3'));
  return [store, store];
});

const green = tenantName('green');
const files = parseManifest({ contract: 1, capabilities: { files: {} } });

for (const crash of [false, true]) {
  test(`${crash ? 'a gateway that dies before ensure' : 'a failed ensure'} leaves the storage binding counted; the next publish adopts it without asking again and purge frees it (#11)`, async () => {
    const w = world();
    let { registry, store } = await w.open();
    await registry.createTenant(blue, 'Blue', ['ann']);
    await registry.setQuota(blue, { storage_gb: 1 });
    const volume = w.providers.get('volume')!;
    if (crash) {
      let entered!: () => void;
      const ensuring = new Promise<void>((resolve) => (entered = resolve));
      volume.ensure = () => (entered(), new Promise(() => {}));
      void publishIn(registry, 'one', { files: {} });
      await ensuring;
      Reflect.deleteProperty(volume, 'ensure');
      ({ registry, store } = await w.open());
      await registry.resume();
    } else {
      volume.fail = 'ensure';
      await assert.rejects(publishIn(registry, 'one', { files: {} }), /volume ensure failed/);
    }
    const { id } = (await store.app(appName('one')))!;
    assert.deepEqual((await store.bindings(id)).map((b) => [b.provider, b.state]), [['volume', 'suspended']]);
    assert.equal((await store.quotaUsed(blue)).storage_gb, 1);
    await publishIn(registry, 'one', { files: {} });
    assert.equal((await store.quotaUsed(blue)).storage_gb, 1);
    await registry.remove(appName('one'));
    await registry.purge(appName('one'));
    assert.equal((await store.quotaUsed(blue)).storage_gb, 0);
  });
}

test('refusals in a full tenant leave a republish there and a publish into another tenant at the same moment untouched (#11)', async () => {
  const { registry } = await quotaWorld({ storage_gb: 1 });
  await registry.createTenant(green, 'Green', ['ann']);
  await registry.setQuota(green, { storage_gb: 1 });
  await publishIn(registry, 'held', { files: {} });
  const outcomes = await Promise.allSettled([
    publishIn(registry, 'over', { files: {} }),
    publishIn(registry, 'held', { files: {} }, 'example:2'),
    registry.publish({ name: appName('elsewhere'), image: 'example:1', manifest: files, bundle: null, owner: ann, tenant: green }),
  ]);
  const seen = outcomes.map((o) => (o.status === 'fulfilled' ? 'published' : o.reason instanceof QuotaExceeded ? o.reason.refusal.resource : String(o.reason)));
  assert.deepEqual(seen, ['storage_gb', 'published', 'published']);
});

test('switching db_backend to sqlite past storage_gb is refused with quota-refused and leaves the override and bindings as they were (#12)', async () => {
  const refusals: unknown[] = [];
  const { registry, store } = await world().open({ quotaRefused: (error, app, action) => refusals.push([error.refusal.resource, app, action]) });
  await registry.setGlobalPolicy({ db_backend: 'postgres' });
  await registry.createTenant(blue, 'Blue', ['ann']);
  await registry.setQuota(blue, { storage_gb: 0 });
  const { app } = await publishIn(registry, 'one', { db: {} });
  const rows = async () => JSON.stringify([await store.app(appName('one')), await store.bindings(app)]);
  const before = await rows();
  await assert.rejects(registry.setAppPolicy(appName('one'), { db_backend: 'sqlite' }), (error) => error instanceof QuotaExceeded && error.refusal.resource === 'storage_gb');
  assert.equal(await rows(), before);
  assert.equal((await store.quotaUsed(blue)).storage_gb, 0);
  assert.deepEqual(refusals, [['storage_gb', 'one', 'policy']]);
});

test('switching db_backend from postgres to sqlite and back and forth asks storage_gb for the first SQLite binding only (#12)', async () => {
  const { registry, store } = await quotaWorld({ storage_gb: 1 });
  await registry.setGlobalPolicy({ db_backend: 'postgres' });
  await publishIn(registry, 'one', { db: {} });
  const used: number[] = [];
  for (const db_backend of ['sqlite', 'postgres', 'sqlite'] as const) {
    await registry.setAppPolicy(appName('one'), { db_backend });
    used.push((await store.quotaUsed(blue)).storage_gb);
  }
  assert.deepEqual(used, [1, 1, 1]);
});

function site(registry: PlatformRegistry, name: string, bundle: BundleId) {
  return registry.publish({ name: appName(name), image: null, manifest: parseManifest({ contract: 1, capabilities: { static: { dir: 'dist' } } }), bundle, owner: ann });
}

test('the purge of the last app that references a bundle deletes it (#13)', async () => {
  const w = world();
  const { registry } = await w.open();
  const shared = await w.bundles.put(Readable.from([Buffer.from('shared')]));
  await site(registry, 'survey', shared);
  await site(registry, 'blog', shared);
  const kept: boolean[] = [];
  for (const name of [survey, appName('blog')]) {
    await registry.remove(name);
    await registry.purge(name);
    kept.push(w.bundles.stored.has(shared));
  }
  assert.deepEqual(kept, [true, false]);
});

test('a purge interrupted after its bundle delete finishes when rerun, and deleting the bundle again is fine (#13)', async () => {
  const w = world();
  const { registry } = await w.open();
  const own = await w.bundles.put(Readable.from([Buffer.from('own')]));
  await site(registry, 'survey', own);
  await registry.remove(survey);
  const remove = w.bundles.delete.bind(w.bundles);
  let crashes = 2;
  w.bundles.delete = async (id) => {
    await remove(id);
    if (crashes-- > 0) throw new Error('crashed after the delete');
  };
  await assert.rejects(registry.purge(survey), /crashed after the delete/);
  const restarted = await w.open();
  await restarted.registry.resume();
  assert.equal((await restarted.store.app(survey))?.status, 'purging');
  await restarted.registry.purge(survey);
  assert.deepEqual([await restarted.store.app(survey), w.bundles.stored.has(own)], [null, false]);
});

test('purge issues the same SQL statements whether 10 or 1000 other apps have releases (#13)', async () => {
  const statements = async (others: number) => {
    const w = world();
    const { store } = await w.open();
    const manifest = parseManifest({ contract: 1, capabilities: { static: { dir: 'dist' } } });
    await store.transaction(async (tx) => {
      for (let i = 0; i < others; i++) {
        const bundle = `other-${i}` as BundleId;
        const id = `id-other-${i}` as AppId;
        w.bundles.stored.add(bundle);
        await tx.putApp({ name: appName(`other-${i}`), id, tenant: DEFAULT_TENANT, access: 'org', owner: ann, status: 'registered', current: 1 as ReleaseNumber, policyOverride: {}, registeredAt: 0, version: 1 });
        await tx.putRelease({ app: id, number: 1 as ReleaseNumber, image: null, manifest, bundle, runtime: null, releaseKey: bundle, publishedAt: 0 });
      }
    });
    const { registry } = await w.open();
    await site(registry, 'survey', await w.bundles.put(Readable.from([Buffer.from('own')])));
    await registry.remove(survey);
    let count = 0;
    const { all, run } = SqliteSession.prototype;
    SqliteSession.prototype.all = function (...args) {
      count++;
      return all.apply(this, args);
    };
    SqliteSession.prototype.run = function (...args) {
      count++;
      return run.apply(this, args);
    };
    try {
      await registry.purge(survey);
    } finally {
      Object.assign(SqliteSession.prototype, { all, run });
    }
    return count;
  };
  assert.equal(await statements(1000), await statements(10));
});

test('a replica that indexed a bundle another replica purged refuses a release against it (#13)', async () => {
  const w = world();
  const { store, registry: purger } = await w.open();
  const stale = await w.replica(store);
  const bundle = await w.bundles.put(Readable.from([Buffer.from('purged')]));
  await site(purger, 'survey', bundle);
  for (let waited = 0; stale.view(survey)?.bundle?.id !== bundle; waited += 5) {
    assert.ok(waited < 2000, 'the other replica indexed the bundle');
    await sleep(5);
  }
  await purger.remove(survey);
  await purger.purge(survey);
  await assert.rejects(site(stale, 'blog', bundle), (error) => error instanceof Conflict && /upload/.test(error.message));
  const blog = await store.app(appName('blog'));
  assert.deepEqual(blog ? (await store.releases(blog.id)).map((r) => r.bundle) : [], []);
});

function publishOn(registry: PlatformRegistry, runtime: 'container' | 'isolate', capabilities: Record<string, unknown>, code: BundleId) {
  const manifest = parseManifest({ contract: 1, runtime, capabilities: capabilities as Capabilities });
  return registry.publish({ name: survey, image: runtime === 'container' ? 'example:1' : null, manifest, bundle: runtime === 'isolate' ? code : null, owner: ann });
}

for (const [storage, capabilities] of [['files', { files: {} }], ['a SQLite database', { db: {} }]] as const) {
  for (const [from, to] of [['container', 'isolate'], ['isolate', 'container']] as const) {
    test(`a release moving an app with ${storage} from ${from} to ${to} is refused with 409 before anything changes (#14)`, async () => {
      const w = world();
      w.services.add('runner');
      const { registry, store } = await w.open();
      const code = await w.bundles.put(Readable.from([Buffer.from('app dir')]));
      const { app } = await publishOn(registry, from, capabilities, code);
      const state = async () => JSON.stringify([await store.app(survey), await store.releases(app), await store.bindings(app), registry.runSpec(app), w.calls]);
      const before = await state();
      await assert.rejects(publishOn(registry, to, capabilities, code), (error) =>
        error instanceof Conflict && [`"${survey}"`, `"${from}"`, `"${to}"`, 'new name', 'purge'].every((part) => error.message.includes(part)));
      assert.equal(await state(), before);
      assert.deepEqual(w.runtime.calls.filter((call) => call.startsWith('retire')), []);
    });
  }
}

test('an app whose database is PostgreSQL, and one without storage, may change runtime (#14)', async () => {
  const w = world();
  w.services.add('runner');
  const { registry } = await w.open();
  await registry.setGlobalPolicy({ db_backend: 'postgres' });
  const moved: unknown[] = [];
  for (const capabilities of [{ db: {} }, { kv: {}, object: {} }]) {
    const code = await w.bundles.put(Readable.from([Buffer.from(JSON.stringify(capabilities))]));
    await publishOn(registry, 'container', capabilities, code);
    moved.push((await publishOn(registry, 'isolate', capabilities, code)).runtime);
    await registry.remove(survey);
    await registry.purge(survey);
  }
  assert.deepEqual(moved, ['isolate', 'isolate']);
});

test('a static-only release in between does not let an app with files change runtime (#14)', async () => {
  const w = world();
  w.services.add('runner');
  const { registry } = await w.open();
  const code = await w.bundles.put(Readable.from([Buffer.from('app dir')]));
  await publishOn(registry, 'container', { files: {} }, code);
  await site(registry, 'survey', await w.bundles.put(Readable.from([Buffer.from('site')])));
  await assert.rejects(publishOn(registry, 'isolate', { files: {} }, code), Conflict);
});

test('after remove and purge, the name of an app with files publishes under the other runtime (#14)', async () => {
  const w = world();
  w.services.add('runner');
  const { registry } = await w.open();
  const code = await w.bundles.put(Readable.from([Buffer.from('app dir')]));
  await publishOn(registry, 'container', { files: {} }, code);
  await registry.remove(survey);
  await registry.purge(survey);
  assert.equal((await publishOn(registry, 'isolate', { files: {} }, code)).runtime, 'isolate');
});

const trial = appName('trial');

function temporary(registry: PlatformRegistry, capabilities: Record<string, unknown>, ttlSeconds: number | null = null, name = trial, extra: Partial<PublishRequest> = {}) {
  const manifest = parseManifest({ contract: 1, capabilities: capabilities as Capabilities });
  return registry.publish({ name, image: 'example:1', manifest, bundle: null, owner: ann, ephemeral: { ttlSeconds }, ...extra });
}

test('AC-EPH-1 an ephemeral first publish ends after the default ttl, at access tenant, and the listing says when', async () => {
  const { registry } = await world().open();
  const before = Date.now();
  await temporary(registry, {});
  const [row] = await registry.listing();
  assert.ok(row.expiresAt! >= before + 600_000 && row.expiresAt! <= Date.now() + 600_000, `expiresAt ${row.expiresAt}`);
  assert.equal(row.access, 'tenant');
});

for (const [first, then] of [['durable', 'ephemeral'], ['ephemeral', 'durable']] as const) {
  test(`AC-EPH-1 publishing a ${first} app as ${then} is refused with Conflict and changes nothing`, async () => {
    const { registry, store } = await world().open();
    const release = (kind: string, image: string) => registry.publish({
      name: survey, image, manifest: parseManifest({ contract: 1, capabilities: { kv: {} } }), bundle: null, owner: ann, ...(kind === 'ephemeral' && { ephemeral: { ttlSeconds: null } }),
    });
    const { app } = await release(first, 'example:1');
    const state = async () => JSON.stringify([await store.app(survey), await store.releases(app), await store.bindings(app)]);
    const before = await state();
    await assert.rejects(release(then, 'example:2'), Conflict);
    assert.equal(await state(), before);
  });
}

test('AC-EPH-1 a ttl above ephemeral_max_ttl_seconds is refused and creates no app', async () => {
  const { registry, store } = await world().open();
  await assert.rejects(temporary(registry, {}, 3601), InputError);
  assert.equal(await store.app(trial), null);
});

test('AC-EPH-1 republishing an ephemeral app, with a ttl or without, keeps its end', async () => {
  const { registry } = await world().open();
  await temporary(registry, {}, 60);
  const end = registry.view(trial)!.expiresAt;
  await sleep(5);
  const second = await temporary(registry, {}, 3600, trial, { image: 'example:2' });
  const third = await temporary(registry, {}, null, trial, { image: 'example:1' });
  assert.deepEqual([second.number, third.number, registry.view(trial)!.expiresAt], [2, 3, end]);
});

test('AC-EPH-1 an ephemeral app\'s access stays tenant', async () => {
  const { registry } = await world().open();
  await temporary(registry, {});
  for (const access of ['org', 'public'] as const) await assert.rejects(registry.setAccess(trial, access), Conflict);
  assert.equal(registry.view(trial)?.access, 'tenant');
});

test('AC-EPH-2 discard ends a registered ephemeral app as purge does: instance retired, bindings destroyed, its bundle and rows deleted', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const own = await w.bundles.put(Readable.from([Buffer.from('own')]));
  const { app } = await temporary(registry, { kv: {}, files: {}, static: { dir: 'dist' } }, null, trial, { bundle: own });
  await registry.discard(trial);
  assert.ok(w.runtime.calls.includes(`retire ${app}`));
  assert.deepEqual(w.calls.filter(([verb]) => verb === 'destroy').map(([, p]) => p).sort(), ['redis', 'volume']);
  assert.deepEqual([await store.app(trial), await store.bindings(app), await store.releases(app), registry.view(trial), w.bundles.stored.has(own)], [null, [], [], null, false]);
});

test('AC-EPH-2 discard of a durable app is refused and changes nothing', async () => {
  const w = world();
  const { registry } = await w.open();
  await publish(registry, { kv: {} });
  await assert.rejects(registry.discard(survey), Conflict);
  assert.deepEqual([registry.view(survey)?.status, w.calls.filter(([verb]) => verb === 'destroy')], ['registered', []]);
});

test('ADR 0038 a discard given the id of an earlier app of the name is refused and changes nothing; given the app\'s own id it ends the app', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app: earlier } = await temporary(registry, { kv: {} });
  await registry.discard(trial);
  const { app } = await temporary(registry, { kv: {} });
  await assert.rejects(registry.discard(trial, null, earlier), (error) => error instanceof Conflict && /belongs to a later app/.test(error.message));
  assert.deepEqual([(await store.app(trial))?.status, w.calls.filter(([verb, , id]) => verb === 'destroy' && id === app)], ['registered', []]);
  await registry.discard(trial, null, app);
  assert.equal(await store.app(trial), null);
});

test('ADR 0038 a discard interrupted after the first destroy finishes on resume after restart', async () => {
  const w = world();
  const { registry } = await w.open();
  const { app } = await temporary(registry, { files: {}, kv: {} });
  w.providers.get('redis')!.fail = 'destroy';
  await assert.rejects(registry.discard(trial), /redis destroy failed/);
  const restarted = await w.open();
  assert.equal(restarted.registry.view(trial)?.status, 'purging');
  await restarted.registry.resume();
  assert.deepEqual([await restarted.store.app(trial), await restarted.store.bindings(app)], [null, []]);
});

test('AC-EPH-3 the sweep ends only ephemeral apps past their end and audits each as app.expire by platform', async () => {
  const { registry, store } = await world().open();
  const { app: gone } = await temporary(registry, {}, 1, appName('gone'));
  await temporary(registry, {}, 600, appName('kept'));
  await publish(registry, {});
  await registry.expire(Date.now() + 1000);
  assert.deepEqual((await store.apps()).map((a) => a.name), ['kept', 'survey']);
  const rows = (await store.audit({ target: 'gone' })).reverse();
  assert.deepEqual(rows.map((r) => [r.actor, r.action, r.result, r.details.appId]), [['platform', 'app.expire', 'started', gone], ['platform', 'app.expire', 'ok', gone]]);
});

test('AC-EPH-3 an ephemeral app whose end passed while the gateway was down ends at the first sweep after restart', async () => {
  const w = world();
  const { registry } = await w.open();
  await temporary(registry, { files: {} }, 1);
  const restarted = await w.open();
  await restarted.registry.expire(Date.now() + 1000);
  assert.equal(await restarted.store.app(trial), null);
});

test('ADR 0038 the sweep finishes an expired ephemeral app a failed discard left purging, and audits it ok as resumed', async () => {
  const w = world();
  const { registry, store } = await w.open();
  await temporary(registry, { kv: {} }, 1);
  w.providers.get('redis')!.fail = 'destroy';
  await assert.rejects(registry.discard(trial), /redis destroy failed/);
  await registry.expire(Date.now() + 1000);
  assert.equal(await store.app(trial), null);
  assert.deepEqual((await store.audit({ target: 'trial' })).map((r) => [r.action, r.result, r.details.resumed]), [['app.expire', 'ok', true]]);
});

test('ADR 0038 sweeps that keep failing to end an app audit the error once, and the end that finally succeeds as resumed', async () => {
  const w = world();
  const { registry, store } = await w.open();
  await temporary(registry, { kv: {} }, 1);
  for (let sweep = 0; sweep < 3; sweep++) {
    w.providers.get('redis')!.fail = 'destroy';
    await registry.expire(Date.now() + 1000);
  }
  await registry.expire(Date.now() + 1000);
  assert.equal(await store.app(trial), null);
  assert.deepEqual((await store.audit({ target: 'trial' })).reverse().map((r) => [r.result, r.details.error, r.details.resumed]), [
    ['started', undefined, undefined], ['error', 'redis destroy failed', undefined], ['ok', undefined, true],
  ]);
});

test('ADR 0038 a sweep that resumes an end and fails audits the error as resumed, once while the error stays the same', async () => {
  const w = world();
  const { registry, store } = await w.open();
  await temporary(registry, { kv: {} }, 1);
  w.providers.get('redis')!.fail = 'destroy';
  await assert.rejects(registry.discard(trial), /redis destroy failed/);
  for (let sweep = 0; sweep < 2; sweep++) {
    w.providers.get('redis')!.fail = 'destroy';
    await registry.expire(Date.now() + 1000);
  }
  assert.deepEqual((await store.audit({ target: 'trial' })).map((r) => [r.action, r.result, r.details.resumed]), [['app.expire', 'error', true]]);
});

test('ADR 0038 a sweep that fails as the discard before it did adds no row', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await temporary(registry, { kv: {} }, 1);
  w.providers.get('redis')!.fail = 'destroy';
  await assert.rejects(registry.discard(trial), /redis destroy failed/);
  await store.insertAudit({
    at: Date.now(), actor: 'local', actorTenant: null, tenant: DEFAULT_TENANT, action: 'app.discard', targetKind: 'app', target: 'trial', result: 'error',
    details: { error: 'redis destroy failed', appId: app },
  });
  w.providers.get('redis')!.fail = 'destroy';
  await registry.expire(Date.now() + 1000);
  assert.deepEqual((await store.audit({ target: 'trial' })).map((r) => [r.action, r.result]), [['app.discard', 'error']]);
});

for (const end of ['discard', 'expire'] as const) {
  test(`ADR 0038 a removed ephemeral app still ends by ${end}, its bindings destroyed`, async () => {
    const w = world();
    const { registry, store } = await w.open();
    const { app } = await temporary(registry, { files: {} }, 1);
    await registry.remove(trial);
    await (end === 'discard' ? registry.discard(trial) : registry.expire(Date.now() + 1000));
    assert.deepEqual([await store.app(trial), await store.bindings(app), w.calls.filter(([verb]) => verb === 'destroy').map(([, p]) => p)], [null, [], ['volume']]);
  });
}

test('AC-EPH-4 an ephemeral app takes no apps slot, and the ephemeral quota refuses the next one', async () => {
  const { registry, store } = await quotaWorld({ apps: 1, ephemeral: 1 });
  await publishIn(registry, 'one', {});
  await temporary(registry, {}, null, appName('two'), { tenant: blue });
  await assert.rejects(temporary(registry, {}, null, appName('three'), { tenant: blue }), (error) =>
    error instanceof QuotaExceeded && JSON.stringify(error.refusal) === JSON.stringify({ resource: 'ephemeral', used: 1, limit: 1, ask: 1 }));
  const { apps, ephemeral } = await store.quotaUsed(blue);
  assert.deepEqual({ apps, ephemeral }, { apps: 1, ephemeral: 1 });
});

test('AC-EPH-4 a discarded ephemeral app frees its slot', async () => {
  const { registry } = await quotaWorld({ ephemeral: 1 });
  await temporary(registry, {}, null, appName('two'), { tenant: blue });
  await registry.discard(appName('two'));
  assert.equal((await temporary(registry, {}, null, appName('three'), { tenant: blue })).number, 1);
});

test('AC-EPH-5 an ephemeral app\'s triggers reach the Scheduler without their schedule and an invoke still queues a delivery', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await temporary(registry, { cron: { triggers: { minutely: { schedule: '* * * * *' } } } });
  assert.deepEqual([registry.schedule(app)!.triggers, await store.triggers()].map((triggers) => triggers.map((t) => t.schedule)), [[null], [null]]);
  const scheduler = new DeliveryScheduler({ store, runtime: w.runtime, view: (id) => registry.schedule(id), log: () => {} });
  const delivery = await scheduler.invoke({ app, trigger: triggerName('minutely'), caller: ann, idempotencyKey: null, body: new Uint8Array() });
  assert.deepEqual((await store.deliveries({ app })).map((d) => d.id), [delivery]);
});

test('ADR 0038 the ephemeral ttl fields are global only, the default never above the maximum, and a first publish takes the new default', async () => {
  const { registry } = await world().open();
  await assert.rejects(registry.setGlobalPolicy({ ephemeral_ttl_seconds: 4000 }), InputError);
  await publish(registry, {});
  await assert.rejects(async () => registry.setAppPolicy(survey, { ephemeral_ttl_seconds: 60 } as never), InputError);
  await registry.setGlobalPolicy({ ephemeral_max_ttl_seconds: 7200, ephemeral_ttl_seconds: 4000 });
  const before = Date.now();
  await temporary(registry, {});
  assert.ok(registry.view(trial)!.expiresAt! >= before + 4_000_000);
});

const deployer = { name: managerName('deployer'), url: 'https://deploy.test/survey' };
const named = deployer.name;

/** A first publish of `survey` that makes deployer its manager. */
function managed(registry: PlatformRegistry, capabilities: Record<string, unknown> = { kv: {} }, extra: Partial<PublishRequest> = {}) {
  const manifest = parseManifest({ contract: 1, capabilities: capabilities as Capabilities });
  return registry.publish({ name: survey, image: 'example:1', manifest, bundle: null, owner: ann, manager: deployer, ...extra });
}

test('AC-MGR-1 a first publish with a manager sets it; the listing shows it, and null for an unmanaged app', async () => {
  const { registry } = await world().open();
  await managed(registry);
  await temporary(registry, {});
  assert.deepEqual((await registry.listing()).map((a) => [a.name, a.manager]), [['survey', deployer], ['trial', null]]);
});

test('AC-MGR-2 a write to a managed app that does not name its manager, or names another, is refused naming it and its url, and changes nothing', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await managed(registry);
  await registry.createTenant(blue, 'Blue', ['ann']);
  const writes = (as: ManagerName | null) => [
    () => managed(registry, { kv: {} }, { image: 'example:2', manager: null, named: as }),
    () => registry.setAppPolicy(survey, { idle_seconds: 5 }, as),
    () => registry.setAccess(survey, 'public', as),
    () => registry.setOwner(survey, subject('user:bob'), as),
    () => registry.moveApp(survey, blue, as),
    () => registry.clearManager(survey, as),
    () => registry.remove(survey, as),
    () => registry.purge(survey, as),
    () => registry.discard(survey, as),
  ];
  const state = async () => JSON.stringify([await store.app(survey), await store.releases(app), await store.bindings(app)]);
  const before = await state();
  for (const as of [null, managerName('other')]) {
    for (const write of writes(as)) await assert.rejects(write(), /^Error: app "survey" is managed by deployer \(https:\/\/deploy\.test\/survey\); acting here goes around it/);
  }
  assert.equal(await state(), before);
});

test('AC-MGR-2 each write naming the manager proceeds, through to purge', async () => {
  const { registry, store } = await world().open();
  await managed(registry);
  await registry.createTenant(blue, 'Blue', ['ann']);
  assert.equal((await managed(registry, { kv: {} }, { image: 'example:2', manager: null, named })).number, 2);
  await registry.setAppPolicy(survey, { idle_seconds: 5 }, named);
  await registry.setAccess(survey, 'public', named);
  await registry.setOwner(survey, subject('user:bob'), named);
  await registry.moveApp(survey, blue, named);
  const row = (await store.app(survey))!;
  assert.deepEqual([row.policyOverride.idle_seconds, row.access, row.owner, row.tenant, row.manager], [5, 'public', 'user:bob', blue, deployer]);
  await registry.remove(survey, named);
  await registry.purge(survey, named);
  assert.equal(await store.app(survey), null);
});

test('ADR 0039 stop, restart and kill of a managed app need no name', async () => {
  const w = world();
  const { registry } = await w.open();
  const { app } = await managed(registry);
  await registry.stop(survey);
  await registry.restart(survey);
  await registry.kill(survey);
  assert.deepEqual(w.runtime.calls.slice(-4), [`retire ${app}`, `retire ${app}`, `acquire ${app}`, `kill ${app}`]);
});

test('AC-MGR-3 a publish naming the manager may change it, keeping the url only while the name stays; one without a manager keeps it', async () => {
  const { registry } = await world().open();
  await managed(registry);
  const republish = (image: string, manager: PublishRequest['manager']) => managed(registry, { kv: {} }, { image, manager, named: registry.view(survey)!.manager!.name });
  await republish('example:2', { name: named });
  await republish('example:1', null);
  assert.deepEqual(registry.view(survey)!.manager, deployer);
  await republish('example:2', { name: managerName('other') });
  assert.deepEqual(registry.view(survey)!.manager, { name: 'other', url: null });
});

test('AC-MGR-3 clearing names the manager, after which a write needs no name', async () => {
  const { registry } = await world().open();
  await managed(registry);
  await registry.clearManager(survey, named);
  await registry.remove(survey);
  assert.deepEqual([registry.view(survey)!.manager, registry.view(survey)!.status], [null, 'removed']);
});

test('ADR 0039 a publish of identical inputs that gives a manager marks the app without a new release', async () => {
  const { registry, store } = await world().open();
  const { app } = await publish(registry, { kv: {} });
  assert.equal((await managed(registry)).number, 1);
  assert.deepEqual([(await store.app(survey))!.manager, (await store.releases(app)).length], [deployer, 1]);
});

test('ADR 0039 an unmanaged app ignores a named manager', async () => {
  const { registry } = await world().open();
  await publish(registry, { kv: {} });
  await registry.remove(survey, named);
  assert.deepEqual([registry.view(survey)!.status, registry.view(survey)!.manager], ['removed', null]);
});

test('AC-MGR-4 a managed ephemeral app refuses a discard that does not name its manager, and the expiry sweep ends it without one', async () => {
  const { registry, store } = await world().open();
  await temporary(registry, { files: {} }, 1, trial, { manager: deployer });
  await assert.rejects(registry.discard(trial), /managed by deployer/);
  await registry.expire(Date.now() + 1000);
  assert.equal(await store.app(trial), null);
});
