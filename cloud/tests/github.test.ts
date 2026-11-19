import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubIdentityProvider } from '../adapters/github.ts';

const options = {
  clientId: 'pneuma-space-client', clientSecret: 'pneuma-space-test-secret',
  callbackUrl: 'https://console.example.com/_pneuma-space/auth/callback',
  handshakeSecret: 'test-handshake-secret-with-at-least-32-characters',
};

test('AC-C-22 GitHub sign-in requests PKCE S256 and no repository scopes', async () => {
  const provider = new GitHubIdentityProvider(options);
  const login = await provider.begin('/');
  const url = new URL(login.authorizationUrl);
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), options.callbackUrl);
  assert.equal(url.searchParams.get('scope'), '');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
});

test('AC-C-22 GitHub identity uses the immutable numeric id and discards the upstream token', async () => {
  const requests: Request[] = [];
  const fetchProvider: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return requests.length === 1
      ? Response.json({ access_token: 'upstream-secret', token_type: 'bearer' })
      : Response.json({ id: 1234, login: 'mutable-login', name: 'Developer', email: 'mutable@example.com' });
  };
  const provider = new GitHubIdentityProvider({ ...options, fetch: fetchProvider });
  const login = await provider.begin('/apps?status=removed');
  const state = new URL(login.authorizationUrl).searchParams.get('state') ?? '';
  const result = await provider.complete({ code: 'authorization-code', state, cookieValue: login.cookieValue });
  assert.deepEqual(result, { identity: { provider: 'github', subject: '1234', name: 'Developer' }, returnPath: '/apps?status=removed' });
  assert.equal(JSON.stringify(result).includes('upstream-secret'), false);
  assert.equal(requests[1].url, 'https://api.github.com/user');
  assert.equal(requests[1].headers.get('Authorization'), 'Bearer upstream-secret');
  const tokenBody = new URLSearchParams(await requests[0].text());
  const verifier = tokenBody.get('code_verifier') ?? '';
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  assert.equal(challenge, new URL(login.authorizationUrl).searchParams.get('code_challenge'));
  assert.equal(tokenBody.get('redirect_uri'), options.callbackUrl);
});

test('AC-C-22 sign-in rejects a mismatched OAuth state before any provider call', async () => {
  const provider = new GitHubIdentityProvider({ ...options, fetch: async () => { assert.fail('Provider called for mismatched state.'); } });
  const login = await provider.begin('/');
  await assert.rejects(provider.complete({ code: 'code', state: 'another-state', cookieValue: login.cookieValue }), { code: 'forbidden' });
});

test('AC-C-22 sign-in rejects a tampered encrypted handshake', async () => {
  const provider = new GitHubIdentityProvider({ ...options, fetch: async () => { assert.fail('Provider called for tampered handshake.'); } });
  const login = await provider.begin('/');
  const state = new URL(login.authorizationUrl).searchParams.get('state') ?? '';
  const tampered = `${login.cookieValue[0] === 'A' ? 'B' : 'A'}${login.cookieValue.slice(1)}`;
  await assert.rejects(provider.complete({ code: 'code', state, cookieValue: tampered }), { code: 'forbidden' });
});

test('AC-C-22 sign-in rejects an expired handshake', async () => {
  let now = 1_000_000;
  const provider = new GitHubIdentityProvider({ ...options, now: () => now, fetch: async () => { assert.fail('Provider called for expired handshake.'); } });
  const login = await provider.begin('/');
  const state = new URL(login.authorizationUrl).searchParams.get('state') ?? '';
  now += 10 * 60 * 1000;
  await assert.rejects(provider.complete({ code: 'code', state, cookieValue: login.cookieValue }), { code: 'forbidden' });
});

test('AC-C-22 sign-in handshakes cannot be transferred to another callback', async () => {
  const first = new GitHubIdentityProvider(options);
  const second = new GitHubIdentityProvider({ ...options, callbackUrl: 'https://other.example.net/callback', fetch: async () => { assert.fail('Provider called for wrong callback.'); } });
  const login = await first.begin('/');
  const state = new URL(login.authorizationUrl).searchParams.get('state') ?? '';
  await assert.rejects(second.complete({ code: 'code', state, cookieValue: login.cookieValue }), { code: 'forbidden' });
});

test('AC-C-22 production identity construction requires all secrets', () => {
  assert.throws(() => new GitHubIdentityProvider({ ...options, clientSecret: '' }), /secrets are required/);
});
