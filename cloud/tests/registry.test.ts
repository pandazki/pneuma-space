import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tenantName, type AppId } from '../../shared/values.ts';
import { LocalArtifacts } from '../adapters/local/artifacts.ts';
import { LocalSqliteDatabase } from '../adapters/local/sqlite.ts';
import { prepareArtifact } from '../core/artifacts.ts';
import { sha256 } from '../core/crypto.ts';
import { DEFAULT_LIMITS, type Actor, type ExecutionHost, type Limits, type PreparedArtifact } from '../core/model.ts';
import { RecordsProvider } from '../core/providers.ts';
import { SqlRecordsResource } from '../core/records.ts';
import { Registry, initialRegistryState, type RegistryState, type TokenInput } from '../core/registry.ts';
import { SqlState } from '../core/state.ts';

const owner: Actor = { kind: 'session', userId: 'owner', sessionHash: 'owner-session' };
const stranger: Actor = { kind: 'session', userId: 'stranger', sessionHash: 'stranger-session' };
const now = 1_800_000_000_000;

async function artifact(source = 'export default { fetch() { return new Response("ok") } }', records = true): Promise<PreparedArtifact> {
  return prepareArtifact({ manifest: { contract: 2, runtime: 'fetch', abi: 'pneuma-space.fetch/1', entry: 'app.mjs', capabilities: records ? { records: {} } : {} }, source, assets: [] }, DEFAULT_LIMITS);
}

