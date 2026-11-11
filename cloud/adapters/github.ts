import { randomSecret, sameSecret } from '../core/crypto.ts';
import { CloudError, forbidden, invalid } from '../core/errors.ts';
import type { IdentityProvider, VerifiedIdentity } from '../core/identity-contract.ts';
import { relativeReturnPath, sessionOrigin } from '../core/sessions.ts';

type Handshake = { state: string; verifier: string; returnPath: string; expiresAt: number };

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 8192) forbidden('Invalid sign-in handshake.');
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)); }
  catch { forbidden('Invalid sign-in handshake.'); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) forbidden('Invalid identity-provider response.');
  return value as Record<string, unknown>;
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new CloudError(502, 'identity_unavailable', 'The identity provider could not complete sign-in.');
  const text = await response.text();
  if (text.length > 64 * 1024) throw new CloudError(502, 'identity_unavailable', 'The identity provider returned an invalid response.');
  try { return object(JSON.parse(text)); }
  catch { throw new CloudError(502, 'identity_unavailable', 'The identity provider returned an invalid response.'); }
}

export class GitHubIdentityProvider implements IdentityProvider {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #callback: string;
  readonly #key: Promise<CryptoKey>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: {
    clientId: string; clientSecret: string; callbackUrl: string; handshakeSecret: string;
    fetch?: typeof fetch; now?: () => number;
  }) {
    if (!options.clientId || !options.clientSecret || options.handshakeSecret.length < 32) {
      throw new Error('GitHub identity secrets are required.');
    }
    const callback = new URL(options.callbackUrl);
    sessionOrigin(callback.origin);
    if (callback.search || callback.hash || callback.username || callback.password) throw new Error('Invalid OAuth callback URL.');
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#callback = callback.href;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#key = crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.handshakeSecret))
      .then(bytes => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }

  async begin(returnPath: string): Promise<{ authorizationUrl: string; cookieValue: string; expiresAt: number }> {
    relativeReturnPath(returnPath);
    const state = randomSecret();
    const verifier = randomSecret();
    const expiresAt = this.#now() + 10 * 60 * 1000;
    const handshake: Handshake = { state, verifier, returnPath, expiresAt };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(this.#callback),
    }, await this.#key, new TextEncoder().encode(JSON.stringify(handshake)));
    const encoded = new Uint8Array(iv.length + ciphertext.byteLength);
    encoded.set(iv);
    encoded.set(new Uint8Array(ciphertext), iv.length);
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const authorization = new URL('https://github.com/login/oauth/authorize');
    authorization.search = new URLSearchParams({
      client_id: this.#clientId, redirect_uri: this.#callback, scope: '', state,
      code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    return { authorizationUrl: authorization.href, cookieValue: base64url(encoded), expiresAt };
  }

  async #handshake(cookie: string): Promise<Handshake> {
    try {
      const bytes = unbase64url(cookie);
      if (bytes.length < 29) forbidden('Invalid sign-in handshake.');
      const plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(this.#callback),
      }, await this.#key, bytes.slice(12));
      const value = object(JSON.parse(new TextDecoder().decode(plaintext)));
      if (typeof value.state !== 'string' || !/^[0-9a-f]{64}$/.test(value.state)
        || typeof value.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(value.verifier)
        || typeof value.returnPath !== 'string' || typeof value.expiresAt !== 'number'
        || value.expiresAt <= this.#now() || value.expiresAt > this.#now() + 10 * 60 * 1000) {
        forbidden('Invalid or expired sign-in handshake.');
      }
      return { state: value.state, verifier: value.verifier, returnPath: relativeReturnPath(value.returnPath), expiresAt: value.expiresAt };
    } catch {
      forbidden('Invalid or expired sign-in handshake.');
    }
  }

  async complete(input: { code: string; state: string; cookieValue: string }): Promise<{ identity: VerifiedIdentity; returnPath: string }> {
    if (!input || typeof input.code !== 'string' || input.code.length < 1 || input.code.length > 1024
      || typeof input.state !== 'string' || typeof input.cookieValue !== 'string') invalid('Invalid sign-in callback.');
    const handshake = await this.#handshake(input.cookieValue);
    if (!sameSecret(input.state, handshake.state)) forbidden('The sign-in state does not match this browser.');
    const token = await responseObject(await this.#fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.#clientId, client_secret: this.#clientSecret, redirect_uri: this.#callback,
        code: input.code, code_verifier: handshake.verifier,
      }),
    }));
    if (typeof token.access_token !== 'string' || token.access_token.length < 1 || token.access_token.length > 4096
      || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') {
      forbidden('The identity provider refused sign-in.');
    }
    const user = await responseObject(await this.#fetch('https://api.github.com/user', {
      redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.access_token}`,
        'User-Agent': 'pneuma-space', 'X-GitHub-Api-Version': '2022-11-28',
      },
    }));
    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0
      || typeof user.login !== 'string' || user.login.length < 1 || user.login.length > 200) {
      forbidden('The identity provider did not return a stable identity.');
    }
    const name = typeof user.name === 'string' && user.name.trim().length > 0 && user.name.length <= 200 ? user.name : user.login;
    return { identity: { provider: 'github', subject: String(user.id), name }, returnPath: handshake.returnPath };
  }
}
