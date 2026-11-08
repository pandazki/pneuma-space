import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { JwtVerifier, type JwtConfig, type JwtReason } from './jwt.ts';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsa2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ed = generateKeyPairSync('ed25519');

const START = 1_800_000_000_000;
const ISSUER = 'https://upstream.example';
let clock = START;
const now = () => clock;

function jwk(key: KeyObject, kid?: string): object {
  return { ...key.export({ format: 'jwk' }), ...(kid === undefined ? {} : { kid }) };
}

function jwks(...keys: object[]): string {
  return JSON.stringify({ keys });
}

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(privateKey: KeyObject, header: object, claims: object = {}): string {
  const head = { alg: 'RS256', ...header };
  const body = { iss: ISSUER, aud: 'apps', exp: clock / 1000 + 300, iat: clock / 1000, sub: 'ana', ...claims };
  const data = Buffer.from(`${b64(head)}.${b64(body)}`);
  const signature = head.alg === 'ES256' ? sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })
    : head.alg === 'EdDSA' ? sign(null, data, privateKey)
    : sign('sha256', data, privateKey);
  return `${data}.${signature.toString('base64url')}`;
}

function verifier(keys: JwtConfig['keys']): JwtVerifier {
  clock = START;
  return new JwtVerifier({ issuer: ISSUER, audiences: ['apps', 'apps-alt'], keys, now });
}

const staticKeys = (text: string): JwtConfig['keys'] => ({ kind: 'static', text });
const rsaVerifier = () => verifier(staticKeys(jwks(jwk(rsa.publicKey, 'r1'))));

async function rejects(promise: Promise<unknown>, reason: JwtReason): Promise<void> {
  await assert.rejects(promise, (error: { reason?: string }) => error.reason === reason);
}

type Served = { readonly status?: number; readonly body?: string; readonly cacheControl?: string };

function jwksEndpoint(serve: () => Served): { readonly keys: JwtConfig['keys']; readonly calls: () => number } {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    const { status = 200, body = '', cacheControl } = serve();
    return new Response(body, { status, headers: cacheControl ? { 'cache-control': cacheControl } : {} });
  }) as typeof globalThis.fetch;
  return { keys: { kind: 'jwks', url: 'https://upstream.example/jwks', fetch }, calls: () => calls };
}

test('an RS256 token verifies and yields its claims', async () => {
  assert.equal((await rsaVerifier().verify(token(rsa.privateKey, { kid: 'r1' }))).sub, 'ana');
});

test('an ES256 token verifies', async () => {
  const v = verifier(staticKeys(jwks(jwk(ec.publicKey, 'e1'))));
  assert.equal((await v.verify(token(ec.privateKey, { alg: 'ES256', kid: 'e1' }))).sub, 'ana');
});

test('an EdDSA token verifies', async () => {
  const v = verifier(staticKeys(jwks(jwk(ed.publicKey, 'd1'))));
  assert.equal((await v.verify(token(ed.privateKey, { alg: 'EdDSA', kid: 'd1' }))).sub, 'ana');
});

test('a tampered payload fails signature', async () => {
  const [head, , signature] = token(rsa.privateKey, { kid: 'r1' }).split('.');
  const forged = b64({ iss: ISSUER, aud: 'apps', exp: clock / 1000 + 300, sub: 'admin' });
  await rejects(rsaVerifier().verify(`${head}.${forged}.${signature}`), 'signature');
});

test('a different issuer fails iss', async () => {
  await rejects(rsaVerifier().verify(token(rsa.privateKey, { kid: 'r1' }, { iss: 'https://other.example' })), 'iss');
});

test('an audience string outside the configured list fails aud', async () => {
  await rejects(rsaVerifier().verify(token(rsa.privateKey, { kid: 'r1' }, { aud: 'console' })), 'aud');
});

test('an audience array outside the configured list fails aud', async () => {
  await rejects(rsaVerifier().verify(token(rsa.privateKey, { kid: 'r1' }, { aud: ['console', 'billing'] })), 'aud');
});

test('an audience array with one configured value passes', async () => {
  assert.equal((await rsaVerifier().verify(token(rsa.privateKey, { kid: 'r1' }, { aud: ['console', 'apps-alt'] }))).sub, 'ana');
});

test('exp allows 60 s of skew', async () => {
  const v = rsaVerifier();
  await rejects(v.verify(token(rsa.privateKey, { kid: 'r1' }, { exp: clock / 1000 - 61 })), 'exp');
  assert.equal((await v.verify(token(rsa.privateKey, { kid: 'r1' }, { exp: clock / 1000 - 59 }))).sub, 'ana');
});

test('a token without exp fails exp', async () => {
  await rejects(rsaVerifier().verify(token(rsa.privateKey, { kid: 'r1' }, { exp: undefined })), 'exp');
});

test('nbf 61 s ahead fails nbf', async () => {
  await rejects(rsaVerifier().verify(token(rsa.privateKey, { kid: 'r1' }, { nbf: clock / 1000 + 61 })), 'nbf');
});

test('alg none fails alg', async () => {
  const body = b64({ iss: ISSUER, aud: 'apps', exp: clock / 1000 + 300, sub: 'ana' });
  await rejects(rsaVerifier().verify(`${b64({ alg: 'none', kid: 'r1' })}.${body}.`), 'alg');
});

