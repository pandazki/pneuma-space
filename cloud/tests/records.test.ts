import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { LocalSqliteDatabase } from '../adapters/local/sqlite.ts';
import { CloudError } from '../core/errors.ts';
import { SqlRecordsResource } from '../core/records.ts';
import type { Json, RecordChange, RecordCommit, RecordsAccess, RecordsLimits, RecordsSnapshot } from '../core/records-contract.ts';

const limits: RecordsLimits = { valueBytes: 1000, totalBytes: 10_000, count: 100, batch: 10, page: 3 };

function fixture(t: TestContext, overrides: Partial<RecordsLimits> = {}, now: () => number = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), 'pneuma-space-records-'));
  const path = join(directory, 'records.sqlite');
  const databases: LocalSqliteDatabase[] = [];
  const configured = { ...limits, ...overrides };
  function open() {
    const database = new LocalSqliteDatabase(path);
    databases.push(database);
    return { database, resource: new SqlRecordsResource(database, configured, now) };
  }
  t.after(() => {
    for (const database of databases) {
      try { database.close(); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { ...open(), open, path, limits: configured };
}

async function activate(resource: SqlRecordsResource, sequence = 1): Promise<RecordsAccess> {
  const { epoch } = await resource.transition('active', sequence);
  return { epoch, expiresAt: Date.now() + 60_000 };
}

function put(key: string, value: Json, expected: string | null = null): RecordChange {
  return { kind: 'put', key, value, expected };
}

function code(expected: string) {
  return (error: unknown) => error instanceof CloudError && error.code === expected;
}

async function race(path: string, configured: RecordsLimits, access: RecordsAccess, changes: RecordChange[][]): Promise<RecordCommit[]> {
  const workers = changes.map(batch => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { LocalSqliteDatabase } = await import(workerData.sqlite);
      const { SqlRecordsResource } = await import(workerData.records);
      const db = new LocalSqliteDatabase(workerData.path);
      const resource = new SqlRecordsResource(db, workerData.limits);
      parentPort.once('message', async () => {
        try { parentPort.postMessage({ result: await resource.commit(workerData.access, workerData.batch) }); }
        catch (error) { parentPort.postMessage({ error: error.code }); }
        finally { db.close(); parentPort.close(); }
      });
      parentPort.postMessage({ ready: true });
    })().catch(error => { throw error; });
  `, { eval: true, workerData: {
    sqlite: new URL('../adapters/local/sqlite.ts', import.meta.url).href,
    records: new URL('../core/records.ts', import.meta.url).href,
    path, limits: configured, access, batch,
  } }));
  try {
    await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
      worker.once('message', message => message.ready ? resolve() : reject(new Error('Worker did not become ready.')));
      worker.once('error', reject);
    })));
    const results = workers.map(worker => new Promise<RecordCommit>((resolve, reject) => {
      worker.once('message', message => message.error ? reject(new CloudError(429, message.error, 'Concurrent commit rejected.')) : resolve(message.result));
      worker.once('error', reject);
    }));
    for (const worker of workers) worker.postMessage('commit');
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

test('AC-C-14: an uninitialized resource reports suspended without granting data access', async t => {
  const { resource } = fixture(t);
  assert.deepEqual(await resource.status(), { mode: 'suspended', sequence: 0, epoch: 0, count: 0, bytes: 0 });
  await assert.rejects(resource.get({ epoch: 0, expiresAt: Date.now() + 1000 }, 'item'), code('forbidden'));
});

test('AC-C-12: separate SQLite connections cannot both commit the same expected revision', async t => {
  const { resource, path, limits } = fixture(t);
  const access = await activate(resource);
  const initial = await resource.commit(access, [put('item', 'initial')]);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  const results = await race(path, limits, access, [
    [put('item', 'first', initial.revisions[0])], [put('item', 'second', initial.revisions[0])],
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.deepEqual(results.find(result => !result.ok), { ok: false, reason: 'conflict' });
  assert.ok(['first', 'second'].includes(String((await resource.get(access, 'item'))?.value)));
});

test('AC-C-12: a conflicting multi-key commit changes no record', async t => {
  const { resource } = fixture(t);
  const access = await activate(resource);
  await resource.commit(access, [put('existing', 1)]);
  assert.deepEqual(await resource.commit(access, [put('new', 2), put('existing', 3)]), { ok: false, reason: 'conflict' });
  assert.equal(await resource.get(access, 'new'), null);
  assert.equal((await resource.get(access, 'existing'))?.value, 1);
});

test('AC-C-13: a batch exceeding the count quota rolls back every key', async t => {
  const { resource } = fixture(t, { count: 1 });
  const access = await activate(resource);
  await assert.rejects(resource.commit(access, [put('a', 1), put('b', 2)]), code('quota_exceeded'));
  assert.deepEqual((await resource.list(access)).items, []);
  assert.equal((await resource.status()).count, 0);
});

test('AC-C-13: a batch exceeding live UTF-8 bytes rolls back every key', async t => {
  const { resource } = fixture(t, { totalBytes: 8 });
  const access = await activate(resource);
  await assert.rejects(resource.commit(access, [put('a', 'é'), put('b', 'é')]), code('quota_exceeded'));
  assert.deepEqual((await resource.list(access)).items, []);
  assert.equal((await resource.status()).bytes, 0);
});

test('AC-C-13: a quota check uses the final batch size after deletes', async t => {
  const { resource } = fixture(t, { count: 1, totalBytes: 2 });
  const access = await activate(resource);
  await resource.commit(access, [put('a', 1)]);
  const previous = await resource.get(access, 'a');
  assert.ok(previous);
  assert.equal((await resource.commit(access, [put('b', 2), { kind: 'delete', key: 'a', expected: previous.revision }])).ok, true);
  assert.equal(await resource.get(access, 'a'), null);
  assert.equal((await resource.get(access, 'b'))?.value, 2);
});

test('AC-C-13: concurrent inserts cannot exceed the records count quota', async t => {
  const { resource, path, limits } = fixture(t, { count: 1 });
  const access = await activate(resource);
  await assert.rejects(race(path, limits, access, [[put('a', 1)], [put('b', 2)]]), code('quota_exceeded'));
  assert.equal((await resource.status()).count, 1);
  assert.equal((await resource.list(access)).items.length, 1);
});

test('AC-C-13: concurrent inserts cannot exceed live bytes', async t => {
  const { resource, path, limits } = fixture(t, { totalBytes: 2 });
  const access = await activate(resource);
  await assert.rejects(race(path, limits, access, [[put('a', 1)], [put('b', 2)]]), code('quota_exceeded'));
  assert.equal((await resource.status()).bytes, 2);
  assert.equal((await resource.list(access)).items.length, 1);
});

test('AC-C-13: a value exceeding its own byte limit writes nothing', async t => {
  const { resource } = fixture(t, { valueBytes: 3 });
  const access = await activate(resource);
  await assert.rejects(resource.commit(access, [put('a', 1), put('b', 'é')]), code('quota_exceeded'));
  assert.deepEqual((await resource.list(access)).items, []);
});

test('AC-C-12: deletion and recreation never reuse an old revision', async t => {
  const { resource } = fixture(t);
  const access = await activate(resource);
  await resource.commit(access, [put('item', 'old')]);
  const previous = await resource.get(access, 'item');
  assert.ok(previous);
  await resource.commit(access, [{ kind: 'delete', key: 'item', expected: previous.revision }]);
  await resource.commit(access, [put('item', 'new')]);
  assert.notEqual((await resource.get(access, 'item'))?.revision, previous.revision);
  assert.deepEqual(await resource.commit(access, [put('item', 'stale', previous.revision)]), { ok: false, reason: 'conflict' });
});

test('AC-C-14: an unchanged active ensure preserves admitted data handles', async t => {
  const { resource } = fixture(t);
  const access = await activate(resource);
  await resource.commit(access, [put('item', { persistent: true })]);
  const before = await resource.get(access, 'item');
  assert.equal((await resource.transition('active', 2)).epoch, access.epoch);
  assert.deepEqual(await resource.get(access, 'item'), before);
});

for (const operation of ['get', 'list', 'commit']) {
  test(`AC-C-15: suspension and resume reject an old ${operation} handle`, async t => {
    const { resource } = fixture(t);
    const access = await activate(resource);
    await resource.commit(access, [put('item', 1)]);
    await resource.transition('suspended', 2);
    await resource.transition('active', 3);
    const request = operation === 'get' ? resource.get(access, 'item')
      : operation === 'list' ? resource.list(access) : resource.commit(access, [put('other', 2)]);
    await assert.rejects(request, code('forbidden'));
  });
}

test('AC-C-14: records and revisions survive suspension, resume and a SQLite reopen', async t => {
  const setup = fixture(t);
  const access = await activate(setup.resource);
  await setup.resource.commit(access, [put('item', { durable: [true, null, 3] })]);
  const before = await setup.resource.get(access, 'item');
  await setup.resource.transition('suspended', 2);
  setup.database.close();
  const reopened = setup.open().resource;
  const resumed = await activate(reopened, 3);
  assert.deepEqual(await reopened.get(resumed, 'item'), before);
});

test('AC-C-15: a delayed lower-sequence ensure cannot undo suspension', async t => {
  const { resource } = fixture(t);
  await activate(resource);
  const suspended = await resource.transition('suspended', 3);
  assert.deepEqual(await resource.transition('active', 2), suspended);
  assert.equal((await resource.status()).mode, 'suspended');
});

test('AC-C-15: one lifecycle sequence cannot request conflicting modes', async t => {
  const { resource } = fixture(t);
  const active = await resource.transition('active', 1);
  await assert.rejects(resource.transition('suspended', 1), code('conflict'));
  assert.deepEqual(await resource.status(), active);
});

test('AC-C-15: purge refuses an active resource', async t => {
  const { resource } = fixture(t);
  const access = await activate(resource);
  await resource.commit(access, [put('item', 1)]);
  await assert.rejects(resource.transition('purged', 2), code('conflict'));
  assert.equal((await resource.get(access, 'item'))?.value, 1);
});

test('AC-C-15: the purge tombstone survives reopen and refuses delayed revival', async t => {
  const setup = fixture(t);
  const access = await activate(setup.resource);
  await setup.resource.commit(access, [put('item', 1)]);
  await setup.resource.transition('suspended', 2);
  const purged = await setup.resource.transition('purged', 3);
  setup.database.close();
  const resource = setup.open().resource;
  assert.equal(purged.count, 0);
  assert.deepEqual(await resource.transition('active', 1), purged);
  await assert.rejects(resource.transition('active', 4), code('conflict'));
  await assert.rejects(resource.commit(access, [put('item', 'revived')]), code('forbidden'));
  await assert.rejects(resource.restore({ format: 1, revision: 0, records: [] }, 'retry'), code('conflict'));
  assert.deepEqual(await resource.status(), purged);
});

test('AC-C-15: completed purge deletes stored record bytes', async t => {
  const { resource, database } = fixture(t);
  const access = await activate(resource);
  await resource.commit(access, [put('item', { private: 'data' })]);
  await resource.transition('suspended', 2);
  await resource.transition('purged', 3);
  assert.deepEqual(database.query('SELECT key, value FROM pneuma_space_records'), []);
});

for (const operation of ['get', 'list', 'commit']) {
  test(`AC-C-15: an expired invocation cannot ${operation} records`, async t => {
    let now = 100;
    const { resource } = fixture(t, {}, () => now);
    const state = await resource.transition('active', 1);
    const access = { epoch: state.epoch, expiresAt: 101 };
    now = 101;
    const request = operation === 'get' ? resource.get(access, 'item')
      : operation === 'list' ? resource.list(access) : resource.commit(access, [put('item', 1)]);
    await assert.rejects(request, code('forbidden'));
  });
}

test('AC-C-12: prefix pagination uses bounded lexical pages and literal prefixes', async t => {
  const { resource } = fixture(t);
  const access = await activate(resource);
  await resource.commit(access, ['a_3', 'other', 'a_1', 'ab', 'a_2'].map(name => put(name, name)));
  const first = await resource.list(access, { prefix: 'a_', limit: 2 });
  assert.deepEqual(first.items.map(item => item.key), ['a_1', 'a_2']);
  assert.equal(first.next, 'a_2');
  const second = await resource.list(access, { prefix: 'a_', after: first.next ?? undefined, limit: 2 });
  assert.deepEqual(second.items.map(item => item.key), ['a_3']);
  assert.equal(second.next, null);
  await assert.rejects(resource.list(access, { limit: 4 }), code('invalid_input'));
});

for (const name of ['', 'a\u0000b', '\u0085', '\ud800', 'é'.repeat(101)]) {
  test(`AC-C-12: invalid UTF-8 record key ${JSON.stringify(name)} is rejected without writes`, async t => {
    const { resource } = fixture(t);
    const access = await activate(resource);
    await assert.rejects(resource.commit(access, [put(name, 1)]), code('invalid_input'));
    assert.deepEqual((await resource.list(access)).items, []);
  });
}

test('AC-C-12: a 200-byte UTF-8 key is accepted', async t => {
  const { resource } = fixture(t);
  const access = await activate(resource);
  const name = 'é'.repeat(100);
  assert.equal((await resource.commit(access, [put(name, 1)])).ok, true);
  assert.equal((await resource.get(access, name))?.value, 1);
});

for (const value of [Number.NaN, Number.POSITIVE_INFINITY, { nested: Number.NEGATIVE_INFINITY }]) {
  test(`AC-C-12: non-finite JSON value ${String(value)} is rejected without writes`, async t => {
    const { resource } = fixture(t);
    const access = await activate(resource);
    await assert.rejects(resource.commit(access, [put('item', value)]), code('invalid_input'));
    assert.equal(await resource.get(access, 'item'), null);
  });
}

test('AC-C-12: duplicate commit keys are rejected without writes', async t => {
  const { resource } = fixture(t);
  const access = await activate(resource);
  await assert.rejects(resource.commit(access, [put('item', 1), put('item', 2)]), code('invalid_input'));
  assert.equal(await resource.get(access, 'item'), null);
});

test('AC-C-12: a cyclic value is rejected without writes', async t => {
  const { resource } = fixture(t);
  const access = await activate(resource);
  const value: { [key: string]: Json } = {};
  value.self = value;
  await assert.rejects(resource.commit(access, [put('item', value)]), code('invalid_input'));
  assert.equal(await resource.get(access, 'item'), null);
});

test('AC-C-16: export requires completed suspension', async t => {
  const { resource } = fixture(t);
  await activate(resource);
  await assert.rejects(resource.export(), code('conflict'));
});

test('AC-C-16: export and restoration after reopen preserve values, revisions and the watermark', async t => {
  const source = fixture(t);
  const access = await activate(source.resource);
  await source.resource.commit(access, [put('keep', { nested: ['é', 4] }), put('delete', true)]);
  const deleted = await source.resource.get(access, 'delete');
  assert.ok(deleted);
  await source.resource.commit(access, [{ kind: 'delete', key: 'delete', expected: deleted.revision }]);
  await source.resource.transition('suspended', 2);
  source.database.close();
  const snapshot = await source.open().resource.export();
  const target = fixture(t);
  await target.resource.restore(snapshot, 'migration');
  target.database.close();
  const restored = target.open().resource;
  assert.deepEqual(await restored.export(), snapshot);
  const resumed = await activate(restored);
  await restored.commit(resumed, [put('delete', 'recreated')]);
  const recreated = await restored.get(resumed, 'delete');
  assert.ok(recreated);
  assert.ok(Number(recreated.revision) > snapshot.revision);
  assert.deepEqual((await restored.get(resumed, 'keep')), snapshot.records[0]);
});

test('AC-C-17: a corrupted revision watermark creates no imported data', async t => {
  const { resource } = fixture(t);
  const snapshot: RecordsSnapshot = { format: 1, revision: 1, records: [{ key: 'item', value: 'corrupt', revision: '2' }] };
  await assert.rejects(resource.restore(snapshot, 'corrupt'), code('invalid_input'));
  assert.deepEqual(await resource.export(), { format: 1, revision: 0, records: [] });
});

test('AC-C-17: duplicate snapshot keys create no imported data', async t => {
  const { resource } = fixture(t);
  await assert.rejects(resource.restore({ format: 1, revision: 2, records: [
    { key: 'item', value: 1, revision: '1' }, { key: 'item', value: 2, revision: '2' },
  ] }, 'duplicate'), code('invalid_input'));
  assert.deepEqual(await resource.export(), { format: 1, revision: 0, records: [] });
});

test('AC-C-17: an oversized snapshot creates no imported data', async t => {
  const { resource } = fixture(t, { totalBytes: 3 });
  await assert.rejects(resource.restore({ format: 1, revision: 1, records: [{ key: 'item', value: 1, revision: '1' }] }, 'large'), code('quota_exceeded'));
  assert.deepEqual(await resource.export(), { format: 1, revision: 0, records: [] });
});

test('AC-C-17: restore cannot overwrite existing suspended app data', async t => {
  const { resource } = fixture(t);
  const access = await activate(resource);
  await resource.commit(access, [put('keep', 'original')]);
  await resource.transition('suspended', 2);
  const before = await resource.export();
  await assert.rejects(resource.restore({ format: 1, revision: 1, records: [{ key: 'other', value: 1, revision: '1' }] }, 'overwrite'), code('conflict'));
  assert.deepEqual(await resource.export(), before);
});

test('AC-C-17: restore cannot reuse an empty resource that was previously active', async t => {
  const { resource } = fixture(t);
  await activate(resource);
  await resource.transition('suspended', 2);
  await assert.rejects(resource.restore({ format: 1, revision: 0, records: [] }, 'overwrite'), code('conflict'));
});

test('AC-C-17: restore retries with the same import key are idempotent after reopen', async t => {
  const setup = fixture(t);
  const snapshot: RecordsSnapshot = { format: 1, revision: 4, records: [{ key: 'item', value: { durable: true }, revision: '3' }] };
  await setup.resource.restore(snapshot, 'migration');
  setup.database.close();
  const resource = setup.open().resource;
  await resource.restore(snapshot, 'migration');
  assert.deepEqual(await resource.export(), snapshot);
});

test('AC-C-17: an import key rejects changed content without altering restored records', async t => {
  const { resource } = fixture(t);
  const snapshot: RecordsSnapshot = { format: 1, revision: 1, records: [{ key: 'item', value: 'original', revision: '1' }] };
  await resource.restore(snapshot, 'migration');
  await assert.rejects(resource.restore({ ...snapshot, records: [{ key: 'item', value: 'changed', revision: '1' }] }, 'migration'), code('conflict'));
  assert.deepEqual(await resource.export(), snapshot);
});

test('AC-C-17: an import retry cannot overwrite later application writes', async t => {
  const { resource } = fixture(t);
  const snapshot: RecordsSnapshot = { format: 1, revision: 1, records: [{ key: 'item', value: 'imported', revision: '1' }] };
  await resource.restore(snapshot, 'migration');
  const access = await activate(resource);
  await resource.commit(access, [put('item', 'changed', '1')]);
  const before = await resource.get(access, 'item');
  await resource.restore(snapshot, 'migration');
  assert.deepEqual(await resource.get(access, 'item'), before);
});
