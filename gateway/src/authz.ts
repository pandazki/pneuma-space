import type { Auth } from './identity.ts';
import { DEFAULT_TENANT, InputError, type Access, type Caller, type Membership, type Role, type Store, type Subject, type TenantName, type Token } from './model.ts';

/** `PNEUMA_SPACE_PLATFORM_ADMINS`; decided per request, never stored (ADR 0022 item 1). */
export type PlatformAdmins = { readonly users: ReadonlySet<string>; readonly groups: ReadonlySet<string> };

export function parsePlatformAdmins(raw: string | undefined): PlatformAdmins {
  const users = new Set<string>();
  const groups = new Set<string>();
  for (const entry of (raw ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [, kind, value] = /^(user|group):(.+)$/.exec(entry) ?? [];
    if (kind === 'user') users.add(value!);
    else if (kind === 'group') groups.add(value!);
    else throw new InputError(`PNEUMA_SPACE_PLATFORM_ADMINS entry "${entry}" must be user:<id> or group:<name>`);
  }
  return { users, groups };
}

const CACHE_MS = 30_000;

type Cached<T> = { readonly value: T; readonly until: number };

/** Token and membership reads behind a 30 s per-replica cache that a `tenant/<name>` change clears (ADR 0022 item 6). */
export class Authority {
  readonly #store: Pick<Store, 'token' | 'memberships'>;
  readonly #admins: PlatformAdmins;
  readonly #now: () => number;
  readonly #tokens = new Map<string, Cached<Token>>();
  readonly #memberships = new Map<string, Cached<readonly Membership[]>>();

  constructor(store: Pick<Store, 'token' | 'memberships' | 'onChange'>, admins: PlatformAdmins, now: () => number = Date.now) {
    this.#store = store;
    this.#admins = admins;
    this.#now = now;
    store.onChange((change) => {
      if (change.kind !== 'tenant') return;
      for (const [hash, cached] of this.#tokens) if (cached.value.tenant === change.name) this.#tokens.delete(hash);
      this.#memberships.clear();
    });
  }

  /** Revoked rows included; a miss is not cached, so random bearer values cannot grow the cache. */
  async token(hash: string): Promise<Token | null> {
    const cached = this.#tokens.get(hash);
    if (cached && cached.until > this.#now()) return cached.value;
    const token = await this.#store.token(hash);
    if (token) this.#tokens.set(hash, { value: token, until: this.#now() + CACHE_MS });
    else this.#tokens.delete(hash);
    return token;
  }

  async memberships(user: string): Promise<readonly Membership[]> {
    const cached = this.#memberships.get(user);
    if (cached && cached.until > this.#now()) return cached.value;
    const rows = await this.#store.memberships({ user });
    this.#memberships.set(user, { value: rows, until: this.#now() + CACHE_MS });
    return rows;
  }

  async callerOf(auth: Auth): Promise<Caller> {
    switch (auth.via) {
      case 'local':
        return LOCAL_CALLER;
      case 'upstream': {
        const id = auth.subject.slice('user:'.length);
        return {
          actor: { via: 'upstream', subject: auth.subject, name: auth.name },
          platformAdmin: this.#admins.users.has(id) || auth.groups.some((group) => this.#admins.groups.has(group)),
          roles: new Map((await this.memberships(id)).map((m) => [m.tenant, m.role])),
          viaToken: false,
        };
      }
      case 'token': {
        const { token } = auth;
        return {
          actor: { via: 'token', subject: token.subject, token: token.id, createdBy: token.createdBy },
          platformAdmin: false,
          roles: new Map([[token.tenant, 'member']]),
          viaToken: true,
        };
      }
    }
  }
}

/** Single host: the admin API is unauthenticated and every write lands in `default` (ADR 0022 item 4). */
export const LOCAL_CALLER: Caller = { actor: { via: 'local' }, platformAdmin: true, roles: new Map([[DEFAULT_TENANT, 'admin']]), viaToken: false };

/**
 * What a row asks of the caller in `T`. `owner` is owner(T): `holder` itself, an admin of T or a service token of T; on an app row the
 * holder is the app's owner, on `apps.create` the owner the new app will get. `holder` in `admin-or-holder` is the app's owner or the token's issuer.
 * Every app row first needs owner(T), else 404.
 */
type Rule =
  | { readonly need: 'signed-in' | 'any-member' | 'platform'; readonly token: boolean }
  | { readonly need: 'member' | 'owner' | 'admin' | 'admin-or-holder'; readonly of: 'app' | 'tenant'; readonly token: boolean };

/** ADR 0022 item 5, one entry per endpoint row. A platform admin passes every level; no token is one, so every platform row is `token: false`. */
export const ACTIONS = {
  'me': { need: 'signed-in', token: true },
  'health': { need: 'signed-in', token: true },
  'apps.list': { need: 'signed-in', token: true },
  'apps.create': { need: 'owner', of: 'tenant', token: true },
  'app.read': { need: 'owner', of: 'app', token: true },
  'platform.read': { need: 'platform', token: false },
  'bundles.upload': { need: 'any-member', token: true },
  'app.release': { need: 'owner', of: 'app', token: true },
  'app.policy': { need: 'owner', of: 'app', token: true },
  'app.access': { need: 'owner', of: 'app', token: true },
  'app.owner': { need: 'admin-or-holder', of: 'app', token: true },
  'app.remove': { need: 'owner', of: 'app', token: true },
  'app.purge': { need: 'admin', of: 'app', token: false },
  'app.move': { need: 'platform', token: false },
  'app.stop': { need: 'owner', of: 'app', token: false },
  'app.kill': { need: 'platform', token: false },
  'cluster.read': { need: 'platform', token: false },
  'cluster.scale': { need: 'platform', token: false },
  'cluster.restart': { need: 'platform', token: false },
  'cluster.drain': { need: 'platform', token: false },
  'policy.set': { need: 'platform', token: false },
  'tenants': { need: 'platform', token: false },
  'tenant.quota.set': { need: 'platform', token: false },
  'tenant.read': { need: 'member', of: 'tenant', token: true },
  'records': { need: 'member', of: 'tenant', token: true },
  'members.write': { need: 'admin', of: 'tenant', token: false },
  'tokens.list': { need: 'member', of: 'tenant', token: false },
  'tokens.issue.service': { need: 'admin', of: 'tenant', token: false },
  'tokens.issue.personal': { need: 'member', of: 'tenant', token: false },
  'tokens.revoke': { need: 'admin-or-holder', of: 'tenant', token: false },
} as const satisfies Record<string, Rule>;

export type Action = keyof typeof ACTIONS;

/** 403 names what is missing; 404 hides an app the caller cannot read. */
export type Denial = { readonly status: 403; readonly reason: string } | { readonly status: 404 };

const subjectOf = (caller: Caller): Subject | null => ('subject' in caller.actor ? caller.actor.subject : null);

/** Whose apps in `tenant` the caller reads and changes: all of them (a platform admin, an admin of it, its service token), only those it owns (a member, by JWT or personal token), or none. */
export function reach(caller: Caller, tenant: TenantName): 'all' | Subject | null {
  if (caller.platformAdmin) return 'all';
  const role = caller.roles.get(tenant);
  if (role === undefined) return null;
  const subject = subjectOf(caller)!;
  return role === 'admin' || subject.startsWith('service:') ? 'all' : subject;
}

/** `tenant` is the target app's or tenant's; null where the row has no target, for an app that does not exist, and for `records` without `?tenant=`, which then needs a platform admin. */
export function can(caller: Caller, action: Action, tenant: TenantName | null, holder: Subject | 'local' | null = null): true | Denial {
  const rule: Rule = ACTIONS[action];
  if (caller.viaToken && !rule.token) return { status: 403, reason: `${action} accepts a signed-in user, not a token` };
  if (caller.platformAdmin) return true;
  switch (rule.need) {
    case 'signed-in':
      return true;
    case 'any-member':
      return caller.roles.size > 0 || { status: 403, reason: 'requires membership of a tenant' };
    case 'platform':
      return { status: 403, reason: 'requires a platform admin' };
  }
  const scope = tenant === null ? null : reach(caller, tenant);
  const owns = scope !== null && (scope === 'all' || scope === holder);
  if (rule.of === 'app' && !owns) return { status: 404 };
  const admin = tenant !== null && caller.roles.get(tenant) === 'admin';
  const passes = rule.need === 'member' ? scope !== null
    : rule.need === 'owner' ? owns
      : rule.need === 'admin' ? admin
        : admin || (scope !== null && subjectOf(caller) === holder);
  if (passes) return true;
  if (tenant === null) return { status: 403, reason: 'requires a platform admin' };
  if (scope === null || rule.need === 'member') return { status: 403, reason: `requires member of tenant "${tenant}"` };
  const or = rule.need === 'owner' ? ' or a service token to name another owner' : rule.need === 'admin-or-holder' ? ` or ${rule.of === 'app' ? 'the owner' : 'the issuer'}` : '';
  return { status: 403, reason: `requires admin of tenant "${tenant}"${or}` };
}

/** The app actions `can` grants the caller on one app, so the console offers only those (ADR 0022 item 5). */
export function appActions(caller: Caller, app: { readonly tenant: TenantName; readonly owner: Subject }): Action[] {
  return (Object.keys(ACTIONS) as Action[]).filter((action) => action.startsWith('app.') && can(caller, action, app.tenant, app.owner) === true);
}

/** ADR 0022 item 6; `caller` is null when the request carries no valid credential. */
export function allows(caller: Caller | null, access: Access, tenant: TenantName): 'ok' | 'challenge' | 'forbidden' {
  if (access === 'public') return 'ok';
  if (caller === null) return 'challenge';
  if (access === 'org' || caller.platformAdmin || caller.roles.has(tenant)) return 'ok';
  return 'forbidden';
}
