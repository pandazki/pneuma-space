import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LocalIdentity, issueToken, loadOrCreateSecret } from './identity.ts';
import type { Token } from './model.ts';

const secret = randomBytes(32);
const issued = issueToken('ci');
const tokens = new Map<string, Token>([[issued.hash, { id: '1', subject: issued.subject, hash: issued.hash, createdAt: 0 }]]);
const identity = new LocalIdentity(secret, (hash) => tokens.get(hash) ?? null);

const server = createServer((request, response) => void identity.serve(request, response)).listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function request(headers: IncomingHttpHeaders, method = 'GET', url = '/apps/survey/'): IncomingMessage {
  return { method, url, headers } as IncomingMessage;
}

function cookie(payload: object, key: Buffer = secret): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `pneuma_space_session=${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

function login(name: string, next = '/apps/survey/?q=1'): Promise<Response> {
  return fetch(`${base()}/_pneuma-space/login`, {
    method: 'POST',
    body: new URLSearchParams({ name, next }),
    redirect: 'manual',
  });
}

test('a cookie the platform did not sign, a tampered one and an expired one are challenged', async () => {
  const valid = cookie({ sub: 'user:ana', name: 'ana', iat: Date.now() });
  const tampered = valid.replace(/=[^.]+/, `=${Buffer.from('{"sub":"user:bob","name":"bob","iat":0}').toString('base64url')}`);
  for (const value of [
    cookie({ sub: 'user:ana', name: 'ana', iat: Date.now() }, randomBytes(32)),
    tampered,
    cookie({ sub: 'user:ana', name: 'ana', iat: Date.now() - 31 * 24 * 3600 * 1000 }),
  ]) {
    assert.deepEqual(await identity.authenticate(request({ cookie: value })), { status: 401 });
  }
});

test('a bearer token the platform never issued is challenged', async () => {
  assert.deepEqual(await identity.authenticate(request({ authorization: `Bearer ${issueToken('ci').token}` })), { status: 401 });
});

test('an issued token authenticates as service:<name>', async () => {
  assert.deepEqual(await identity.authenticate(request({ authorization: `Bearer ${issued.token}` })), { subject: 'service:ci', name: 'ci' });
});

test('a browser is sent to the login page with its path as next; other clients get 401', async () => {
  assert.deepEqual(
    await identity.authenticate(request({ accept: 'text/html,application/xhtml+xml' }, 'GET', '/apps/survey/a?b=1')),
    { status: 303, location: '/_pneuma-space/login?next=%2Fapps%2Fsurvey%2Fa%3Fb%3D1' },
  );
  assert.deepEqual(await identity.authenticate(request({ accept: 'text/html' }, 'POST')), { status: 401 });
  assert.deepEqual(await identity.authenticate(request({ accept: 'application/json' })), { status: 401 });
});

test('login with an invalid name is 400 and sets no cookie', async () => {
  const response = await login('Ana Smith');
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('login sets a cookie that authenticates as user:<name> and returns to next', async () => {
  const response = await login('ana');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/apps/survey/?q=1');
  const session = response.headers.get('set-cookie')!.split(';')[0];
  assert.deepEqual(await identity.authenticate(request({ cookie: `theme=dark; ${session}` })), { subject: 'user:ana', name: 'ana' });
});

test('login never redirects outside /apps/', async () => {
  for (const next of ['https://evil.example/apps/', '//evil.example/apps/', '/api/apps']) {
    assert.equal((await login('ana', next)).headers.get('location'), '/');
  }
});

test('the platform secret is created once and read back on the next start', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pneuma-space-secret-')), 'pneuma-space.secret');
  const first = loadOrCreateSecret(path);
  assert.equal(first.length, 32);
  assert.deepEqual(loadOrCreateSecret(path), first);
});
