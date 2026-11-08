import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';
import { emit } from './events.ts';

export type JwtReason = 'malformed' | 'alg' | 'key' | 'signature' | 'exp' | 'nbf' | 'iat' | 'iss' | 'aud' | 'keys-unavailable';

export class JwtError extends Error {
  readonly reason: JwtReason;

  constructor(reason: JwtReason) {
    super(`jwt rejected: ${reason}`);
    this.reason = reason;
  }
}

export type Claims = { readonly exp: number; readonly [claim: string]: unknown };

/** `text` is a JWKS JSON document or one or more SPKI PEM public keys. */
export type KeySource =
  | { readonly kind: 'static'; readonly text: string }
  | { readonly kind: 'jwks'; readonly url: string; readonly fetch?: typeof fetch };

export type JwtConfig = {
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly keys: KeySource;
  readonly now?: () => number;
};

const ALGORITHMS = {
  RS256: { digest: 'sha256', dsaEncoding: undefined, fits: (key: KeyObject) => key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails!.modulusLength! >= 2048 },
  ES256: { digest: 'sha256', dsaEncoding: 'ieee-p1363', fits: (key: KeyObject) => key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails!.namedCurve === 'prime256v1' },
  EdDSA: { digest: null, dsaEncoding: undefined, fits: (key: KeyObject) => key.asymmetricKeyType === 'ed25519' },
} as const;

type Algorithm = keyof typeof ALGORITHMS;
type Key = { readonly kid: string | undefined; readonly alg: Algorithm; readonly key: KeyObject };

const SKEW_SECONDS = 60;
const CACHE_LIMIT = 10_000;
const REFRESH_MIN_MS = 60_000;
const REFRESH_MAX_MS = 3_600_000;
const REFRESH_DEFAULT_MS = 600_000;
const UNKNOWN_KID_REFETCH_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_SEGMENT = /^[A-Za-z0-9_-]*$/;
const PEM = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g;

/** Holds the key set and the verified-token cache, so one instance serves the gateway's whole life. */
export class JwtVerifier {
  readonly #issuer: string;
  readonly #audiences: readonly string[];
  readonly #now: () => number;
  readonly #jwks: { readonly url: string; readonly fetch: typeof fetch } | null;
  readonly #cache = new Map<string, Claims>();
  #keys: readonly Key[] = [];
  #refreshAt = 0;
  #unknownKidRefetchAt = -Infinity;
  #inflight: Promise<void> | null = null;

