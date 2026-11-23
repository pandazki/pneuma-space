import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { DEFAULT_TENANT, type AppName, type Subject, type TenantName } from './model.ts';
import { app, storeContract } from './store.contract.ts';
import { BUNDLE_REFERENCED } from './sql.ts';
import { MIGRATIONS, positional, sqlOf, SqliteSession, SqliteStore } from './store.ts';
import type { TokenRestrictions } from './hosted-model.ts';

/** The steps both main and the hosted stack held before either appended one: main then added release_bundle, the hosted stack its tables. */
const BEFORE_MERGE = 8;
/** The steps before ADR 0038's and ADR 0039's. */
const BEFORE_EPHEMERAL = 10;
const BEFORE_MANAGED = 11;

const path = () => join(mkdtempSync(join(tmpdir(), 'pneuma-space-store-')), 'pneuma-space.sqlite3');

storeContract('SQLite', async (options) => new SqliteStore(path(), options));

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
  for (const step of MIGRATIONS.slice(0, 3)) m1.exec(sqlOf(step, m1));
  m1.exec(`PRAGMA user_version = 3;
    INSERT INTO app (name, id, owner, status, current, policy_override, registered_at) VALUES ('survey', 'id-survey', 'user:ann', 'registered', NULL, '{}', 1);
    INSERT INTO token (id, subject, hash, created_at) VALUES ('t1', 'service:ci', 'h1', 2);`);
  m1.close();
  const store = new SqliteStore(file);
  assert.deepEqual((await store.tenant(DEFAULT_TENANT))?.quota, { apps: null, ephemeral: null, awake: null, cpu_millis: null, memory_mb: null, storage_gb: null });
  assert.deepEqual([(await store.app('survey' as AppName))?.tenant, (await store.app('survey' as AppName))?.access], [DEFAULT_TENANT, 'org']);
  assert.deepEqual(await store.token('h1'), {
    id: 't1', tenant: DEFAULT_TENANT, subject: 'service:ci' as Subject, label: 'ci', hash: 'h1', createdBy: 'local', createdAt: 2, revokedAt: null,
  });
  await store.close();
});

test('migration step 5 keeps each app\'s last access when stats loses its counts (INV-7)', async () => {
  const file = path();
  const m2 = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 4)) m2.exec(sqlOf(step, m2));
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

test('the bundle reference query searches the release bundle index (#13)', async () => {
  const file = path();
  await new SqliteStore(file).close();
  const db = new DatabaseSync(file);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${positional(BUNDLE_REFERENCED)}`).all('bundle', 'app') as { detail: string }[];
  db.close();
  assert.match(plan.map((row) => row.detail).join('\n'), /USING (COVERING )?INDEX release_bundle \(bundle=\?\)/);
});

test('step 6 makes an already migrated default tenant unlimited', async () => {
  const file = path();
  const migrated = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 5)) migrated.exec(sqlOf(step, migrated));
  migrated.exec(`PRAGMA user_version = 5; UPDATE tenant SET quota = '{"apps":100,"awake":20,"cpu_millis":20000,"memory_mb":8192,"storage_gb":20}'`);
  migrated.close();
  const store = new SqliteStore(file);
  assert.deepEqual((await store.tenant(DEFAULT_TENANT))?.quota, { apps: null, ephemeral: null, awake: null, cpu_millis: null, memory_mb: null, storage_gb: null });
  await store.close();
});

test('AC-SAAS-12 hosted migration preserves existing application state and token permissions', async () => {
  const file = path();
  const old = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, BEFORE_MERGE)) old.exec(sqlOf(step, old));
  old.exec(`PRAGMA user_version = ${BEFORE_MERGE};
    INSERT INTO app (name, id, owner, status, current, policy_override, access) VALUES ('existing', 'stable-id', 'user:ann', 'registered', 1, '{}', 'public');
    INSERT INTO release (app, number, image, manifest, bundle, release_key, published_at) VALUES ('stable-id', 1, 'image-id', '{}', NULL, 'key', 1);
    INSERT INTO binding (app, kind, provider, state, resource) VALUES ('stable-id', 'kv', 'redis', 'active', '{"prefix":"kept"}');
    INSERT INTO token (id, subject, hash, created_at) VALUES ('legacy', 'service:ci', 'legacy-hash', 1);`);
  const snapshot = ['app', 'release', 'binding', 'token'].map((table) => old.prepare(`SELECT * FROM ${table}`).all());
  old.close();
  const store = new SqliteStore(file);
  const migrated = new DatabaseSync(file);
  for (const [index, table] of ['app', 'release', 'binding', 'token'].entries()) {
    const rows = migrated.prepare(`SELECT * FROM ${table}`).all().map(({ restrictions, expires_at, manager, manager_url, ...row }) => row);
    assert.deepEqual(rows, snapshot[index].map((row) => ({ ...row })));
  }
  assert.equal((await store.token('legacy-hash'))?.restrictions, undefined);
  migrated.close();
  await store.close();
});

test('a gateway with one migration fewer leaves a newer library at its version, and the newer gateway opens it again', async () => {
  const file = path();
  const opened = async () => {
    await new SqliteStore(file).close();
    const db = new DatabaseSync(file);
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'release_bundle'").all().length;
    db.close();
    return [version, indexes];
  };
  const full = MIGRATIONS.length;
  const newer = await opened();
  const last = MIGRATIONS.pop()!;
  const older = await opened().finally(() => MIGRATIONS.push(last));
  assert.deepEqual([newer, older, await opened()], [[full, 1], [full, 1], [full, 1]]);
});

test('a library that a gateway without that rule set back to before release_bundle opens again with the index once', async () => {
  const file = path();
  await new SqliteStore(file).close();
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.findIndex((step) => String(step).includes('release_bundle'))}`);
  db.close();
  await new SqliteStore(file).close();
  const after = new DatabaseSync(file);
  const { user_version: version } = after.prepare('PRAGMA user_version').get() as { user_version: number };
  const indexes = after.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'release_bundle'").all().length;
  after.close();
  assert.deepEqual([version, indexes], [MIGRATIONS.length, 1]);
});

