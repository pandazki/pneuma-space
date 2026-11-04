import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conflict, InputError, appName, parseManifest, subject, type AppId, type Capabilities } from './model.ts';
import type { PlatformRegistry } from './registry.ts';
import { world } from './registry.fakes.ts';

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
  assert.equal(store.releases(first.app).length, 2);
});

test('dropping kv from the manifest suspends its binding and keeps the row', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await publish(registry, { kv: {} });
  assert.deepEqual(store.bindings(app).map((b) => b.state), ['active']);
  await publish(registry, {});
  assert.deepEqual(store.bindings(app).map((b) => [b.kind, b.state]), [['kv', 'suspended']]);
  assert.deepEqual(w.calls, [['ensure', 'redis', app], ['suspend', 'redis', app]]);
});

test('remove marks the app removed and suspends every binding', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await publish(registry, { kv: {}, files: {} });
  await registry.remove(survey);
  assert.equal(registry.view(survey)?.status, 'removed');
  assert.deepEqual(store.bindings(app).map((b) => b.state), ['suspended', 'suspended']);
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
  assert.equal(store.app(survey), null);
  assert.deepEqual([store.bindings(app), store.releases(app), registry.view(survey)], [[], [], null]);
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
  assert.equal(restarted.store.app(survey), null);
  assert.deepEqual(restarted.store.bindings(app), []);
  assert.deepEqual(w.calls.filter(([verb]) => verb === 'destroy').map(([, p]) => p), ['volume', 'redis', 'volume', 'redis']);
});

test('switching db_backend ensures a second db binding, suspends the first and emits AppChanged', async () => {
  const w = world();
  const { registry, store } = await w.open();
  const { app } = await publish(registry, { db: {} });
  const changed: AppId[] = [];
  registry.onAppChanged((id) => changed.push(id));
  await registry.setAppPolicy(survey, { db_backend: 'postgres' });
  assert.deepEqual(store.bindings(app).map((b) => [b.provider, b.state]), [['postgres', 'active'], ['sqlite', 'suspended']]);
  assert.deepEqual(changed, [app]);
  assert.equal(registry.runSpec(app)?.injection.env.FAKE_POSTGRES, store.bindings(app)[0].resource.name);
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
  const id = store.app(survey)!.id;
  const [kvRow] = store.bindings(id);

  const restarted = await w.open();
  const release = await publish(restarted.registry, { kv: {}, object: {} });
  assert.equal(release.app, id);
  const rows = restarted.store.bindings(id);
  assert.deepEqual(rows.map((b) => [b.kind, b.state]), [['kv', 'active'], ['object', 'active']]);
  assert.deepEqual(rows[0].resource, kvRow.resource);
});

test('the first publish requires an owner', async () => {
  const { registry, store } = await world().open();
  await assert.rejects(publish(registry, {}, 'example:1', null as never), InputError);
  assert.equal(store.app(survey), null);
});

test('owner is ignored after the first publish and changed by setOwner', async () => {
  const { registry } = await world().open();
  await publish(registry, {});
  await publish(registry, {}, 'example:2', subject('user:bob'));
  assert.equal(registry.view(survey)?.owner, ann);
  registry.setOwner(survey, subject('user:bob'));
  assert.equal(registry.view(survey)?.owner, 'user:bob');
});
