import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import {
  appLogin, appOrigin, bearer, bundle, call, control, cookie, credential, deploy, fixture, json,
  login, logout, record, rows, string, type Session,
} from './harness.ts';

type Replica = { controlPort: number; ingressPort: number };
const configured = process.env.PNEUMA_SPACE_HOSTED_TEST_REPLICAS;
const skip = configured ? false : 'PNEUMA_SPACE_HOSTED_TEST_REPLICAS is unset';
let first: Replica;
let second: Replica;
let alice: Session;
let operator: Session;
let firstId: string;
let secondId: string;
const staticManifest = { contract: 1, capabilities: { static: { dir: '.' } } };

function replica(value: unknown): Replica {
  const row = record(value);
  const port = (value: unknown): number => {
    assert.ok(typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535);
    return value;
  };
  return { controlPort: port(row.controlPort), ingressPort: port(row.ingressPort) };
}

function controlAt(target: Replica, session: Session, path: string, method = 'GET', body?: unknown) {
  return call(new URL(path, control), method, {
    cookie: session.cookie, origin: control.origin, 'x-pneuma-space-csrf': session.csrf,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, body === undefined ? undefined : JSON.stringify(body), target.controlPort);
}

before(async () => {
  if (!configured) return;
  const endpoints = record(JSON.parse(configured));
  first = replica(endpoints.first);
  second = replica(endpoints.second);
  [alice, operator] = await Promise.all(['alice', 'operator'].map(login));
  const [firstPage, secondPage] = await Promise.all([
    controlAt(first, operator, '/api/requests?local=1'), controlAt(second, operator, '/api/requests?local=1'),
  ]);
  for (const page of [firstPage, secondPage]) assert.equal(page.status, 200, page.text);
  firstId = string(record(json(firstPage)).replica);
  secondId = string(record(json(secondPage)).replica);
  assert.notEqual(firstId, secondId, 'the endpoints must reach distinct gateway processes');
});

after(async () => {
  if (!configured) return;
  await Promise.all([alice, operator].filter(Boolean).map(logout));
});

test('AC-SAAS-3 a login handshake finishes once across replicas', { skip }, async () => {
  const start = await call(new URL('/_pneuma-space/login', control), 'GET', {}, undefined, first.controlPort);
  assert.equal(start.status, 200, start.text);
  const state = /name="state" value="([^"]+)"/.exec(start.text)?.[1];
  assert.ok(state);
  const headers = { cookie: cookie(start, 'pneuma-space-login'), origin: control.origin, 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams({ state, user: 'alice' }).toString();
  const callback = new URL('/_pneuma-space/auth/development', control);
  const finish = await call(callback, 'POST', headers, body, second.controlPort);
  assert.equal(finish.status, 303, finish.text);
  const sessionCookie = cookie(finish, 'pneuma-space-control');
  const me = await call(new URL('/api/me', control), 'GET', { cookie: sessionCookie }, undefined, first.controlPort);
  assert.equal(me.status, 200, me.text);
  const account = record(json(me));
  assert.equal(account.subject, alice.subject);
  assert.equal((await call(callback, 'POST', headers, body, first.controlPort)).status, 401);
  await logout({ ...alice, cookie: sessionCookie, csrf: string(account.csrf) });
});

test('AC-SAAS-5 concurrent replica redemption consumes one private-app grant', { skip }, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: staticManifest, bundle: await bundle(alice, fixture('static-site')) });
  const start = await call(`${appOrigin(app.name)}/_pneuma-space/login?next=%2F`, 'GET', {}, undefined, first.ingressPort);
  assert.equal(start.status, 303, start.text);
  const nonce = cookie(start, 'pneuma-space-nonce');
  const grant = await call(string(start.headers.location), 'GET', { cookie: alice.cookie }, undefined, second.controlPort);
  assert.equal(grant.status, 303, grant.text);
  const completion = string(grant.headers.location);
  const results = await Promise.all([first, second].map((target) => call(completion, 'GET', { cookie: nonce }, undefined, target.ingressPort)));
  assert.deepEqual(results.map((reply) => reply.status).sort(), [303, 401]);
  const winner = results.find((reply) => reply.status === 303);
  assert.ok(winner);
  assert.equal(winner.headers.location, '/');
  const signed = cookie(winner, 'pneuma-space-app');
  for (const target of [first, second]) {
    const page = await call(appOrigin(app.name), 'GET', { cookie: signed }, undefined, target.ingressPort);
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /static-site-index/);
  }
});

test('AC-SAAS-4 logout on one replica rejects the next control and derived app admission on the other', { skip }, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: staticManifest, bundle: await bundle(alice, fixture('static-site')) });
  const separate = await login('alice');
  const signed = await appLogin(app, separate);
  assert.equal((await controlAt(second, separate, '/api/me')).status, 200);
  assert.equal((await call(appOrigin(app.name), 'GET', { cookie: signed.cookie }, undefined, second.ingressPort)).status, 200);
  assert.equal((await controlAt(first, separate, '/_pneuma-space/logout', 'POST')).status, 204);
  assert.equal((await controlAt(second, separate, '/api/me')).status, 401);
  assert.equal((await call(appOrigin(app.name), 'GET', { cookie: signed.cookie }, undefined, second.ingressPort)).status, 401);
});

test('AC-SAAS-7 credential revocation on one replica rejects the next management and app admission on the other', { skip }, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: staticManifest, bundle: await bundle(alice, fixture('static-site')) });
  const issued = await credential(t, alice);
  const list = () => call(new URL('/api/apps', control), 'GET', bearer(issued.token), undefined, second.controlPort);
  const visit = () => call(appOrigin(app.name), 'GET', bearer(issued.token), undefined, second.ingressPort);
  assert.equal((await list()).status, 200);
  assert.equal((await visit()).status, 200);
  assert.equal((await controlAt(first, alice, `/api/tenants/${alice.tenant}/tokens/${issued.id}`, 'DELETE')).status, 200);
  assert.equal((await list()).status, 401);
  assert.equal((await visit()).status, 401);
});

test('AC-SAAS-10 operator request feeds contain both replicas and reject an ordinary account', { skip, timeout: 30_000 }, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: staticManifest, bundle: await bundle(alice, fixture('static-site')) });
  const issued = await credential(t, alice);
  for (const target of [first, second]) {
    assert.equal((await call(`${appOrigin(app.name)}/index.html`, 'GET', bearer(issued.token), undefined, target.ingressPort)).status, 200);
  }
  for (const target of [first, second]) {
    const seen = new Set<string>();
    let cursor = '';
    while (!seen.has(firstId) || !seen.has(secondId)) {
      const reply = await controlAt(target, operator, `/api/requests?after=${encodeURIComponent(cursor)}`);
      assert.equal(reply.status, 200, reply.text);
      const feed = record(json(reply));
      assert.deepEqual(feed.missing, []);
      for (const row of rows(feed.records)) {
        if (row.app === app.name && row.path === '/index.html' && row.status === 200) seen.add(string(row.replica));
      }
      const next = string(feed.cursor);
      assert.ok((seen.has(firstId) && seen.has(secondId)) || next !== cursor, 'both fixture requests must appear before the feed stops advancing');
      cursor = next;
    }
    assert.deepEqual([...seen].sort(), [firstId, secondId].sort());
    assert.equal((await controlAt(target, alice, '/api/requests')).status, 403);
  }
});
