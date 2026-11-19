import { createHash, randomBytes } from 'node:crypto';
import type { AppId, Store, StoreOps } from './model.ts';
import type { HostedAuthData, HostedAuthRecord } from './hosted-model.ts';

export const hostedHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const hostedSecret = (): string => randomBytes(32).toString('base64url');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_LIMIT = 32;

export class HostedSessions {
  readonly #store: Store;
  readonly #now: () => number;
  constructor(store: Store, now: () => number = Date.now) { this.#store = store; this.#now = now; }

  async #put(tx: StoreOps, data: HostedAuthData, duration: number): Promise<{ secret: string; record: HostedAuthRecord }> {
    const now = this.#now();
    await tx.hostedSignupCount('update');
    await tx.sweepHostedAuth(now);
    if (data.user) {
      const records = (await tx.hostedAuthFor(data.user)).filter((record) => !('parent' in data) || record.hash !== data.parent).sort((a, b) => a.createdAt - b.createdAt);
      for (const record of records.slice(0, Math.max(0, records.length - SESSION_LIMIT + ('parent' in data ? 2 : 1)))) await tx.deleteHostedAuth(record.hash);
    }
    const secret = hostedSecret();
    const record = { hash: hostedHash(secret), createdAt: now, expiresAt: now + duration, data };
    await tx.putHostedAuth(record);
    return { secret, record };
  }

  async control(user: string, name: string, origin: string) {
    return this.#store.transaction((tx) => this.#put(tx, { kind: 'control', user, name, origin, csrf: hostedSecret() }, SESSION_MS));
  }

  async login(cookie: string, returnPath: string, verifier: string) {
    return this.#store.transaction((tx) => this.#put(tx, { kind: 'login', user: '', cookieHash: hostedHash(cookie), returnPath, verifier }, 10 * 60 * 1000));
  }

  async consumeLogin(secret: string, cookie: string): Promise<Extract<HostedAuthData, { kind: 'login' }> | null> {
    return this.#store.transaction(async (tx) => {
      const record = await tx.hostedAuth(hostedHash(secret), 'update');
      if (!record || record.expiresAt <= this.#now() || record.data.kind !== 'login' || record.data.cookieHash !== hostedHash(cookie)) return null;
      if (!await tx.deleteHostedAuth(record.hash)) return null;
      return record.data;
    });
  }

  async read(secret: string, origin: string, appId?: AppId): Promise<HostedAuthRecord | null> {
    return this.#store.transaction(async (tx) => {
      const record = await tx.hostedAuth(hostedHash(secret));
      if (!record || record.expiresAt <= this.#now()) return null;
      const data = record.data;
      if (data.kind === 'control') return appId === undefined && data.origin === origin ? record : null;
      if (data.kind !== 'app' || data.origin !== origin || data.appId !== appId) return null;
      const parent = await tx.hostedAuth(data.parent);
      return parent && parent.expiresAt > this.#now() && parent.data.kind === 'control' && parent.data.user === data.user ? record : null;
    });
  }

  async revoke(hash: string): Promise<void> { await this.#store.transaction(async (tx) => { await tx.deleteHostedAuth(hash); }); }

  async grant(parentHash: string, appId: AppId, origin: string, nonce: string, returnPath: string) {
    return this.#store.transaction(async (tx) => {
      await tx.hostedSignupCount('update');
      const parent = await tx.hostedAuth(parentHash, 'share');
      if (!parent || parent.expiresAt <= this.#now() || parent.data.kind !== 'control') return null;
      const { user, name } = parent.data;
      return this.#put(tx, { kind: 'grant', user, name, parent: parentHash, appId, origin, nonceHash: hostedHash(nonce), returnPath }, 60_000);
    });
  }

  async redeem(secret: string, appId: AppId, origin: string, nonce: string) {
    return this.#store.transaction(async (tx) => {
      await tx.hostedSignupCount('update');
      const grant = await tx.hostedAuth(hostedHash(secret), 'update');
      if (!grant || grant.expiresAt <= this.#now() || grant.data.kind !== 'grant') return null;
      const data = grant.data;
      if (data.appId !== appId || data.origin !== origin || data.nonceHash !== hostedHash(nonce)) return null;
      const parent = await tx.hostedAuth(data.parent, 'share');
      if (!parent || parent.expiresAt <= this.#now() || parent.data.kind !== 'control' || parent.data.user !== data.user) return null;
      if (!await tx.deleteHostedAuth(grant.hash)) return null;
      const session = await this.#put(tx, { kind: 'app', user: data.user, name: data.name, parent: data.parent, appId, origin }, Math.min(SESSION_MS, parent.expiresAt - this.#now()));
      return { ...session, returnPath: data.returnPath };
    });
  }
}
