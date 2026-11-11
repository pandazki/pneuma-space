import type { AppId, TenantName } from '../../shared/values.ts';
import { randomSecret, sameSecret, sha256 } from './crypto.ts';
import { forbidden, invalid, quota } from './errors.ts';
import { parseCredential, type AuthenticatedSession, type CreatedSession, type GrantTarget, type SessionScope } from './identity-contract.ts';
import type { Actor, PersonalAccount } from './model.ts';
import type { StateStore } from './state.ts';

type StoredSession = {
  hash: string;
  account: PersonalAccount;
  csrf: string;
  expiresAt: number;
  scope: SessionScope;
  parent: string | null;
};
type StoredGrant = GrantTarget & { hash: string; parent: string; expiresAt: number };
export type SessionsState = { sessions: StoredSession[]; grants: StoredGrant[] };
export const initialSessionsState = (): SessionsState => ({ sessions: [], grants: [] });

export function sessionOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { invalid('Invalid session origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.origin !== value || url.username || url.password
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    invalid('Session origins must use HTTPS.');
  }
  return value;
}

export function relativeReturnPath(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)
    || value.length > 2048) invalid('Invalid return path.');
  return value;
}

export class Sessions {
  readonly #state: StateStore<SessionsState>;
  readonly #tenant: TenantName;
  readonly #origin: string;
  readonly #max: number;
  readonly #now: () => number;
  readonly #ttl: number;

  constructor(options: {
    state: StateStore<SessionsState>; tenant: TenantName; controlOrigin: string;
    maxSessions: number; now?: () => number; ttlMs?: number;
  }) {
    this.#state = options.state;
    this.#tenant = options.tenant;
    this.#origin = sessionOrigin(options.controlOrigin);
    this.#max = options.maxSessions;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.#max) || this.#max < 1 || !Number.isSafeInteger(this.#ttl) || this.#ttl < 1) {
      throw new Error('Invalid session limits.');
    }
  }

  #active(state: SessionsState, session: StoredSession): boolean {
    if (session.expiresAt <= this.#now() || session.account.tenant !== this.#tenant) return false;
    if (session.scope.kind === 'control') return session.parent === null && session.scope.origin === this.#origin;
    const parent = state.sessions.find(item => item.hash === session.parent);
    return !!parent && parent.scope.kind === 'control' && parent.account.userId === session.account.userId && this.#active(state, parent);
  }

  #prune(state: SessionsState): void {
    state.sessions = state.sessions.filter(session => this.#active(state, session));
    state.grants = state.grants.filter(grant => grant.expiresAt > this.#now()
      && state.sessions.some(session => session.hash === grant.parent && session.scope.kind === 'control'));
  }

  #authenticated(session: StoredSession): AuthenticatedSession {
    return {
      actor: { kind: 'session', userId: session.account.userId, sessionHash: session.hash },
      account: session.account, csrf: session.csrf, scope: session.scope, expiresAt: session.expiresAt,
    };
  }

  async #new(account: PersonalAccount, scope: SessionScope, parent: string | null): Promise<CreatedSession> {
    if (account.tenant !== this.#tenant) forbidden();
    const secret = randomSecret();
    const hash = await sha256(secret);
    const session: StoredSession = { hash, account, csrf: randomSecret(), expiresAt: this.#now() + this.#ttl, scope, parent };
    this.#state.update(state => {
      this.#prune(state);
      if (state.sessions.length + state.grants.length >= this.#max) quota('Session capacity has been reached.');
      state.sessions.push(session);
    });
    return { ...this.#authenticated(session), sessionHash: hash, credential: `pcs1.${this.#tenant}.${secret}` };
  }

  async createControl(account: PersonalAccount): Promise<CreatedSession> {
    return this.#new(account, { kind: 'control', origin: this.#origin }, null);
  }

  async authenticate(credential: string, scope: SessionScope): Promise<AuthenticatedSession | null> {
    const parsed = parseCredential(credential);
    if (!parsed || parsed.tenant !== this.#tenant || parsed.kind !== scope.kind) return null;
    const hash = await sha256(parsed.secret);
    const state = this.#state.read();
    const session = state.sessions.find(item => item.hash === hash);
    if (!session || !this.#active(state, session) || session.scope.kind !== scope.kind || session.scope.origin !== scope.origin
      || (session.scope.kind === 'app' && (scope.kind !== 'app' || session.scope.appId !== scope.appId))) return null;
    return this.#authenticated(session);
  }

  isActive(hash: string, userId: string, kind?: SessionScope['kind']): boolean {
    const state = this.#state.read();
    const session = state.sessions.find(item => item.hash === hash && item.account.userId === userId);
    return !!session && (kind === undefined || session.scope.kind === kind) && this.#active(state, session);
  }

  revoke(hash: string): void {
    this.#state.update(state => {
      state.sessions = state.sessions.filter(session => session.hash !== hash);
      this.#prune(state);
    });
  }

  async createGrant(actor: Actor, target: GrantTarget): Promise<{ code: string; expiresAt: number }> {
    sessionOrigin(target.origin);
    relativeReturnPath(target.returnPath);
    if (!/^[0-9a-f]{64}$/.test(target.nonceHash) || typeof target.appId !== 'string' || target.appId.length < 1) invalid('Invalid app grant.');
    const secret = randomSecret();
    const hash = await sha256(secret);
    const expiresAt = this.#now() + 60_000;
    this.#state.update(state => {
      this.#prune(state);
      const parent = actor.kind === 'session' ? state.sessions.find(item => item.hash === actor.sessionHash) : undefined;
      if (!parent || parent.scope.kind !== 'control' || actor.kind !== 'session' || parent.account.userId !== actor.userId) forbidden();
      if (state.sessions.length + state.grants.length >= this.#max) quota('Session capacity has been reached.');
      state.grants.push({ ...target, hash, parent: parent.hash, expiresAt });
    });
    return { code: `pg1.${this.#tenant}.${secret}`, expiresAt };
  }

  async consumeGrant(code: string, input: { appId: AppId; origin: string; nonce: string }): Promise<CreatedSession & { returnPath: string }> {
    const parsed = parseCredential(code);
    if (!parsed || parsed.kind !== 'grant' || parsed.tenant !== this.#tenant || typeof input.nonce !== 'string'
      || !/^[0-9a-f]{64}$/.test(input.nonce)) forbidden('Invalid app grant.');
    const [hash, nonceHash] = await Promise.all([sha256(parsed.secret), sha256(input.nonce)]);
    const secret = randomSecret();
    const sessionHash = await sha256(secret);
    const csrf = randomSecret();
    return this.#state.update(state => {
      this.#prune(state);
      const grant = state.grants.find(item => item.hash === hash);
      const parent = grant && state.sessions.find(item => item.hash === grant.parent && item.scope.kind === 'control');
      if (!grant || !parent || grant.appId !== input.appId || grant.origin !== input.origin || !sameSecret(grant.nonceHash, nonceHash)) {
        forbidden('Invalid or expired app grant.');
      }
      const scope: SessionScope = { kind: 'app', origin: grant.origin, appId: grant.appId };
      const session: StoredSession = {
        hash: sessionHash, account: parent.account, csrf, expiresAt: Math.min(parent.expiresAt, this.#now() + this.#ttl), scope, parent: parent.hash,
      };
      state.grants = state.grants.filter(item => item.hash !== hash);
      state.sessions.push(session);
      return {
        ...this.#authenticated(session), sessionHash, credential: `pas1.${this.#tenant}.${secret}`, returnPath: grant.returnPath,
      };
    });
  }
}