  constructor(config: JwtConfig) {
    this.#issuer = config.issuer;
    this.#audiences = config.audiences;
    this.#now = config.now ?? Date.now;
    if (config.keys.kind === 'static') {
      this.#jwks = null;
      this.#keys = parseKeys(config.keys.text);
      if (this.#keys.length === 0) throw new Error('the identity key file holds no RS256, ES256 or EdDSA public key');
    } else {
      this.#jwks = { url: config.keys.url, fetch: config.keys.fetch ?? fetch };
      void this.#refresh();
    }
  }

  async verify(token: string, audiences: readonly string[] = this.#audiences): Promise<Claims> {
    const id = createHash('sha256').update(token).digest('base64url');
    const cached = this.#cache.get(id);
    this.#cache.delete(id);
    const claims = cached ?? await this.#signed(token);
    const now = this.#now() / 1000;
    if (now > claims.exp + SKEW_SECONDS) throw new JwtError('exp');
    this.#cache.set(id, claims);
    if (this.#cache.size > CACHE_LIMIT) this.#cache.delete(this.#cache.keys().next().value!);
    if (typeof claims.nbf === 'number' ? now < claims.nbf - SKEW_SECONDS : claims.nbf !== undefined) throw new JwtError('nbf');
    if (typeof claims.iat === 'number' ? now < claims.iat - SKEW_SECONDS : claims.iat !== undefined) throw new JwtError('iat');
    if (claims.iss !== this.#issuer) throw new JwtError('iss');
    const aud = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (!aud.some((value) => audiences.includes(value))) throw new JwtError('aud');
    return claims;
  }

  async #signed(token: string): Promise<Claims> {
    const parts = token.split('.');
    if (parts.length !== 3 || !SEGMENT.test(parts[0]!) || !SEGMENT.test(parts[1]!) || !SIGNATURE_SEGMENT.test(parts[2]!)) {
      throw new JwtError('malformed');
    }
    const header = decode(parts[0]!);
    const payload = decode(parts[1]!);
    if (typeof header.alg !== 'string' || !Object.hasOwn(ALGORITHMS, header.alg)) throw new JwtError('alg');
    if (header.kid !== undefined && typeof header.kid !== 'string') throw new JwtError('malformed');
    const key = await this.#key(header.kid);
    if (key.alg !== header.alg) throw new JwtError('alg');
    const { digest, dsaEncoding } = ALGORITHMS[key.alg];
    let valid = false;
    try {
      valid = verifySignature(digest, Buffer.from(`${parts[0]}.${parts[1]}`), { key: key.key, dsaEncoding }, Buffer.from(parts[2]!, 'base64url'));
    } catch {}
    if (!valid) throw new JwtError('signature');
    if (typeof payload.exp !== 'number') throw new JwtError('exp');
    return payload as Claims;
  }

  async #key(kid: string | undefined): Promise<Key> {
    if (this.#jwks) {
      if (this.#now() >= this.#refreshAt) void this.#refresh();
      if (this.#keys.length === 0 && this.#inflight) await this.#inflight;
      const now = this.#now();
      if (kid !== undefined && !this.#keys.some((key) => key.kid === kid) && now - this.#unknownKidRefetchAt >= UNKNOWN_KID_REFETCH_MS) {
        this.#unknownKidRefetchAt = now;
        await this.#refresh();
      }
    }
    if (this.#keys.length === 0) throw new JwtError('keys-unavailable');
    const key = kid === undefined ? (this.#keys.length === 1 ? this.#keys[0] : undefined) : this.#keys.find((candidate) => candidate.kid === kid);
    if (!key) throw new JwtError('key');
    return key;
  }

  #refresh(): Promise<void> {
    this.#inflight ??= this.#fetchKeys().finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #fetchKeys(): Promise<void> {
    const { url, fetch } = this.#jwks!;
    let wait = REFRESH_MIN_MS;
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const keys = parseKeys(await response.text());
      if (keys.length === 0) throw new Error('no RS256, ES256 or EdDSA key in the set');
      this.#keys = keys;
      wait = maxAge(response.headers.get('cache-control'));
    } catch (error) {
      emit('identity-keys-error', null, { url, error: String(error) });
    }
    this.#refreshAt = this.#now() + wait;
  }
}

function decode(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new JwtError('malformed');
  return value as Record<string, unknown>;
}

function maxAge(cacheControl: string | null): number {
  const seconds = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '')?.[1];
  if (seconds === undefined) return REFRESH_DEFAULT_MS;
  return Math.min(REFRESH_MAX_MS, Math.max(REFRESH_MIN_MS, Number(seconds) * 1000));
}

/** Keys of other types, curves or uses are skipped, so a mixed JWKS still yields its signing keys. */
function parseKeys(text: string): Key[] {
  if (text.trimStart().startsWith('{')) {
    const document = JSON.parse(text) as { keys?: unknown };
    if (!Array.isArray(document.keys)) return [];
    return document.keys.flatMap((jwk: JsonWebKey & { kid?: unknown; use?: unknown; alg?: unknown }) => {
      if (jwk.use !== undefined && jwk.use !== 'sig') return [];
      const key = toKey(() => createPublicKey({ key: jwk, format: 'jwk' }), typeof jwk.kid === 'string' ? jwk.kid : undefined);
      return key && (jwk.alg === undefined || jwk.alg === key.alg) ? [key] : [];
    });
  }
  return (text.match(PEM) ?? []).flatMap((pem) => toKey(() => createPublicKey(pem), undefined) ?? []);
}

function toKey(create: () => KeyObject, kid: string | undefined): Key | null {
  let key: KeyObject;
  try {
    key = create();
  } catch {
    return null;
  }
  const alg = (Object.keys(ALGORITHMS) as Algorithm[]).find((name) => ALGORITHMS[name].fits(key));
  return alg ? { kid, alg, key } : null;
}
