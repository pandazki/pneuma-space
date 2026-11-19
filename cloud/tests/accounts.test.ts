import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Accounts, SignupCapacity, initialAccountsState, initialSignupCapacityState } from '../core/accounts.ts';
import { SqlState } from '../core/state.ts';
import { LocalSqliteDatabase } from '../adapters/local/sqlite.ts';
import type { PersonalAccount } from '../core/model.ts';

function fixture(t: TestContext, limit = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-accounts-'));
  const database = new LocalSqliteDatabase(join(dir, 'accounts.db'));
  t.after(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  const capacityState = new SqlState(database, 'capacity', initialSignupCapacityState);
  const capacity = new SignupCapacity({ state: capacityState, limit });
  database.query('CREATE TABLE owners (tenant TEXT PRIMARY KEY, user TEXT NOT NULL, role TEXT NOT NULL)');
  const ensureOwner = async (account: PersonalAccount) => {
    database.query('INSERT OR IGNORE INTO owners (tenant, user, role) VALUES (?, ?, ?)', account.tenant, account.userId, 'admin');
  };
  const accounts = (key: string, ensure = ensureOwner) => new Accounts({
    state: new SqlState(database, key, initialAccountsState), capacity, ensureOwner: ensure,
  });
  return { database, capacityState, accounts, ensureOwner };
}

const identity = { provider: 'github', subject: '1234', name: 'Developer' };

test('AC-C-1 concurrent registration persists exactly one personal owner and capacity reservation', async t => {
  const { accounts, database, capacityState } = fixture(t);
  const directory = accounts('directory');
  const registrations = await Promise.all(Array.from({ length: 20 }, () => directory.register(identity)));
  for (const account of registrations) assert.deepEqual(account, registrations[0]);
  assert.equal(database.query('SELECT * FROM owners').length, 1);
  assert.equal(database.query('SELECT * FROM owners')[0].role, 'admin');
  assert.equal(capacityState.read().reservations.length, 1);
});

test('AC-C-1 registration resumes a persisted intent after capacity reservation fails', async t => {
  const { accounts, database, capacityState, ensureOwner } = fixture(t);
  const state = new SqlState(database, 'directory', initialAccountsState);
  const interrupted = new Accounts({ state, capacity: { async reserve() { throw new Error('interrupted'); } }, ensureOwner });
  await assert.rejects(interrupted.register(identity), /interrupted/);
  const saved = state.read().link;
  assert.ok(saved);
  assert.equal(saved.status, 'pending');
  assert.equal(database.query('SELECT * FROM owners').length, 0);
  assert.deepEqual(await accounts('directory').register(identity), saved.account);
  assert.equal(capacityState.read().reservations.length, 1);
});

test('AC-C-1 registration retry after owner creation reuses that owner', async t => {
  const { accounts, database, capacityState, ensureOwner } = fixture(t);
  const interrupted = accounts('directory', async account => { await ensureOwner(account); throw new Error('lost response'); });
  await assert.rejects(interrupted.register(identity), /lost response/);
  const original = database.query('SELECT * FROM owners')[0];
  const account = await accounts('directory').register(identity);
  assert.equal(account.tenant, original.tenant);
  assert.equal(account.userId, original.user);
  assert.equal(database.query('SELECT * FROM owners').length, 1);
  assert.equal(capacityState.read().reservations.length, 1);
});

test('AC-C-2 full signup capacity refuses a new identity without another tenant', async t => {
  const { accounts, database } = fixture(t);
  await accounts('first').register(identity);
  await assert.rejects(accounts('second').register({ ...identity, subject: '5678' }), { code: 'quota_exceeded' });
  assert.equal(database.query('SELECT * FROM owners').length, 1);
});

test('AC-C-2 existing login bypasses a full signup capacity ledger', async t => {
  const { accounts, database, ensureOwner } = fixture(t);
  const original = await accounts('directory').register(identity);
  const existing = new Accounts({
    state: new SqlState(database, 'directory', initialAccountsState),
    capacity: { async reserve() { throw new Error('Existing login contacted signup capacity.'); } }, ensureOwner,
  });
  assert.deepEqual(await existing.register(identity), original);
});

test('AC-C-1 an identity directory cannot be reused for another external subject', async t => {
  const { accounts, database } = fixture(t, 2);
  const directory = accounts('directory');
  await directory.register(identity);
  await assert.rejects(directory.register({ ...identity, subject: '5678' }), { code: 'conflict' });
  assert.equal(database.query('SELECT * FROM owners').length, 1);
});

test('AC-C-1 changing a display name does not allocate another identity', async t => {
  const { accounts, database } = fixture(t);
  const directory = accounts('directory');
  const original = await directory.register(identity);
  assert.deepEqual(await directory.register({ ...identity, name: 'Renamed' }), original);
  assert.equal(database.query('SELECT * FROM owners').length, 1);
});
