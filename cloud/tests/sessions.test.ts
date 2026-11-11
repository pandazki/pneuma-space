import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { tenantName, type AppId } from '../../shared/values.ts';
import { randomSecret, sha256 } from '../core/crypto.ts';
import { parseCredential } from '../core/identity-contract.ts';
import { Sessions, initialSessionsState } from '../core/sessions.ts';
import { SqlState } from '../core/state.ts';
import { LocalSqliteDatabase } from '../adapters/local/sqlite.ts';

const account = { userId: 'owner', tenant: tenantName('personal'), name: 'Developer' };
const controlOrigin = 'https://console.example.com';
const appId = 'app-one' as AppId;
const appOrigin = 'https://notes--personal.apps.example.net';

function fixture(t: TestContext, maxSessions = 30) {
  const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-sessions-'));
  const database = new LocalSqliteDatabase(join(dir, 'sessions.db'));
  t.after(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  let now = 1_000_000;
  const state = new SqlState(database, 'sessions', initialSessionsState);
  const sessions = new Sessions({ state, tenant: account.tenant, controlOrigin, maxSessions, now: () => now });
  const control = () => sessions.createControl(account);
  async function grant() {
    const parent = await control();
    const nonce = randomSecret();
    const target = { appId, origin: appOrigin, nonceHash: await sha256(nonce), returnPath: '/tasks?q=open' };
    const created = await sessions.createGrant(parent.actor, target);
    return { parent, nonce, target, created };
  }
  return { state, sessions, control, grant, advance: (milliseconds: number) => { now += milliseconds; } };
}

test('AC-C-6 control credentials persist only their secret hash', async t => {
  const { state, sessions, control } = fixture(t);
  const created = await control();
  const parsed = parseCredential(created.credential);
  assert.ok(parsed);
  assert.equal(JSON.stringify(state.read()).includes(parsed.secret), false);
  assert.equal(state.read().sessions[0].hash, await sha256(parsed.secret));
  assert.deepEqual(await sessions.authenticate(created.credential, { kind: 'control', origin: controlOrigin }), {
    actor: created.actor, account, csrf: created.csrf, scope: created.scope, expiresAt: created.expiresAt,
  });
});

test('AC-C-6 control authentication rejects another origin', async t => {
  const { sessions, control } = fixture(t);
  const created = await control();
  assert.equal(await sessions.authenticate(created.credential, { kind: 'control', origin: appOrigin }), null);
});

test('AC-C-6 expired control sessions fail their next admission', async t => {
  const { sessions, control, advance } = fixture(t);
  const created = await control();
  advance(7 * 24 * 60 * 60 * 1000);
  assert.equal(sessions.isActive(created.sessionHash, account.userId), false);
});

test('AC-C-7 an app grant is bound to its exact app origin', async t => {
  const { sessions, grant } = fixture(t);
  const { created, nonce } = await grant();
  await assert.rejects(sessions.consumeGrant(created.code, { appId, origin: 'https://other.example.net', nonce }), { code: 'forbidden' });
});

test('AC-C-7 an app grant is bound to its exact AppId', async t => {
  const { sessions, grant } = fixture(t);
  const { created, nonce } = await grant();
  await assert.rejects(sessions.consumeGrant(created.code, { appId: 'other-app' as AppId, origin: appOrigin, nonce }), { code: 'forbidden' });
});

test('AC-C-7 an app grant is bound to its browser nonce', async t => {
  const { sessions, grant } = fixture(t);
  const { created } = await grant();
  await assert.rejects(sessions.consumeGrant(created.code, { appId, origin: appOrigin, nonce: randomSecret() }), { code: 'forbidden' });
});

test('AC-C-7 an expired app grant cannot create a session', async t => {
  const { sessions, grant, advance } = fixture(t);
  const { created, nonce } = await grant();
  advance(60_000);
  await assert.rejects(sessions.consumeGrant(created.code, { appId, origin: appOrigin, nonce }), { code: 'forbidden' });
});

test('AC-C-7 simultaneous app grant consumption succeeds exactly once', async t => {
  const { sessions, grant } = fixture(t);
  const { created, nonce } = await grant();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => sessions.consumeGrant(created.code, { appId, origin: appOrigin, nonce })));
  const successes = results.filter(result => result.status === 'fulfilled');
  assert.equal(successes.length, 1);
  assert.equal(successes[0].status === 'fulfilled' && successes[0].value.returnPath, '/tasks?q=open');
});

test('AC-C-7 an app session cannot authenticate at the control origin', async t => {
  const { sessions, grant } = fixture(t);
  const { created, nonce } = await grant();
  const app = await sessions.consumeGrant(created.code, { appId, origin: appOrigin, nonce });
  assert.equal(await sessions.authenticate(app.credential, { kind: 'control', origin: controlOrigin }), null);
  assert.equal(sessions.isActive(app.sessionHash, account.userId, 'control'), false);
});

test('AC-C-7 an app session cannot authenticate for another app', async t => {
  const { sessions, grant } = fixture(t);
  const { created, nonce } = await grant();
  const app = await sessions.consumeGrant(created.code, { appId, origin: appOrigin, nonce });
  assert.equal(await sessions.authenticate(app.credential, { kind: 'app', origin: appOrigin, appId: 'other-app' as AppId }), null);
});

test('AC-C-7 app sessions cannot mint app login grants', async t => {
  const { sessions, grant } = fixture(t);
  const { created, nonce, target } = await grant();
  const app = await sessions.consumeGrant(created.code, { appId, origin: appOrigin, nonce });
  await assert.rejects(sessions.createGrant(app.actor, target), { code: 'forbidden' });
});

test('AC-C-6 parent logout invalidates an existing app session on its next admission', async t => {
  const { sessions, grant } = fixture(t);
  const { created, nonce, parent } = await grant();
  const app = await sessions.consumeGrant(created.code, { appId, origin: appOrigin, nonce });
  assert.ok(await sessions.authenticate(app.credential, { kind: 'app', origin: appOrigin, appId }));
  sessions.revoke(parent.sessionHash);
  assert.equal(await sessions.authenticate(app.credential, { kind: 'app', origin: appOrigin, appId }), null);
  assert.equal(sessions.isActive(app.sessionHash, account.userId), false);
});

test('AC-C-6 parent logout invalidates an unconsumed app grant', async t => {
  const { sessions, grant } = fixture(t);
  const { created, nonce, parent } = await grant();
  sessions.revoke(parent.sessionHash);
  await assert.rejects(sessions.consumeGrant(created.code, { appId, origin: appOrigin, nonce }), { code: 'forbidden' });
});

test('AC-C-19 session capacity includes outstanding login grants', async t => {
  const { sessions, grant, control } = fixture(t, 2);
  await grant();
  await assert.rejects(control(), { code: 'quota_exceeded' });
  assert.equal(sessions.isActive('missing', account.userId), false);
});

test('AC-C-19 expired grants release session capacity', async t => {
  const { grant, control, advance } = fixture(t, 2);
  await grant();
  advance(60_000);
  assert.ok(await control());
});
