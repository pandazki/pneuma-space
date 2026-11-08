import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { emit } from './events.ts';
import type { Metrics } from './metrics.ts';
import type { Runtimes } from './runtimes.ts';
import { RING, type RequestLog } from './requests.ts';
import { can, LOCAL_CALLER, type Action, type Authority } from './authz.ts';
import type { Answer, Identity } from './identity.ts';
import type { AdminRegistry } from './registry.ts';
import {
  ACCESS_LEVELS, ADMIN_PATHS, ADMIN_PORT, AUDIT_ACTIONS, Conflict, DEFAULT_TENANT, InputError, NotFound, QuotaExceeded, RUNTIME_KINDS, RUNTIMES, USAGE_COUNTERS,
  appName, bundleId, parseManifest, subject, tenantName,
  type Access, type Actor, type AppId, type AuditAction, type AuditRecord, type BundleStore, type Caller, type Guard, type Release, type Role, type StoreOps,
  type Subject, type TenantName, type UsageBucket, type UsageCounters,
} from './model.ts';

export type AdminDeps = {
  readonly registry: AdminRegistry;
  readonly bundles: BundleStore;
  readonly runtime: Pick<Runtimes, 'logs' | 'healthOf'>;
  readonly guard: Guard;
  readonly metrics: Pick<Metrics, 'snapshot'>;
  readonly requests: Pick<RequestLog, 'after'>;
  readonly store: Pick<StoreOps, 'usage' | 'insertAudit' | 'audit' | 'tenant' | 'tenants' | 'quotaUsed' | 'memberships' | 'user' | 'tokens'>;
  readonly ingressPort: number;
  readonly consoleFile?: string | URL;
  /** The console-audience provider and the Authority; absent under `local`, where every request is LOCAL_CALLER (ADR 0022 item 4). */
  readonly upstream?: { readonly identity: Pick<Identity, 'identify' | 'challenge'>; readonly authority: Pick<Authority, 'callerOf'> };
};

/** ADMIN_PATHS lacks these while model.ts is frozen. */
const TENANT_PATHS = {
  me: '/api/me',
  tenants: '/api/tenants',
  access: (name: string) => `/api/apps/${name}/access`,
  move: (name: string) => `/api/apps/${name}/tenant`,
  quota: (tenant: string) => `/api/tenants/${tenant}/quota`,
  members: (tenant: string) => `/api/tenants/${tenant}/members`,
  member: (tenant: string, user: string) => `/api/tenants/${tenant}/members/${user}`,
  tokens: (tenant: string) => `/api/tenants/${tenant}/tokens`,
  token: (tenant: string, id: string) => `/api/tenants/${tenant}/tokens/${id}`,
} as const;

const BODY_LIMIT = 1024 * 1024;
const MAX_TAIL = 10_000;
const HOUR = 3_600_000;
const USAGE_SPAN_MS = 30 * 24 * HOUR;
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,22}$/;
const READS = new Set(['GET', 'HEAD']);

class Forbidden extends Error {}

type Body = Readonly<Record<string, unknown>>;
type Ctx = { readonly request: IncomingMessage; readonly query: URLSearchParams; readonly params: readonly string[]; readonly body: Body; readonly caller: Caller };
/** What `can` checks against: the target's tenant, the app's owner or the token's issuer, and the 404 text for a target hidden from the caller. */
type Scope = { readonly tenant: TenantName | null; readonly holder?: Subject | 'local' | null; readonly hidden?: string };
/** A string result is sent as text/plain, anything else as JSON. */
type Handler = (ctx: Ctx, scope: Scope) => Promise<unknown> | unknown;
type Target = { readonly kind: AuditRecord['targetKind']; readonly id: string; readonly tenant: TenantName | null };
/** `action` and `target` run before the handler and must not throw; `details` never returns a secret, and gets no result before the handler succeeds. */
type Audit = {
  readonly action: AuditAction | ((ctx: Ctx, scope: Scope) => Promise<AuditAction>);
  readonly target: (ctx: Ctx, scope: Scope) => Target;
  readonly details?: (body: Body, result?: unknown) => Record<string, unknown>;
};
/**
 * One row of ADR 0022 item 5. `scope` may throw an input error, which is answered after the audit's started row.
 * `json` routes get the parsed request body; `audit` marks a state-changing route (ADR 0024 item 6).
 */
