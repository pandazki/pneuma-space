import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { DEFAULT_TENANT, type AppName, type Subject } from './model.ts';
import { app, storeContract } from './store.contract.ts';
import { MIGRATIONS, SqliteSession, SqliteStore } from './store.ts';

const path = () => join(mkdtempSync(join(tmpdir(), 'pneuma-space-store-')), 'pneuma-space.sqlite3');

storeContract('SQLite', async () => new SqliteStore(path()));

test('a call issued while a transaction is open runs after it commits', async () => {
  const store = new SqliteStore(path());
  const order: string[] = [];
  const open = store.transaction(async (tx) => {
    order.push('begin');
    await sleep(20);
    await tx.putApp(app('two'));
    order.push('commit');
  });
  const read = store.app(app('two').name).then((row) => order.push(`read ${row?.name}`));
  await Promise.all([open, read]);
  assert.deepEqual(order, ['begin', 'commit', 'read two']);
  await store.close();
});

test('$n placeholders bind by position, in any order and repeated', async () => {
  const session = new SqliteSession(new DatabaseSync(':memory:'));
  const [row] = await session.all('SELECT $2 AS b, $1 AS a, $1 AS again', [1, 2]);
  assert.deepEqual({ ...row }, { b: 2, a: 1, again: 1 });
});

test('migration step 4 puts every M1 app and token in the default tenant', async () => {
  const file = path();
  const m1 = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 3)) m1.exec(step);
  m1.exec(`PRAGMA user_version = 3;
    INSERT INTO app (name, id, owner, status, current, policy_override, registered_at) VALUES ('survey', 'id-survey', 'user:ann', 'registered', NULL, '{}', 1);
    INSERT INTO token (id, subject, hash, created_at) VALUES ('t1', 'service:ci', 'h1', 2);`);
  m1.close();
  const store = new SqliteStore(file);
  assert.deepEqual((await store.tenant(DEFAULT_TENANT))?.quota, { apps: null, awake: null, cpu_millis: null, memory_mb: null, storage_gb: null });
  assert.deepEqual([(await store.app('survey' as AppName))?.tenant, (await store.app('survey' as AppName))?.access], [DEFAULT_TENANT, 'org']);
  assert.deepEqual(await store.token('h1'), {
    id: 't1', tenant: DEFAULT_TENANT, subject: 'service:ci' as Subject, label: 'ci', hash: 'h1', createdBy: 'local', createdAt: 2, revokedAt: null,
  });
  await store.close();
});

test('migration step 5 keeps each app\'s last access when stats loses its counts (INV-7)', async () => {
  const file = path();
  const m2 = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 4)) m2.exec(step);
  m2.exec(`PRAGMA user_version = 4; INSERT INTO stats (app, requests, errors, last_access_at) VALUES ('id-survey', 3, 1, 42);`);
  m2.close();
  const store = new SqliteStore(file);
  assert.deepEqual((await store.stats()).map((s) => [s.app, s.lastAccessAt]), [['id-survey', 42]]);
  await store.close();
});

test('the audit table refuses update and delete', async () => {
  const file = path();
  const store = new SqliteStore(file);
  await store.insertAudit({
    at: 1, actor: 'local', actorTenant: null, tenant: null, action: 'policy.global', targetKind: 'policy', target: 'global', result: 'ok', details: {},
  });
  await store.close();
  const db = new DatabaseSync(file);
  assert.throws(() => db.exec("UPDATE audit SET result = 'error'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit'), /append-only/);
  db.close();
});

test('step 6 makes an already migrated default tenant unlimited', async () => {
  const file = path();
  const migrated = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 5)) migrated.exec(step);
  migrated.exec(`PRAGMA user_version = 5; UPDATE tenant SET quota = '{"apps":100,"awake":20,"cpu_millis":20000,"memory_mb":8192,"storage_gb":20}'`);
  migrated.close();
  const store = new SqliteStore(file);
  assert.deepEqual((await store.tenant(DEFAULT_TENANT))?.quota, { apps: null, awake: null, cpu_millis: null, memory_mb: null, storage_gb: null });
  await store.close();
});
