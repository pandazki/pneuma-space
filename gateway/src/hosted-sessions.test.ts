import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { HostedSessions, hostedSecret } from './hosted-sessions.ts';
import { newAppId } from './model.ts';
import { SqliteStore } from './store.ts';

const origin = 'https://control.example.com';
const appOrigin = 'https://notes.apps.example.net';
const app = newAppId();

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-hosted-'));
  const store = new SqliteStore(join(dir, 'store.sqlite'));
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('AC-SAAS-3 login handshake is browser-bound and one-use across session instances', async (t) => {
  const store = await fixture(t);
  const a = new HostedSessions(store);
  const b = new HostedSessions(store);
  const cookie = hostedSecret();
  const login = await a.login(cookie, '/projects', 'verifier');
  assert.equal(await b.consumeLogin(login.secret, 'other-browser'), null);
  const outcomes = await Promise.all([a.consumeLogin(login.secret, cookie), b.consumeLogin(login.secret, cookie)]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(outcomes.find(Boolean)?.returnPath, '/projects');
});

test('AC-SAAS-3 expired login handshake cannot create a session', async (t) => {
  const store = await fixture(t);
  let now = 1000;
  const sessions = new HostedSessions(store, () => now);
  const login = await sessions.login('browser', '/', 'verifier');
  now += 600_000;
  assert.equal(await sessions.consumeLogin(login.secret, 'browser'), null);
});

test('AC-SAAS-5 app grant binds immutable app ID, exact origin and browser nonce', async (t) => {
  const store = await fixture(t);
  const sessions = new HostedSessions(store);
  const control = await sessions.control('alice', 'Alice', origin);
  const grant = await sessions.grant(control.record.hash, app, appOrigin, 'nonce', '/document');
  assert.ok(grant);
  assert.equal(await sessions.redeem(grant.secret, newAppId(), appOrigin, 'nonce'), null);
  assert.equal(await sessions.redeem(grant.secret, app, 'https://other.apps.example.net', 'nonce'), null);
  assert.equal(await sessions.redeem(grant.secret, app, appOrigin, 'other'), null);
  const outcomes = await Promise.all([sessions.redeem(grant.secret, app, appOrigin, 'nonce'), sessions.redeem(grant.secret, app, appOrigin, 'nonce')]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(outcomes.find(Boolean)?.returnPath, '/document');
});

test('AC-SAAS-4 parent logout invalidates control and derived app admission on another instance', async (t) => {
  const store = await fixture(t);
  const a = new HostedSessions(store);
  const b = new HostedSessions(store);
  const control = await a.control('alice', 'Alice', origin);
  const grant = await a.grant(control.record.hash, app, appOrigin, 'nonce', '/');
  assert.ok(grant);
  const session = await b.redeem(grant.secret, app, appOrigin, 'nonce');
  assert.ok(session);
  assert.ok(await b.read(session.secret, appOrigin, app));
  await a.revoke(control.record.hash);
  assert.equal(await b.read(control.secret, origin), null);
  assert.equal(await b.read(session.secret, appOrigin, app), null);
});

test('AC-SAAS-4 control cookies cannot authenticate app hosts and app cookies cannot authenticate control', async (t) => {
  const store = await fixture(t);
  const sessions = new HostedSessions(store);
  const control = await sessions.control('alice', 'Alice', origin);
  assert.equal(await sessions.read(control.secret, appOrigin, app), null);
  const grant = await sessions.grant(control.record.hash, app, appOrigin, 'nonce', '/');
  assert.ok(grant);
  const session = await sessions.redeem(grant.secret, app, appOrigin, 'nonce');
  assert.ok(session);
  assert.equal(await sessions.read(session.secret, origin), null);
});

test('AC-SAAS-5 expired grants cannot create an app session', async (t) => {
  const store = await fixture(t);
  let now = 1000;
  const sessions = new HostedSessions(store, () => now);
  const control = await sessions.control('alice', 'Alice', origin);
  const grant = await sessions.grant(control.record.hash, app, appOrigin, 'nonce', '/');
  assert.ok(grant);
  now += 60_000;
  assert.equal(await sessions.redeem(grant.secret, app, appOrigin, 'nonce'), null);
});

test('AC-SAAS-4 sessions survive reopening the platform database', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-hosted-reopen-'));
  const path = join(dir, 'store.sqlite');
  const first = new SqliteStore(path);
  const control = await new HostedSessions(first).control('alice', 'Alice', origin);
  await first.close();
  const second = new SqliteStore(path);
  t.after(async () => { await second.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await new HostedSessions(second).read(control.secret, origin))?.data.user, 'alice');
});

test('AC-SAAS-4 session capacity evicts oldest sessions while preserving the active app parent', async (t) => {
  const store = await fixture(t);
  let now = 1000;
  const sessions = new HostedSessions(store, () => now++);
  const control = await sessions.control('alice', 'Alice', origin);
  for (let i = 0; i < 40; i++) {
    const grant = await sessions.grant(control.record.hash, app, appOrigin, 'nonce', '/');
    assert.ok(grant);
    assert.ok(await sessions.redeem(grant.secret, app, appOrigin, 'nonce'));
  }
  assert.ok(await sessions.read(control.secret, origin));
  assert.equal((await store.hostedAuthFor('alice')).length, 32);
});