type Route = {
  readonly method: string;
  readonly path: RegExp;
  readonly action: Action | ((ctx: Ctx) => Action);
  readonly scope?: (ctx: Ctx) => Scope | Promise<Scope>;
  readonly handle: Handler;
  readonly json?: true;
  readonly audit?: Audit;
};
type AuditResult = AuditRecord['result'];

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new InputError(`request body over ${BODY_LIMIT} bytes`);
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InputError('request body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new InputError('request body must be a JSON object');
  return body as Record<string, unknown>;
}

function optional<T>(value: unknown, field: string, parse: (raw: string) => T): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InputError(`${field} must be a string or null`);
  return parse(value);
}

function wholeParam(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = query.get(name) ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new InputError(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  return value;
}

/** `from` and `to` in epoch ms over hourly buckets; the last 30 days by default. */
function usageWindow(query: URLSearchParams): { readonly from: number; readonly to: number } {
  const next = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
  const to = wholeParam(query, 'to', next, 0, Number.MAX_SAFE_INTEGER);
  const from = wholeParam(query, 'from', to - USAGE_SPAN_MS, 0, Number.MAX_SAFE_INTEGER);
  if (from >= to) throw new InputError('from must be before to');
  return { from, to };
}

const zero = (): Record<string, number> => Object.fromEntries(USAGE_COUNTERS.map((c) => [c, 0]));

/** Buckets of several apps summed into one row per start, oldest first. */
function byStart(rows: readonly UsageBucket[]): (UsageCounters & { readonly start: number })[] {
  const out = new Map<number, Record<string, number>>();
  for (const b of rows) {
    const sum = out.get(b.start) ?? { start: b.start, ...zero() };
    for (const c of USAGE_COUNTERS) sum[c] += b[c];
    out.set(b.start, sum);
  }
  return [...out.values()].sort((a, b) => a.start - b.start) as (UsageCounters & { readonly start: number })[];
}

function auditFilter(query: URLSearchParams) {
  const given = (name: string) => query.get(name) || undefined;
  const tenant = given('tenant');
  const action = given('action');
  if (action !== undefined && !(AUDIT_ACTIONS as readonly string[]).includes(action)) throw new InputError(`action must be one of ${AUDIT_ACTIONS.join(', ')}, got "${action}"`);
  return {
    ...(tenant !== undefined && { tenant: tenantName(tenant) }),
    from: wholeParam(query, 'from', 0, 0, Number.MAX_SAFE_INTEGER),
    to: wholeParam(query, 'to', Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER),
    actor: given('actor'),
    action: action as AuditAction | undefined,
    target: given('target'),
    limit: wholeParam(query, 'limit', 100, 1, 1000),
  };
}

function userId(raw: unknown): string {
  if (typeof raw !== 'string') throw new InputError('a user is given by id, a string');
  return subject(`user:${raw}`).slice('user:'.length);
}

const subjectOf = (actor: Actor): Subject | null => ('subject' in actor ? actor.subject : null);

/** A first publish lands in the named tenant, or in the caller's only one (ADR 0022 item 3). */
function firstTenant({ body, caller }: Ctx): TenantName {
  const named = optional(body.tenant, 'tenant', tenantName);
  if (named !== null) return named;
  const mine = [...caller.roles.keys()];
  if (mine.length === 1) return mine[0]!;
  if (mine.length === 0 && !caller.platformAdmin) throw new Forbidden('requires membership of a tenant');
  throw new InputError(`tenant is required on a first publish${mine.length ? `; you are in ${mine.join(', ')}` : ''}`);
}

function routes({ registry, bundles, runtime, guard, metrics, requests, store, ingressPort, upstream }: AdminDeps): Route[] {
  const app = (name: string | undefined) => appName(name!);
  const found = <T>(value: T | null, name: string | undefined): T => {
    if (value === null) throw new NotFound(`no app named "${name}"`);
    return value;
  };
  const at = (path: string) => new RegExp(`^${path.replace(/<[a-z]+>/g, '([^/]+)')}$`);
  const onApp = (name: string | undefined): Scope => {
    const view = registry.view(app(name));
    return { tenant: view?.tenant ?? null, holder: view?.owner ?? null, hidden: `no app named "${name}"` };
  };
  const onTenant = ({ params: [tenant] }: Ctx): Scope => ({ tenant: tenantName(tenant!) });
  /** `?tenant=` of the records rows; without it only a platform admin passes. */
  const onQuery = ({ query }: Ctx): Scope => {
    const tenant = query.get('tenant');
    return { tenant: tenant ? tenantName(tenant) : null };
  };
  const appTarget = ({ params: [name] }: Ctx, scope: Scope): Target => ({ kind: 'app', id: name ?? '', tenant: scope.tenant });
  const onAppAudit = (action: AuditAction, details?: Audit['details']): Audit => ({ action, target: appTarget, ...(details && { details }) });
  const tenantAdmin = (caller: Caller, tenant: TenantName | null) => caller.platformAdmin || (tenant !== null && caller.roles.get(tenant) === 'admin');
  const tokenSubject = ({ body, caller, params: [tenant] }: Ctx): string =>
    body.kind === 'service' ? `service:${tenant}.${String(body.name)}` : String(subjectOf(caller.actor) ?? '');
  const appRoute = (method: string, path: string, action: Action, handle: Handler, extra: Partial<Route> = {}): Route =>
    ({ method, path: at(path), action, scope: ({ params: [name] }) => onApp(name), handle, ...extra });

  const table: Route[] = [
    {
      method: 'GET', path: at(TENANT_PATHS.me), action: 'me', handle: ({ caller: { actor, roles, platformAdmin } }) => {
        if (actor.via === 'local') return { local: true, platformAdmin: true };
        const name = actor.via === 'upstream' ? actor.name : actor.subject.slice(actor.subject.indexOf(':') + 1);
        return { subject: actor.subject, name, roles: Object.fromEntries(roles), platformAdmin };
      },
    },
    {
      method: 'GET', path: at(ADMIN_PATHS.health), action: 'health', handle: () => ({
        ok: true,
        ingressPort,
        runtimes: Object.fromEntries(RUNTIME_KINDS.map((kind) => [kind, { service: RUNTIMES[kind].service, profile: RUNTIMES[kind].profile, health: runtime.healthOf(kind) }])),
        policy: registry.policy(),
      }),
    },
    {
      method: 'GET', path: at(ADMIN_PATHS.apps), action: 'apps.list', handle: async ({ caller, query }) => {
        const all = await registry.listing();
        if (!caller.platformAdmin) return all.filter((a) => caller.roles.has(a.tenant));
        const tenant = query.get('tenant');
        return tenant ? all.filter((a) => a.tenant === tenantName(tenant)) : all;
      },
    },
    { method: 'GET', path: at(ADMIN_PATHS.metrics), action: 'platform.read', handle: () => metrics.snapshot() },
    {
      method: 'GET', path: at(ADMIN_PATHS.usage),
      action: ({ query }) => (query.get('app') ?? '*') === '*' ? 'records' : 'app.read',
      scope: (ctx) => (ctx.query.get('app') ?? '*') === '*' ? onQuery(ctx) : onApp(ctx.query.get('app')!),
      handle: async ({ query }) => {
        const window = usageWindow(query);
        const name = query.get('app');
        const tenant = query.get('tenant');
        if (name !== null) {
          const app = name === '*' ? '*' : found(registry.view(appName(name)), name).app;
          return { app: name, step: 3600, ...window, buckets: byStart(await store.usage({ step: 3600, app, ...window })) };
        }
        if (tenant !== null) return { tenant, step: 3600, ...window, buckets: byStart(await store.usage({ step: 3600, tenant: tenantName(tenant), ...window })) };
        throw new InputError('app or tenant is required');
      },
    },
    {
      method: 'GET', path: at(ADMIN_PATHS.usageApps), action: 'records', scope: onQuery, handle: async ({ query }) => {
        const tenant = query.get('tenant');
        const rows = await store.usage({ step: 3600, ...usageWindow(query), ...(tenant !== null && { tenant: tenantName(tenant) }) });
        const apps = new Map<AppId, { tenant: string | null; counts: Record<string, number> }>();
        for (const b of rows) {
          if (b.app === '*') continue;
          const entry = apps.get(b.app) ?? { tenant: b.tenant, counts: zero() };
          for (const c of USAGE_COUNTERS) entry.counts[c] += b[c];
          apps.set(b.app, entry);
        }
        return [...apps].map(([id, { tenant: t, counts }]) => ({ app: registry.nameOf(id) ?? id, tenant: t, ...(counts as UsageCounters) }))
          .sort((a, b) => b.requests - a.requests || (a.app < b.app ? -1 : 1))
          .slice(0, wholeParam(query, 'limit', 50, 1, 1000));
      },
    },
    { method: 'GET', path: at(ADMIN_PATHS.audit), action: 'records', scope: onQuery, handle: ({ query }) => store.audit(auditFilter(query)) },
    {
      method: 'GET', path: at(ADMIN_PATHS.requests), action: 'platform.read', handle: ({ query }) => requests
        .after(wholeParam(query, 'after', 0, 0, Number.MAX_SAFE_INTEGER), wholeParam(query, 'limit', 500, 1, RING))
        .map((r) => ({ ...r, app: registry.nameOf(r.app) ?? r.app })),
    },
    appRoute('GET', ADMIN_PATHS.app('<name>'), 'app.read', async ({ params: [name] }) => found(await registry.detail(app(name)), name)),
    appRoute('GET', ADMIN_PATHS.logs('<name>'), 'app.read', ({ query, params: [name] }) => runtime.logs(found(registry.view(app(name)), name).app, wholeParam(query, 'tail', 200, 1, MAX_TAIL))),
    {
      method: 'PUT', path: at(ADMIN_PATHS.release('<name>')), json: true, action: 'app.release',
      scope: (ctx) => {
        const [name] = ctx.params;
        if (registry.view(app(name))) return onApp(name);
        const tenant = firstTenant(ctx);
        return { tenant, hidden: `no tenant named "${tenant}"` };
      },
      audit: onAppAudit('app.publish', (_, result) => {
        const release = result as Release | undefined;
        return release ? { release: release.number, releaseKey: release.releaseKey } : {};
      }),
      handle: ({ params: [name], body, caller }, scope) => registry.publish({
        name: app(name),
        manifest: parseManifest(body.manifest),
        image: optional(body.image, 'image', (raw) => raw),
        bundle: optional(body.bundle, 'bundle', bundleId),
        owner: optional(body.owner, 'owner', subject) ?? subjectOf(caller.actor),
        tenant: scope.tenant ?? DEFAULT_TENANT,
      }),
    },
    { method: 'POST', path: at(ADMIN_PATHS.bundles), action: 'bundles.upload', handle: async ({ request }) => ({ bundle: await bundles.put(request) }) },
    {
      method: 'PUT', path: at(ADMIN_PATHS.policy), json: true, action: 'policy.set',
      audit: { action: 'policy.global', target: () => ({ kind: 'policy', id: 'global', tenant: null }), details: (patch) => ({ patch }) },
      handle: ({ body }) => registry.setGlobalPolicy(body),
    },
    appRoute('PUT', ADMIN_PATHS.appPolicy('<name>'), 'app.policy', ({ params: [name], body }) => registry.setAppPolicy(app(name), body), {
      json: true, audit: onAppAudit('app.policy', (patch) => ({ patch })),
    }),
    appRoute('PUT', TENANT_PATHS.access('<name>'), 'app.access', async ({ params: [name], body }) => {
      if (!(ACCESS_LEVELS as readonly unknown[]).includes(body.access)) throw new InputError(`access must be one of ${ACCESS_LEVELS.join(', ')}`);
      await registry.setAccess(app(name), body.access as Access);
      return { access: body.access };
    }, { json: true, audit: onAppAudit('app.access', (body) => ({ access: body.access })) }),
    appRoute('PUT', ADMIN_PATHS.owner('<name>'), 'app.owner', async ({ params: [name], body }) => {
      const owner = subject(String(body.owner));
      await registry.setOwner(app(name), owner);
      return { owner };
    }, { json: true, audit: onAppAudit('app.owner', (body) => ({ owner: body.owner })) }),
    appRoute('PUT', TENANT_PATHS.move('<name>'), 'app.move', async ({ params: [name], body }) => {
      const tenant = tenantName(String(body.tenant));
      await registry.moveApp(app(name), tenant);
      return { tenant };
    }, { json: true, audit: onAppAudit('app.move', (body) => ({ to: body.tenant })) }),
    appRoute('POST', ADMIN_PATHS.remove('<name>'), 'app.remove', async ({ params: [name] }) => (await registry.remove(app(name)), { status: 'removed' }), {
      audit: onAppAudit('app.remove'),
    }),
    appRoute('POST', ADMIN_PATHS.unquarantine('<name>'), 'app.remove', async ({ params: [name] }) => {
      await guard.unquarantine(found(registry.view(app(name)), name).app);
      return { quarantine: null };
    }, { audit: onAppAudit('app.unquarantine') }),
    appRoute('POST', ADMIN_PATHS.purge('<name>'), 'app.purge', async ({ params: [name] }) => (await registry.purge(app(name)), { status: 'purged' }), {
      audit: onAppAudit('app.purge'),
    }),
    { method: 'GET', path: at(TENANT_PATHS.tenants), action: 'tenants', handle: () => store.tenants() },
    {
      method: 'POST', path: at(TENANT_PATHS.tenants), json: true, action: 'tenants',
      audit: {
        action: 'tenant.create',
        target: ({ body }) => ({ kind: 'tenant', id: String(body.name), tenant: typeof body.name === 'string' ? body.name as TenantName : null }),
        details: (body) => ({ display: body.display, admins: body.admins }),
      },
      handle: ({ body }) => {
        const name = tenantName(String(body.name));
        if (!Array.isArray(body.admins)) throw new InputError('admins must be a list of user ids');
        return registry.createTenant(name, optional(body.display, 'display', (raw) => raw) ?? name, body.admins.map(userId));
      },
    },
    {
      method: 'GET', path: at(TENANT_PATHS.quota('<t>')), action: 'tenant.read', scope: onTenant, handle: async (_, scope) => {
        const tenant = await store.tenant(scope.tenant!);
        if (!tenant) throw new NotFound(`no tenant named "${scope.tenant}"`);
        return { quota: tenant.quota, used: await store.quotaUsed(tenant.name) };
      },
    },
    {
      method: 'PUT', path: at(TENANT_PATHS.quota('<t>')), json: true, action: 'tenant.quota.set', scope: onTenant,
      audit: { action: 'tenant.quota', target: (_, scope) => ({ kind: 'tenant', id: scope.tenant ?? '', tenant: scope.tenant }), details: (patch) => ({ patch }) },
      handle: async ({ body }, scope) => ({ quota: await registry.setQuota(scope.tenant!, body) }),
    },
    {
      method: 'GET', path: at(TENANT_PATHS.members('<t>')), action: 'tenant.read', scope: onTenant, handle: async (_, scope) =>
        Promise.all((await store.memberships({ tenant: scope.tenant! })).map(async ({ user, role }) => {
          const seen = await store.user(user);
          return { id: user, name: seen?.name ?? null, role, firstSeen: seen?.firstSeen ?? null, lastSeen: seen?.lastSeen ?? null };
        })),
    },
    {
      method: 'PUT', path: at(TENANT_PATHS.member('<t>', '<user>')), json: true, action: 'members.write', scope: onTenant,
      audit: {
        action: async ({ params: [, user] }, scope) =>
          scope.tenant !== null && (await store.memberships({ tenant: scope.tenant, user })).length ? 'member.role' : 'member.add',
        target: ({ params: [, user] }, scope) => ({ kind: 'member', id: user ?? '', tenant: scope.tenant }),
        details: (body) => ({ role: body.role }),
      },
      handle: async ({ params: [, user], body, caller }, scope) => {
        if (body.role !== 'admin' && body.role !== 'member') throw new InputError('role must be admin or member');
        const id = userId(user);
        await registry.setMember(scope.tenant!, id, body.role as Role, caller.platformAdmin);
        return { tenant: scope.tenant, user: id, role: body.role };
      },
    },
    {
      method: 'DELETE', path: at(TENANT_PATHS.member('<t>', '<user>')), action: 'members.write', scope: onTenant,
      audit: { action: 'member.remove', target: ({ params: [, user] }, scope) => ({ kind: 'member', id: user ?? '', tenant: scope.tenant }) },
      handle: async ({ params: [, user], caller }, scope) => {
        const id = userId(user);
        await registry.removeMember(scope.tenant!, id, caller.platformAdmin);
        return { tenant: scope.tenant, user: id };
      },
    },
    {
      method: 'GET', path: at(TENANT_PATHS.tokens('<t>')), action: 'tokens.list', scope: onTenant, handle: async ({ caller }, scope) => {
        const all = (await store.tokens(scope.tenant!)).map(({ hash: _, ...token }) => token);
        return tenantAdmin(caller, scope.tenant) ? all : all.filter((t) => t.createdBy === subjectOf(caller.actor));
      },
    },
    {
      method: 'POST', path: at(TENANT_PATHS.tokens('<t>')), json: true, scope: onTenant,
      action: ({ body }) => (body.kind === 'service' ? 'tokens.issue.service' : 'tokens.issue.personal'),
      audit: {
        action: 'token.issue',
        target: (ctx, scope) => ({ kind: 'token', id: tokenSubject(ctx), tenant: scope.tenant }),
        details: (body, result) => ({ kind: body.kind, ...(result ? { token: (result as { id: string }).id } : {}) }),
      },
      handle: ({ body, caller }, scope) => {
        const label = optional(body.label, 'label', (raw) => raw);
        const issuer = subjectOf(caller.actor) ?? 'local';
        if (body.kind === 'service') {
          if (typeof body.name !== 'string' || !SERVICE_NAME.test(body.name)) throw new InputError(`name must match ${SERVICE_NAME.source}`);
          return registry.issueTenantToken(scope.tenant!, subject(`service:${scope.tenant}.${body.name}`), label ?? body.name, issuer);
        }
        if (body.kind !== 'personal') throw new InputError('kind must be service or personal');
        if (issuer === 'local' || !issuer.startsWith('user:')) throw new InputError('a personal token is issued to a signed-in user');
        return registry.issueTenantToken(scope.tenant!, issuer, label ?? 'personal', issuer);
      },
    },
    {
      method: 'DELETE', path: at(TENANT_PATHS.token('<t>', '<id>')), action: 'tokens.revoke',
      scope: async (ctx) => {
        const { tenant } = onTenant(ctx);
        return { tenant, holder: (await store.tokens(tenant!)).find((t) => t.id === ctx.params[1])?.createdBy ?? null };
      },
      audit: { action: 'token.revoke', target: ({ params: [, id] }, scope) => ({ kind: 'token', id: id ?? '', tenant: scope.tenant }) },
      handle: async ({ params: [, id] }, scope) => (await registry.revokeToken(scope.tenant!, id!), { revoked: id }),
    },
  ];
  if (upstream) return table;
  return [...table, {
    method: 'POST', path: at(ADMIN_PATHS.tokens), json: true, action: 'tokens.issue.service', scope: () => ({ tenant: DEFAULT_TENANT }),
    audit: {
      action: 'token.issue',
      target: ({ body }) => ({ kind: 'token', id: `service:${String(body.name)}`, tenant: DEFAULT_TENANT }),
      details: (_, result) => (result ? { token: (result as { id: string }).id } : {}),
    },
    handle: ({ body: { name } }) => {
      if (typeof name !== 'string') throw new InputError('name must be a string');
      return registry.issueToken(name);
    },
  }];
}

function statusOf(error: unknown): number {
  if (error instanceof InputError) return 400;
  if (error instanceof Forbidden) return 403;
  if (error instanceof NotFound) return 404;
  if (error instanceof Conflict) return 409;
  return 500;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_, value) => (value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value));
  response.writeHead(status, { 'content-type': 'application/json' }).end(json);
}