async function fixture(options: { limits?: Partial<Limits>; prepare?: ExecutionHost['prepare']; failArtifactPut?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-registry-'));
  const database = new LocalSqliteDatabase(join(directory, 'registry.sqlite'));
  const state = new SqlState<RegistryState>(database, 'registry', initialRegistryState);
  const artifacts = new LocalArtifacts(join(directory, 'artifacts'));
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const databases: LocalSqliteDatabase[] = [];
  const records = new Map<AppId, SqlRecordsResource>();
  const resources = { records(id: AppId) {
    let resource = records.get(id);
    if (!resource) {
      const database = new LocalSqliteDatabase(join(directory, id + '.sqlite'));
      databases.push(database);
      resource = new SqlRecordsResource(database, limits.records, () => now);
      records.set(id, resource);
    }
    return resource;
  } };
  let clock = now;
  let active = true;
  let prepare = options.prepare ?? (async (_id, prepared) => {
    const module = await import('data:text/javascript,' + encodeURIComponent(prepared.artifact.source));
    if (typeof module.default?.fetch !== 'function') throw new Error('Missing handler.');
  });
  let failArtifactPut = options.failArtifactPut ?? false;
  const registry = new Registry({ state, artifacts: {
    put: async (id, prepared) => {
      if (failArtifactPut) { failArtifactPut = false; throw new Error('Lost storage connection.'); }
      return artifacts.put(id, prepared);
    }, get: (id, digest) => artifacts.get(id, digest), destroy: id => artifacts.destroy(id),
  }, execution: { prepare: (id, prepared) => prepare(id, prepared), invoke: async () => new Response() }, resources,
  limits, sessionActive: (hash, userId) => active && hash === 'owner-session' && userId === 'owner', now: () => clock });
  registry.ensurePersonalOwner({ userId: 'owner', tenant: tenantName('private'), name: 'Owner' });
  return { directory, database, state, artifacts, resources, registry, limits,
    setPrepare(value: ExecutionHost['prepare']) { prepare = value; },
    setClock(value: number) { clock = value; },
    revokeSession() { active = false; },
    async close() { database.close(); for (const database of databases) database.close(); artifacts.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function deploymentToken(registry: Registry, input: Partial<TokenInput> = {}) {
  const created = await registry.createToken(owner, { label: 'Deploy', scopes: ['read', 'publish', 'invoke', 'remove', 'export'], appIds: null, expiresAt: now + 10_000, ...input });
  const secret = created.token.split('.')[2];
  const actor: Actor = { kind: 'token', tokenHash: await sha256(secret) };
  return { ...created, actor, secret };
}

function gate() {
  let release = () => {};
  let entered = () => {};
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  return { arrived, release, prepare: async () => { entered(); await blocked; } };
}

test('AC-C-1 personal owner creation is idempotent and refuses another owner', async () => {
  const f = await fixture();
  try {
    for (let count = 0; count < 20; count++) assert.equal(f.registry.ensurePersonalOwner({ userId: 'owner', tenant: tenantName('private'), name: 'Changed' }).userId, 'owner');
    assert.throws(() => f.registry.ensurePersonalOwner({ userId: 'stranger', tenant: tenantName('private'), name: 'Other' }), { status: 409 });
    assert.equal(f.state.read().account?.name, 'Owner');
  } finally { await f.close(); }
});

test('AC-C-3 credential secret is returned once and persisted only as a hash', async () => {
  const f = await fixture();
  try {
    const created = await deploymentToken(f.registry);
    assert.match(created.token, /^ps1\.private\.[a-f0-9]{64}$/);
    const stored = JSON.stringify(f.state.read());
    assert.equal(stored.includes(created.secret), false);
    assert.equal(stored.includes(created.actor.tokenHash), true);
    assert.equal(JSON.stringify(f.registry.listTokens(owner)).includes(created.actor.tokenHash), false);
  } finally { await f.close(); }
});

test('AC-C-3 expired credentials fail the next admission', async () => {
  const f = await fixture();
  try {
    await f.registry.publish(owner, 'counter', await artifact(), 'first');
    const token = await deploymentToken(f.registry);
    f.setClock(now + 10_000);
    assert.throws(() => f.registry.admit(token.actor, 'counter'), { status: 403 });
  } finally { await f.close(); }
});

test('AC-C-3 revoked credentials fail the next admission', async () => {
  const f = await fixture();
  try {
    await f.registry.publish(owner, 'counter', await artifact(), 'first');
    const token = await deploymentToken(f.registry);
    f.registry.revokeToken(owner, token.metadata.id);
    f.registry.revokeToken(owner, token.metadata.id);
    assert.throws(() => f.registry.admit(token.actor, 'counter'), { status: 403 });
  } finally { await f.close(); }
});

test('AC-C-4 credential application scope filters lists and rejects other apps', async () => {
  const f = await fixture();
  try {
    await f.registry.publish(owner, 'one', await artifact(), 'first');
    await f.registry.publish(owner, 'two', await artifact(), 'second');
    const app = f.registry.get(owner, 'one');
    const token = await deploymentToken(f.registry, { appIds: [app.id] });
    assert.deepEqual(f.registry.list(token.actor).map(app => app.name), ['one']);
    assert.throws(() => f.registry.get(token.actor, 'two'), { status: 404 });
    assert.throws(() => f.registry.admit(token.actor, 'two'), { status: 404 });
    await assert.rejects(f.registry.publish(token.actor, 'two', await artifact('export default {fetch(){return new Response("two")}}'), 'third'), { status: 404 });
    await assert.rejects(f.registry.remove(token.actor, 'two'), { status: 404 });
    await assert.rejects(f.registry.exportApp(token.actor, 'two'), { status: 404 });
    await assert.rejects(f.registry.publish(token.actor, 'new', await artifact(), 'new'), { status: 403 });
  } finally { await f.close(); }
});

test('AC-C-4 action scopes cannot issue credentials or purge', async () => {
  const f = await fixture();
  try {
    await f.registry.publish(owner, 'counter', await artifact(), 'first');
    const token = await deploymentToken(f.registry, { scopes: ['invoke'] });
    assert.equal(f.registry.admit(token.actor, 'counter').name, 'counter');
    assert.throws(() => f.registry.list(token.actor), { status: 403 });
    await assert.rejects(deploymentToken(f.registry).then(value => f.registry.createToken(token.actor, value.metadata)), { status: 403 });
    await assert.rejects(f.registry.purge(token.actor, 'counter', 'counter'), { status: 403 });
    assert.throws(() => f.registry.listTokens(token.actor), { status: 403 });
    assert.throws(() => f.registry.revokeToken(token.actor, token.metadata.id), { status: 403 });
  } finally { await f.close(); }
});

test('AC-C-4 remove scope does not require read scope', async () => {
  const f = await fixture();
  try {
    await f.registry.publish(owner, 'counter', await artifact(), 'first');
    const token = await deploymentToken(f.registry, { scopes: ['remove'] });
    assert.equal((await f.registry.remove(token.actor, 'counter')).status, 'removed');
  } finally { await f.close(); }
});

test('AC-C-5 another account cannot list, manage or admit an application', async () => {
  const f = await fixture();
  try {
    await f.registry.publish(owner, 'counter', await artifact(), 'first');
    assert.throws(() => f.registry.list(stranger), { status: 403 });
    assert.throws(() => f.registry.get(stranger, 'counter'), { status: 403 });
    assert.throws(() => f.registry.admit(stranger, 'counter'), { status: 403 });
    await assert.rejects(f.registry.remove(stranger, 'counter'), { status: 403 });
  } finally { await f.close(); }
});

test('AC-C-9 failed preparation keeps the previous release and permits the same-key retry', async () => {
  const f = await fixture();
  try {
    const first = await f.registry.publish(owner, 'counter', await artifact(), 'first');
    let failed = true;
    f.setPrepare(async () => { if (failed) { failed = false; throw new Error('Unavailable'); } });
    const next = await artifact('export default {fetch(){return new Response("next")}}');
    await assert.rejects(f.registry.publish(owner, 'counter', next, 'second'));
    assert.equal(f.registry.get(owner, 'counter').current?.digest, first.digest);
    assert.equal(f.registry.get(owner, 'counter').pending?.status, 'failed');
    assert.equal((await f.registry.publish(owner, 'counter', next, 'second')).number, 2);
  } finally { await f.close(); }
});

test('AC-C-9 successful key replay returns its original release', async () => {
  const f = await fixture();
  try {
    const firstArtifact = await artifact();
    const first = await f.registry.publish(owner, 'counter', firstArtifact, 'first');
    await f.registry.publish(owner, 'counter', await artifact('export default {fetch(){return new Response("next")}}'), 'second');
    assert.deepEqual(await f.registry.publish(owner, 'counter', firstArtifact, 'first'), first);
    await assert.rejects(f.registry.publish(owner, 'counter', await artifact('export default {fetch(){return new Response("other")}}'), 'first'), { status: 409 });
  } finally { await f.close(); }
});

test('AC-C-9 an unchanged publication still reserves its idempotency key', async () => {
  const f = await fixture();
  try {
    const prepared = await artifact();
    const first = await f.registry.publish(owner, 'counter', prepared, 'first');
    assert.deepEqual(await f.registry.publish(owner, 'counter', prepared, 'unchanged'), first);
    await assert.rejects(f.registry.publish(owner, 'counter', await artifact('export default {fetch(){return new Response("other")}}'), 'unchanged'), { status: 409 });
    assert.equal(f.registry.get(owner, 'counter').releases.length, 1);
  } finally { await f.close(); }
});

test('AC-C-10 different concurrent publication cannot own the pending command', async () => {
  const blocked = gate();
  const f = await fixture({ prepare: blocked.prepare });
  try {
    const pending = f.registry.publish(owner, 'counter', await artifact(), 'first');
    await blocked.arrived;
    await assert.rejects(f.registry.publish(owner, 'counter', await artifact(), 'second'), { status: 409 });
    blocked.release();
    await pending;
    assert.equal(f.registry.get(owner, 'counter').releases.length, 1);
  } finally { blocked.release(); await f.close(); }
});

test('AC-C-10 removal prevents a blocked old publication from activating', async () => {
  const blocked = gate();
  const f = await fixture({ prepare: blocked.prepare });
  try {
    const prepared = await artifact();
    const pending = f.registry.publish(owner, 'counter', prepared, 'first');
    await blocked.arrived;
    const removed = await f.registry.remove(owner, 'counter');
    blocked.release();
    await assert.rejects(pending, { status: 409 });
    assert.equal(f.registry.get(owner, 'counter').status, 'removed');
    assert.equal((await f.resources.records(removed.id).status()).mode, 'suspended');
    await assert.rejects(f.registry.publish(owner, 'counter', prepared, 'first'), { status: 409 });
  } finally { blocked.release(); await f.close(); }
});

test('AC-C-11 concurrent app creation respects the reserved application limit', async () => {
  const blocked = gate();
  const f = await fixture({ limits: { apps: 1 }, prepare: blocked.prepare });
  try {
    const pending = f.registry.publish(owner, 'one', await artifact(), 'first');
    await blocked.arrived;
    await assert.rejects(f.registry.publish(owner, 'two', await artifact(), 'second'), { status: 429 });
    blocked.release();
    await pending;
    assert.deepEqual(f.registry.list(owner).map(app => app.name), ['one']);
  } finally { blocked.release(); await f.close(); }
});

test('AC-C-11 same-key concurrent retry reserves publication bytes once', async () => {
  const blocked = gate();
  const prepared = await artifact();
  const f = await fixture({ limits: { tenantArtifactBytes: prepared.bytes }, prepare: blocked.prepare });
  try {
    const first = f.registry.publish(owner, 'one', prepared, 'first');
    await blocked.arrived;
    const second = f.registry.publish(owner, 'one', prepared, 'first');
    blocked.release();
    assert.deepEqual(await first, await second);
    assert.equal(f.registry.usage(owner).artifactBytes, prepared.bytes);
    assert.equal(f.registry.get(owner, 'one').releases.length, 1);
  } finally { blocked.release(); await f.close(); }
});

test('AC-C-11 storage failure retry reuses its persisted application reservation', async () => {
  const f = await fixture({ failArtifactPut: true, limits: { apps: 1, publishesPerDay: 2 } });
  try {
    const prepared = await artifact();
    await assert.rejects(f.registry.publish(owner, 'counter', prepared, 'first'));
    const id = f.registry.get(owner, 'counter').id;
    await f.registry.publish(owner, 'counter', prepared, 'first');
    assert.equal(f.registry.get(owner, 'counter').id, id);
    assert.equal(f.registry.usage(owner).apps, 1);
  } finally { await f.close(); }
});

test('AC-C-19 failed preparation retries consume the daily attempt limit', async () => {
  let attempts = 0;
  const f = await fixture({ limits: { publishesPerDay: 1 }, prepare: async () => { attempts++; throw new Error('Invalid module.'); } });
  try {
    const prepared = await artifact();
    await assert.rejects(f.registry.publish(owner, 'counter', prepared, 'retry-key'));
    await assert.rejects(f.registry.publish(owner, 'counter', prepared, 'retry-key'), { status: 429 });
    assert.equal(attempts, 1);
  } finally { await f.close(); }
});

test('AC-C-14 records survive republish, remove and resume', async () => {
  const f = await fixture();
  try {
    const prepared = await artifact();
    await f.registry.publish(owner, 'counter', prepared, 'first');
    const first = f.registry.admit(owner, 'counter');
    assert.ok(first.records);
    const resource = f.resources.records(first.appId);
    assert.deepEqual(await resource.commit(first.records, [{ kind: 'put', key: 'count', expected: null, value: 12 }]), { ok: true, revisions: ['1'] });
    await f.registry.publish(owner, 'counter', await artifact('export default {fetch(){return new Response("new")}}'), 'second');
    const second = f.registry.admit(owner, 'counter');
    assert.deepEqual(second.records, first.records);
    await f.registry.remove(owner, 'counter');
    await assert.rejects(resource.get(first.records, 'count'), { status: 403 });
    await f.registry.publish(owner, 'counter', prepared, 'third');
    const resumed = f.registry.admit(owner, 'counter');
    assert.ok(resumed.records);
    assert.equal(resumed.appId, first.appId);
    assert.notEqual(resumed.records.epoch, first.records.epoch);
    assert.deepEqual(await resource.get(resumed.records, 'count'), { key: 'count', value: 12, revision: '1' });
  } finally { await f.close(); }
});

test('AC-C-15 purge requires removal and fences the old AppId', async () => {
  const f = await fixture();
  try {
    const prepared = await artifact();
    await f.registry.publish(owner, 'counter', prepared, 'first');
    const first = f.registry.admit(owner, 'counter');
    assert.ok(first.records);
    await assert.rejects(f.registry.purge(owner, 'counter', 'counter'), { status: 409 });
    await f.registry.remove(owner, 'counter');
    await assert.rejects(f.registry.purge(owner, 'counter', 'wrong'), { status: 400 });
    await f.registry.purge(owner, 'counter', 'counter');
    const resource = f.resources.records(first.appId);
    assert.equal((await resource.status()).mode, 'purged');
    await assert.rejects(resource.get(first.records, 'count'), { status: 403 });
    assert.equal((await resource.transition('active', 1)).mode, 'purged');
    await assert.rejects(f.artifacts.get(first.appId, prepared.digest), { code: 'ENOENT' });
    await f.registry.publish(owner, 'counter', prepared, 'new-first');
    assert.notEqual(f.registry.get(owner, 'counter').id, first.appId);
  } finally { await f.close(); }
});

test('AC-C-16 removed export restores records and revisions into a second local adapter', async () => {
  const source = await fixture();
  const target = await fixture();
  try {
    const prepared = await artifact('export default {async fetch(request, app){return Response.json(await app.records.get("count"))}}');
    await source.registry.publish(owner, 'counter', prepared, 'first');
    const invocation = source.registry.admit(owner, 'counter');
    assert.ok(invocation.records);
    await source.resources.records(invocation.appId).commit(invocation.records, [{ kind: 'put', key: 'count', expected: null, value: 4 }]);
    await source.registry.remove(owner, 'counter');
    const exported = await source.registry.exportApp(owner, 'counter');
    const imported = await target.registry.importApp(owner, 'counter', prepared, exported.records, 'import');
    assert.equal(imported.status, 'removed');
    await target.registry.publish(owner, 'counter', prepared, 'resume');
    const restored = target.registry.admit(owner, 'counter');
    assert.ok(restored.records);
    const module = await import('data:text/javascript,' + encodeURIComponent(exported.artifact.source));
    const response = await module.default.fetch(new Request('https://local/'), { records: new RecordsProvider(target.resources).inject(restored.appId, restored.records) });
    assert.deepEqual(await response.json(), { key: 'count', value: 4, revision: '1' });
    assert.notEqual(restored.appId, invocation.appId);
    assert.equal((await source.resources.records(invocation.appId).status()).count, 1);
  } finally { await source.close(); await target.close(); }
});

test('AC-C-17 malformed restore creates no target', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.registry.importApp(owner, 'bad', await artifact(), { format: 1, revision: 0, records: [{ key: 'count', value: 1, revision: '1' }] }, 'import'), { status: 400 });
    assert.equal(f.registry.list(owner).length, 0);
  } finally { await f.close(); }
});

test('AC-C-17 import refuses an existing target', async () => {
  const f = await fixture();
  try {
    const prepared = await artifact();
    await f.registry.publish(owner, 'counter', prepared, 'first');
    await assert.rejects(f.registry.importApp(owner, 'counter', prepared, { format: 1, revision: 0, records: [] }, 'import'), { status: 409 });
    assert.equal(f.registry.get(owner, 'counter').current?.number, 1);
  } finally { await f.close(); }
});

test('AC-C-16 an interrupted import resumes without another application reservation', async () => {
  const f = await fixture({ failArtifactPut: true, limits: { apps: 1, publishesPerDay: 1 } });
  try {
    const prepared = await artifact();
    const records = { format: 1 as const, revision: 1, records: [{ key: 'count', value: 4, revision: '1' }] };
    await assert.rejects(f.registry.importApp(owner, 'counter', prepared, records, 'import'));
    const id = f.registry.get(owner, 'counter').id;
    const restored = await f.registry.importApp(owner, 'counter', prepared, records, 'import');
    assert.equal(restored.id, id);
    assert.equal(restored.status, 'removed');
    assert.equal(f.registry.usage(owner).publications, 1);
    assert.deepEqual(await f.resources.records(id).export(), records);
  } finally { await f.close(); }
});

test('AC-C-11 an import includes pending publication bytes in tenant capacity', async () => {
  const blocked = gate();
  const prepared = await artifact();
  const f = await fixture({ prepare: blocked.prepare, limits: { tenantArtifactBytes: prepared.bytes } });
  try {
    const pending = f.registry.publish(owner, 'one', prepared, 'first');
    await blocked.arrived;
    await assert.rejects(f.registry.importApp(owner, 'two', prepared, { format: 1, revision: 0, records: [] }, 'import'), { status: 429 });
    blocked.release();
    await pending;
    assert.equal(f.registry.list(owner).length, 1);
  } finally { blocked.release(); await f.close(); }
});

test('AC-C-19 daily invocation quota refuses admission before another invocation exists', async () => {
  const f = await fixture({ limits: { requestsPerDay: 1 } });
  try {
    await f.registry.publish(owner, 'counter', await artifact(), 'first');
    f.registry.admit(owner, 'counter');
    assert.throws(() => f.registry.admit(owner, 'counter'), { status: 429 });
    assert.equal(f.registry.usage(owner).requests, 1);
    f.setClock(now + 86_400_000);
    assert.equal(f.registry.admit(owner, 'counter').name, 'counter');
    assert.equal(f.registry.usage(owner).requests, 1);
  } finally { await f.close(); }
});

test('AC-C-24 revocation during preparation prevents activation of a new release', async () => {
  const f = await fixture();
  const blocked = gate();
  try {
    const first = await f.registry.publish(owner, 'counter', await artifact(), 'first');
    const token = await deploymentToken(f.registry);
    f.setPrepare(blocked.prepare);
    const pending = f.registry.publish(token.actor, 'counter', await artifact('export default {fetch(){return new Response("new")}}'), 'second');
    await blocked.arrived;
    f.registry.revokeToken(owner, token.metadata.id);
    blocked.release();
    await assert.rejects(pending, { status: 403 });
    assert.equal(f.registry.get(owner, 'counter').current?.digest, first.digest);
    assert.ok(f.registry.admit(owner, 'counter').records);
  } finally { blocked.release(); await f.close(); }
});

test('AC-C-24 revoked resume leaves the removed records resource suspended', async () => {
  const f = await fixture();
  const blocked = gate();
  try {
    const prepared = await artifact();
    await f.registry.publish(owner, 'counter', prepared, 'first');
    const removed = await f.registry.remove(owner, 'counter');
    const token = await deploymentToken(f.registry);
    f.setPrepare(blocked.prepare);
    const pending = f.registry.publish(token.actor, 'counter', prepared, 'resume');
    await blocked.arrived;
    f.registry.revokeToken(owner, token.metadata.id);
    blocked.release();
    await assert.rejects(pending, { status: 403 });
    assert.equal((await f.resources.records(removed.id).status()).mode, 'suspended');
    await f.registry.remove(owner, 'counter');
    assert.equal((await f.registry.exportApp(owner, 'counter')).records.records.length, 0);
    await f.registry.purge(owner, 'counter', 'counter');
  } finally { blocked.release(); await f.close(); }
});
