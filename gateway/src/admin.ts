import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { emit } from './events.ts';
import type { Metrics } from './metrics.ts';
import type { Runtimes } from './runtimes.ts';
import { RING, type RequestLog } from './requests.ts';
import { LOCAL_CALLER } from './authz.ts';
import type { Failure } from './identity.ts';
import {
  ADMIN_PATHS, ADMIN_PORT, AUDIT_ACTIONS, Conflict, DEFAULT_TENANT, InputError, NotFound, RUNTIME_KINDS, RUNTIMES, USAGE_COUNTERS,
  appName, bundleId, parseManifest, subject, tenantName,
  type Actor, type AppId, type AuditAction, type AuditRecord, type BundleStore, type Caller, type Guard, type Registry, type Release, type StoreOps,
  type Subject, type TenantName, type UsageBucket, type UsageCounters,
} from './model.ts';

export type AdminDeps = {
  readonly registry: Registry;
  readonly bundles: BundleStore;
  readonly runtime: Pick<Runtimes, 'logs' | 'healthOf'>;
  readonly guard: Guard;
  readonly metrics: Pick<Metrics, 'snapshot'>;
  readonly requests: Pick<RequestLog, 'after'>;
  readonly store: Pick<StoreOps, 'usage' | 'insertAudit' | 'audit'>;
  readonly ingressPort: number;
  readonly consoleFile?: string | URL;
  /** Who is asking; LOCAL_CALLER when absent, as under `local` (ADR 0022 item 4). */
  readonly caller?: (request: IncomingMessage) => Promise<Caller | Failure>;
};

const BODY_LIMIT = 1024 * 1024;
const MAX_TAIL = 10_000;
const HOUR = 3_600_000;
const USAGE_SPAN_MS = 30 * 24 * HOUR;
// ADMIN_PATHS lacks it while model.ts is frozen.

type Body = Readonly<Record<string, unknown>>;
/** A string result is sent as text/plain, anything else as JSON. */
type Handler = (request: IncomingMessage, name: string | undefined, body: Body) => Promise<unknown> | unknown;
type Target = { readonly kind: AuditRecord['targetKind']; readonly id: string; readonly tenant: TenantName | null };
/** `target` runs before the handler and must not throw; `details` never returns a secret, and gets no result before the handler succeeds. */
type Audit = {
  readonly action: AuditAction;
  readonly target: (name: string | undefined, body: Body) => Target;
  readonly details?: (body: Body, result?: unknown) => Record<string, unknown>;
};
/** `json` routes get the parsed request body; `audit` marks a state-changing route (ADR 0024 item 6). */
type Route = { readonly method: string; readonly path: RegExp; readonly handle: Handler; readonly json?: true; readonly audit?: Audit };
// ADR 0024 item 6 names `started` beside the three results; AuditRecord['result'] lacks it while model.ts is frozen.
type AuditResult = 'started' | AuditRecord['result'];

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