/** The actor column, and what ADR 0022 item 7 adds to trace it to a person: the name, or the token and its issuer. */
function actorColumns(actor: Actor): { readonly actor: Subject | 'local'; readonly details: Record<string, unknown> } {
  if (actor.via === 'local') return { actor: 'local', details: {} };
  const { subject, ...rest } = actor;
  return { actor: subject, details: { actor: rest } };
}

/** The started row is awaited, so a command never runs unaudited; a lost result row is reported, not answered as a failure of a command that ran. */
async function audited(store: AdminDeps['store'], audit: Audit, ctx: Ctx, scope: Scope, run: () => unknown): Promise<unknown> {
  const { caller, body } = ctx;
  const target = audit.target(ctx, scope);
  const action = typeof audit.action === 'string' ? audit.action : await audit.action(ctx, scope);
  const who = actorColumns(caller.actor);
  const row = (result: AuditResult, details: Record<string, unknown>) => store.insertAudit({
    at: Date.now(),
    actor: who.actor,
    actorTenant: caller.platformAdmin || target.tenant === null || !caller.roles.has(target.tenant) ? null : target.tenant,
    tenant: target.tenant,
    action,
    targetKind: target.kind,
    target: target.id,
    result,
    details: { ...who.details, ...details },
  });
  const settle = (result: AuditResult, details: Record<string, unknown>) =>
    row(result, details).catch((error: Error) => emit('audit-failed', null, { action, target: target.id, result, error: error.message }));
  await row('started', audit.details?.(body) ?? {});
  try {
    const result = await run();
    await settle('ok', audit.details?.(body, result) ?? {});
    return result;
  } catch (error) {
    await settle(statusOf(error) < 500 ? 'refused' : 'error', { ...audit.details?.(body), error: (error as Error).message });
    throw error;
  }
}