test('HS256 signed with the RSA public key as the secret fails alg', async () => {
  const pem = rsa.publicKey.export({ format: 'pem', type: 'spki' });
  const data = `${b64({ alg: 'HS256', kid: 'r1' })}.${b64({ iss: ISSUER, aud: 'apps', exp: clock / 1000 + 300, sub: 'ana' })}`;
  await rejects(rsaVerifier().verify(`${data}.${createHmac('sha256', pem).update(data).digest('base64url')}`), 'alg');
});

test('an ES256 header on an RSA key fails alg', async () => {
  await rejects(rsaVerifier().verify(token(ec.privateKey, { alg: 'ES256', kid: 'r1' })), 'alg');
});

test('kid selects among two keys', async () => {
  const v = verifier(staticKeys(jwks(jwk(rsa.publicKey, 'r1'), jwk(rsa2.publicKey, 'r2'))));
  assert.equal((await v.verify(token(rsa2.privateKey, { kid: 'r2' }))).sub, 'ana');
});

test('a missing kid with two keys fails key', async () => {
  const v = verifier(staticKeys(jwks(jwk(rsa.publicKey, 'r1'), jwk(rsa2.publicKey, 'r2'))));
  await rejects(v.verify(token(rsa.privateKey, {})), 'key');
});

test('a missing kid with one PEM key passes', async () => {
  const v = verifier(staticKeys(ed.publicKey.export({ format: 'pem', type: 'spki' }) as string));
  assert.equal((await v.verify(token(ed.privateKey, { alg: 'EdDSA' }))).sub, 'ana');
});

test('an unknown kid refetches once, and another within 30 s does not', async () => {
  const endpoint = jwksEndpoint(() => ({ body: jwks(jwk(rsa.publicKey, 'r1')) }));
  const v = verifier(endpoint.keys);
  await v.verify(token(rsa.privateKey, { kid: 'r1' }));
  assert.equal(endpoint.calls(), 1);
  await rejects(v.verify(token(rsa2.privateKey, { kid: 'r2' })), 'key');
  assert.equal(endpoint.calls(), 2);
  clock += 29_000;
  await rejects(v.verify(token(rsa2.privateKey, { kid: 'r3' })), 'key');
  assert.equal(endpoint.calls(), 2);
});

test('max-age schedules the next refresh', async () => {
  const endpoint = jwksEndpoint(() => ({ body: jwks(jwk(rsa.publicKey, 'r1')), cacheControl: 'public, max-age=120' }));
  const v = verifier(endpoint.keys);
  await v.verify(token(rsa.privateKey, { kid: 'r1' }));
  clock = START + 119_000;
  await v.verify(token(rsa.privateKey, { kid: 'r1' }));
  assert.equal(endpoint.calls(), 1);
  clock = START + 121_000;
  await v.verify(token(rsa.privateKey, { kid: 'r1' }));
  assert.equal(endpoint.calls(), 2);
});

test('a max-age below 60 s is clamped to 60 s', async () => {
  const endpoint = jwksEndpoint(() => ({ body: jwks(jwk(rsa.publicKey, 'r1')), cacheControl: 'max-age=5' }));
  const v = verifier(endpoint.keys);
  await v.verify(token(rsa.privateKey, { kid: 'r1' }));
  clock = START + 59_000;
  await v.verify(token(rsa.privateKey, { kid: 'r1' }));
  assert.equal(endpoint.calls(), 1);
  clock = START + 61_000;
  await v.verify(token(rsa.privateKey, { kid: 'r1' }));
  assert.equal(endpoint.calls(), 2);
});

test('a failed refetch keeps the old keys', async () => {
  let up = true;
  const endpoint = jwksEndpoint(() => (up ? { body: jwks(jwk(rsa.publicKey, 'r1')) } : { status: 503 }));
  const v = verifier(endpoint.keys);
  await v.verify(token(rsa.privateKey, { kid: 'r1' }));
  up = false;
  await rejects(v.verify(token(rsa2.privateKey, { kid: 'r2' })), 'key');
  assert.equal(endpoint.calls(), 2);
  assert.equal((await v.verify(token(rsa.privateKey, { kid: 'r1' }, { jti: 'fresh' }))).sub, 'ana');
});

test('no keys at all fails keys-unavailable', async () => {
  const endpoint = jwksEndpoint(() => ({ status: 503 }));
  await rejects(verifier(endpoint.keys).verify(token(rsa.privateKey, { kid: 'r1' })), 'keys-unavailable');
});

test('a verified token is not signature-checked again until exp', async () => {
  let served = jwks(jwk(rsa.publicKey, 'r1'));
  const endpoint = jwksEndpoint(() => ({ body: served }));
  const v = verifier(endpoint.keys);
  const first = token(rsa.privateKey, { kid: 'r1' });
  await v.verify(first);
  served = jwks(jwk(rsa2.publicKey, 'r2'));
  await v.verify(token(rsa2.privateKey, { kid: 'r2' }));
  await rejects(v.verify(token(rsa.privateKey, { kid: 'r1' }, { jti: 'new' })), 'key');
  assert.equal((await v.verify(first)).sub, 'ana');
});

test('the console audience override rejects a token carrying only the app audience', async () => {
  await rejects(rsaVerifier().verify(token(rsa.privateKey, { kid: 'r1' }), ['console']), 'aud');
});