function wholeParam(request: IncomingMessage, name: string, fallback: number, min: number, max: number): number {
  const raw = new URL(request.url ?? '/', 'http://admin').searchParams.get(name) ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new InputError(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  return value;
}

/** `from` and `to` in epoch ms over hourly buckets; the last 30 days by default. */
function usageWindow(request: IncomingMessage): { readonly from: number; readonly to: number } {
  const next = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
  const to = wholeParam(request, 'to', next, 0, Number.MAX_SAFE_INTEGER);
  const from = wholeParam(request, 'from', to - USAGE_SPAN_MS, 0, Number.MAX_SAFE_INTEGER);
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

function auditFilter(request: IncomingMessage) {
  const query = new URL(request.url ?? '/', 'http://admin').searchParams;
  const given = (name: string) => query.get(name) || undefined;
  const tenant = given('tenant');
  const action = given('action');
  if (action !== undefined && !(AUDIT_ACTIONS as readonly string[]).includes(action)) throw new InputError(`action must be one of ${AUDIT_ACTIONS.join(', ')}, got "${action}"`);
  return {
    ...(tenant !== undefined && { tenant: tenantName(tenant) }),
    from: wholeParam(request, 'from', 0, 0, Number.MAX_SAFE_INTEGER),
    to: wholeParam(request, 'to', Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER),
    actor: given('actor'),
    action: action as AuditAction | undefined,
    target: given('target'),
    limit: wholeParam(request, 'limit', 100, 1, 1000),
  };
}

function routes({ registry, bundles, runtime, guard, metrics, requests, store, ingressPort }: AdminDeps): Route[] {
  const app = (name: string | undefined) => appName(name!);
  const found = <T>(value: T | null, name: string | undefined): T => {
    if (value === null) throw new NotFound(`no app named "${name}"`);
    return value;
  };
  const at = (path: string) => new RegExp(`^${path.replace('<name>', '([^/]+)')}$`);
  /** A malformed name has no view; the handler refuses it. A first publish lands in DEFAULT_TENANT until the route passes `tenant`. */
  const appTarget = (name: string | undefined): Target => {
    let tenant: TenantName = DEFAULT_TENANT;
    try {
      tenant = registry.view(appName(name ?? ''))?.tenant ?? DEFAULT_TENANT;
    } catch {}
    return { kind: 'app', id: name ?? '', tenant };
  };
  const onApp = (action: AuditAction, details?: Audit['details']): Audit => ({ action, target: appTarget, ...(details && { details }) });
  return [
    {
      method: 'GET', path: at(ADMIN_PATHS.health), handle: () => ({
        ok: true,
        ingressPort,
        runtimes: Object.fromEntries(RUNTIME_KINDS.map((kind) => [kind, { service: RUNTIMES[kind].service, profile: RUNTIMES[kind].profile, health: runtime.healthOf(kind) }])),
        policy: registry.policy(),
      }),
    },
    { method: 'GET', path: at(ADMIN_PATHS.apps), handle: () => registry.listing() },
    { method: 'GET', path: at(ADMIN_PATHS.metrics), handle: () => metrics.snapshot() },
    {
      method: 'GET', path: at(ADMIN_PATHS.usage), handle: async (request) => {
        const query = new URL(request.url ?? '/', 'http://admin').searchParams;
        const window = usageWindow(request);
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
      method: 'GET', path: at(ADMIN_PATHS.usageApps), handle: async (request) => {
        const query = new URL(request.url ?? '/', 'http://admin').searchParams;
        const tenant = query.get('tenant');
        const rows = await store.usage({ step: 3600, ...usageWindow(request), ...(tenant !== null && { tenant: tenantName(tenant) }) });
        const apps = new Map<AppId, { tenant: string | null; counts: Record<string, number> }>();
        for (const b of rows) {
          if (b.app === '*') continue;
          const entry = apps.get(b.app) ?? { tenant: b.tenant, counts: zero() };
          for (const c of USAGE_COUNTERS) entry.counts[c] += b[c];
          apps.set(b.app, entry);
        }
        return [...apps].map(([id, { tenant: t, counts }]) => ({ app: registry.nameOf(id) ?? id, tenant: t, ...(counts as UsageCounters) }))
          .sort((a, b) => b.requests - a.requests || (a.app < b.app ? -1 : 1))
          .slice(0, wholeParam(request, 'limit', 50, 1, 1000));
      },
    },
    { method: 'GET', path: at(ADMIN_PATHS.audit), handle: (request) => store.audit(auditFilter(request)) },
    {
      method: 'GET', path: at(ADMIN_PATHS.requests), handle: (request) => requests
        .after(wholeParam(request, 'after', 0, 0, Number.MAX_SAFE_INTEGER), wholeParam(request, 'limit', 500, 1, RING))
        .map((r) => ({ ...r, app: registry.nameOf(r.app) ?? r.app })),
    },
    {
      method: 'GET', path: at(ADMIN_PATHS.app('<name>')), handle: async (_, name) => found(await registry.detail(app(name)), name),
    },
    { method: 'GET', path: at(ADMIN_PATHS.logs('<name>')), handle: (request, name) => runtime.logs(found(registry.view(app(name)), name).app, wholeParam(request, 'tail', 200, 1, MAX_TAIL)) },
    {
      method: 'PUT', path: at(ADMIN_PATHS.release('<name>')), json: true,
      audit: onApp('app.publish', (_, result) => {
        const release = result as Release | undefined;
        return release ? { release: release.number, releaseKey: release.releaseKey } : {};
      }),
      handle: (_, name, body) => registry.publish({
        name: app(name),
        manifest: parseManifest(body.manifest),
        image: optional(body.image, 'image', (raw) => raw),
        bundle: optional(body.bundle, 'bundle', bundleId),
        owner: optional(body.owner, 'owner', subject),
      }),
    },
    { method: 'POST', path: at(ADMIN_PATHS.bundles), handle: async (request) => ({ bundle: await bundles.put(request) }) },
    {
      method: 'PUT', path: at(ADMIN_PATHS.policy), json: true,
      audit: { action: 'policy.global', target: () => ({ kind: 'policy', id: 'global', tenant: null }), details: (patch) => ({ patch }) },
      handle: (_, __, body) => registry.setGlobalPolicy(body),
    },
    {
      method: 'PUT', path: at(ADMIN_PATHS.appPolicy('<name>')), json: true, audit: onApp('app.policy', (patch) => ({ patch })),
      handle: (_, name, body) => registry.setAppPolicy(app(name), body),
    },
    {
      method: 'PUT', path: at(ADMIN_PATHS.owner('<name>')), json: true, audit: onApp('app.owner', (body) => ({ owner: body.owner })),
      handle: async (_, name, body) => {
        const owner = subject(String(body.owner));
        await registry.setOwner(app(name), owner);
        return { owner };
      },
    },
    { method: 'POST', path: at(ADMIN_PATHS.remove('<name>')), audit: onApp('app.remove'), handle: async (_, name) => (await registry.remove(app(name)), { status: 'removed' }) },
    {
      method: 'POST', path: at(ADMIN_PATHS.unquarantine('<name>')), audit: onApp('app.unquarantine'), handle: (_, name) => {
        guard.unquarantine(found(registry.view(app(name)), name).app);
        return { quarantine: null };
      },
    },
    { method: 'POST', path: at(ADMIN_PATHS.purge('<name>')), audit: onApp('app.purge'), handle: async (_, name) => (await registry.purge(app(name)), { status: 'purged' }) },
    {
      method: 'POST', path: at(ADMIN_PATHS.tokens), json: true,
      audit: {
        action: 'token.issue',
        target: (_, body) => ({ kind: 'token', id: `service:${String(body.name)}`, tenant: DEFAULT_TENANT }),
        details: (_, result) => (result ? { token: (result as { id: string }).id } : {}),
      },
      handle: (_, __, { name }) => {
        if (typeof name !== 'string') throw new InputError('name must be a string');
        return registry.issueToken(name);
      },
    },
  ];
}

function statusOf(error: unknown): number {
  if (error instanceof InputError) return 400;
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
async function audited(store: AdminDeps['store'], caller: Caller, audit: Audit, name: string | undefined, body: Body | Error, run: (body: Body) => unknown): Promise<unknown> {
  const parsed = body instanceof Error ? {} : body;
  const target = audit.target(name, parsed);
  const who = actorColumns(caller.actor);
  const row = (result: AuditResult, details: Record<string, unknown>) => store.insertAudit({
    at: Date.now(),
    actor: who.actor,
    actorTenant: caller.platformAdmin || target.tenant === null || !caller.roles.has(target.tenant) ? null : target.tenant,
    tenant: target.tenant,
    action: audit.action,
    targetKind: target.kind,
    target: target.id,
    result,
    details: { ...who.details, ...details },
  });
  const settle = (result: AuditResult, details: Record<string, unknown>) =>
    row(result, details).catch((error: Error) => emit('audit-failed', null, { action: audit.action, target: target.id, result, error: error.message }));
  await row('started', audit.details?.(parsed) ?? {});
  try {
    if (body instanceof Error) throw body;
    const result = await run(body);
    await settle('ok', audit.details?.(body, result) ?? {});
    return result;
  } catch (error) {
    await settle(statusOf(error) < 500 ? 'refused' : 'error', { ...audit.details?.(parsed), error: (error as Error).message });
    throw error;
  }
}

export function createAdmin(deps: AdminDeps): Server {
  const table = routes(deps);
  const consoleFile = deps.consoleFile ?? new URL('./console.html', import.meta.url);
  const callerOf = deps.caller ?? (async () => LOCAL_CALLER);
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://admin').pathname;
    try {
      if (request.method === 'GET' && path === '/') {
        const page = await readFile(consoleFile).catch(() => null);
        if (page) return void response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
      }
      for (const route of table) {
        const match = route.path.exec(path);
        if (match && route.method === request.method) {
          const caller = await callerOf(request);
          if (typeof caller === 'string') return send(response, caller === 'keys-unavailable' ? 503 : 401, { error: `not signed in: ${caller}` });
          const name = match[1] && decodeURIComponent(match[1]);
          const result = route.audit
            ? await audited(deps.store, caller, route.audit, name, route.json ? await readJson(request).catch((error: Error) => error) : {}, (body) => route.handle(request, name, body))
            : await route.handle(request, name, route.json ? await readJson(request) : {});
          if (typeof result === 'string') return void response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(result);
          return send(response, 200, result);
        }
      }
      send(response, 404, { error: `no endpoint ${request.method} ${path}` });
    } catch (error) {
      const status = statusOf(error);
      if (status === 500) emit('admin-error', null, { path, error: String(error) });
      send(response, status, { error: (error as Error).message });
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