/** 403 names what is missing, 404 hides an app in another tenant (ADR 0022 item 5); a signed-in write must come from the console's own origin (ADR 0021 item 7). */
function authorize(route: Route, ctx: Ctx, scope: Scope): void {
  const { caller, request } = ctx;
  if (caller.actor.via === 'upstream' && !READS.has(request.method ?? '') && request.headers['sec-fetch-site'] !== 'same-origin') {
    throw new Forbidden('a signed-in write needs Sec-Fetch-Site: same-origin');
  }
  const verdict = can(caller, typeof route.action === 'string' ? route.action : route.action(ctx), scope.tenant, scope.holder ?? null);
  if (verdict === true) return;
  if (verdict.status === 404) throw new NotFound(scope.hidden ?? 'not found');
  throw new Forbidden(verdict.reason);
}

function answer(response: ServerResponse, reply: Answer, why: string): void {
  if (reply.status === 303) return void response.writeHead(303, { location: reply.location }).end();
  send(response, reply.status, { error: reply.status === 401 ? `not signed in: ${why}` : reply.error });
}

export function createAdmin(deps: AdminDeps): Server {
  const table = routes(deps);
  const consoleFile = deps.consoleFile ?? new URL('./console.html', import.meta.url);
  const callerOf = async (request: IncomingMessage, response: ServerResponse): Promise<Caller | null> => {
    if (!deps.upstream) return LOCAL_CALLER;
    const auth = await deps.upstream.identity.identify(request);
    if (typeof auth !== 'string') return deps.upstream.authority.callerOf(auth);
    answer(response, deps.upstream.identity.challenge(request, auth), auth);
    return null;
  };
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://admin');
    const path = url.pathname;
    try {
      if (request.method === 'GET' && path === '/') {
        const page = await readFile(consoleFile).catch(() => null);
        if (page) return void ((await callerOf(request, response)) && response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page));
      }
      for (const route of table) {
        const match = route.path.exec(path);
        if (!match || route.method !== request.method) continue;
        const caller = await callerOf(request, response);
        if (!caller) return;
        let pending: unknown = null;
        const body = route.json ? await readJson(request).catch((error: unknown) => ((pending = error), {})) : {};
        const ctx: Ctx = { request, query: url.searchParams, params: match.slice(1).map((p) => decodeURIComponent(p)), body, caller };
        const scope: Scope = await Promise.resolve(route.scope?.(ctx) ?? { tenant: null }).catch((error: unknown) => ((pending ??= error), { tenant: null }));
        const run = () => {
          if (pending !== null) throw pending;
          authorize(route, ctx, scope);
          return route.handle(ctx, scope);
        };
        const result = route.audit ? await audited(deps.store, route.audit, ctx, scope, run) : await run();
        if (typeof result === 'string') return void response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(result);
        return send(response, 200, result);
      }
      send(response, 404, { error: `no endpoint ${request.method} ${path}` });
    } catch (error) {
      const status = statusOf(error);
      if (status === 500) emit('admin-error', null, { path, error: String(error) });
      send(response, status, { error: (error as Error).message, ...(error instanceof QuotaExceeded && { quota: { tenant: error.tenant, ...error.refusal } }) });
    }
  });
}

export function startAdmin(deps: AdminDeps, { port = ADMIN_PORT, host = '127.0.0.1' }: { port?: number; host?: string } = {}): Promise<Server> {
  const server = createAdmin(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject).listen(port, host, () => {
      const { port: bound } = server.address() as AddressInfo;
      emit('admin-listening', null, { host, port: bound });
      resolve(server);
    });
  });
}