test('the ADR 0038 step gives every existing tenant an ephemeral quota of 3, the default one unlimited, and every existing app no end', async () => {
  const file = path();
  const old = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, BEFORE_EPHEMERAL)) old.exec(sqlOf(step, old));
  old.exec(`PRAGMA user_version = ${BEFORE_EPHEMERAL};
    UPDATE tenant SET quota = '{"apps":null,"awake":null,"cpu_millis":null,"memory_mb":null,"storage_gb":null}';
    INSERT INTO tenant (name, display, quota, created_at) VALUES ('blue', 'Blue', '{"apps":5,"awake":2,"cpu_millis":2000,"memory_mb":1024,"storage_gb":5}', 1);
    INSERT INTO app (name, id, owner, status, current, policy_override) VALUES ('kept', 'id-kept', 'user:ann', 'registered', NULL, '{}');`);
  old.close();
  const store = new SqliteStore(file);
  const quota = async (name: string) => (await store.tenant(name as TenantName))?.quota;
  assert.deepEqual([await quota(DEFAULT_TENANT), await quota('blue'), (await store.app('kept' as AppName))?.expiresAt], [
    { apps: null, ephemeral: null, awake: null, cpu_millis: null, memory_mb: null, storage_gb: null },
    { apps: 5, ephemeral: 3, awake: 2, cpu_millis: 2000, memory_mb: 1024, storage_gb: 5 },
    null,
  ]);
  await store.close();
});

test('the ADR 0039 step gives every existing app no manager', async () => {
  const file = path();
  const old = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, BEFORE_MANAGED)) old.exec(sqlOf(step, old));
  old.exec(`PRAGMA user_version = ${BEFORE_MANAGED};
    INSERT INTO app (name, id, owner, status, current, policy_override) VALUES ('kept', 'id-kept', 'user:ann', 'registered', NULL, '{}');`);
  old.close();
  const store = new SqliteStore(file);
  assert.equal((await store.app('kept' as AppName))?.manager, null);
  await store.close();
});

const restrictions: TokenRestrictions = { expiresAt: 2, scopes: ['read'], appIds: null };

/** Opens `file` with this gateway; what it then holds: version, the bundle index, the signup count and a restricted token read back. */
async function upgraded(file: string) {
  const store = new SqliteStore(file);
  await store.putToken({ id: 'r', tenant: DEFAULT_TENANT, subject: 'service:ci' as Subject, label: 'ci', hash: 'h-r', createdBy: 'local', createdAt: 1, revokedAt: null, restrictions });
  const held = [await store.hostedSignupCount(), (await store.token('h-r'))?.restrictions];
  await store.close();
  const db = new DatabaseSync(file);
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'release_bundle'").all().length;
  db.close();
  return [version, indexes, ...held];
}

test('a library main migrated before the hosted stack merged gains the hosted tables', async () => {
  const file = path();
  const db = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, BEFORE_MERGE)) db.exec(sqlOf(step, db));
  db.exec(`CREATE INDEX IF NOT EXISTS release_bundle ON release (bundle); PRAGMA user_version = ${BEFORE_MERGE + 1}`);
  db.close();
  assert.deepEqual(await upgraded(file), [MIGRATIONS.length, 1, 0, restrictions]);
});

test('a library the hosted stack migrated before main merged gains release_bundle and keeps its hosted rows', async () => {
  const file = path();
  const db = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, BEFORE_MERGE + 1)) db.exec(sqlOf(step, db));
  db.exec(`UPDATE hosted_signup SET count = 3; PRAGMA user_version = ${BEFORE_MERGE + 1}`);
  db.close();
  assert.deepEqual(await upgraded(file), [MIGRATIONS.length, 1, 3, restrictions]);
});
