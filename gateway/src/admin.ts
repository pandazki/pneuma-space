import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { emit } from './events.ts';
import type { Metrics } from './metrics.ts';
import type { Runtimes } from './runtimes.ts';
import { RING, type RequestLog } from './requests.ts';
import {
  ADMIN_PATHS, ADMIN_PORT, Conflict, InputError, NotFound, RUNTIME_KINDS, RUNTIMES, USAGE_COUNTERS,
  appName, bundleId, parseManifest, subject, tenantName,
  type AppId, type BundleStore, type Guard, type Registry, type StoreOps, type UsageBucket, type UsageCounters,
} from './model.ts';

export type AdminDeps = {
  readonly registry: Registry;
  readonly bundles: BundleStore;
  readonly runtime: Pick<Runtimes, 'logs' | 'healthOf'>;
  readonly guard: Guard;
  readonly metrics: Pick<Metrics, 'snapshot'>;
  readonly requests: Pick<RequestLog, 'after'>;
  readonly usage: Pick<StoreOps, 'usage'>;
  readonly ingressPort: number;
  readonly consoleFile?: string | URL;
};

const BODY_LIMIT = 1024 * 1024;
const MAX_TAIL = 10_000;
const HOUR = 3_600_000;
const USAGE_SPAN_MS = 30 * 24 * HOUR;
const USAGE_PATHS = { usage: '/api/usage', apps: '/api/usage/apps' } as const;

/** A string result is sent as text/plain, anything else as JSON. */
type Handler = (request: IncomingMessage, name: string | undefined) => Promise<unknown> | unknown;
type Route = { readonly method: string; readonly path: RegExp; readonly handle: Handler };

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

function routes({ registry, bundles, runtime, guard, metrics, requests, usage, ingressPort }: AdminDeps): Route[] {
  const app = (name: string | undefined) => appName(name!);
  const found = <T>(value: T | null, name: string | undefined): T => {
    if (value === null) throw new NotFound(`no app named "${name}"`);
    return value;
  };
  const at = (path: string) => new RegExp(`^${path.replace('<name>', '([^/]+)')}$`);
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
      method: 'GET', path: at(USAGE_PATHS.usage), handle: async (request) => {
        const query = new URL(request.url ?? '/', 'http://admin').searchParams;
        const window = usageWindow(request);
        const name = query.get('app');
        const tenant = query.get('tenant');
        if (name !== null) {
          const app = name === '*' ? '*' : found(registry.view(appName(name)), name).app;
          return { app: name, step: 3600, ...window, buckets: byStart(await usage.usage({ step: 3600, app, ...window })) };
        }
        if (tenant !== null) return { tenant, step: 3600, ...window, buckets: byStart(await usage.usage({ step: 3600, tenant: tenantName(tenant), ...window })) };
        throw new InputError('app or tenant is required');
      },
    },
    {
      method: 'GET', path: at(USAGE_PATHS.apps), handle: async (request) => {
        const query = new URL(request.url ?? '/', 'http://admin').searchParams;
        const tenant = query.get('tenant');
        const rows = await usage.usage({ step: 3600, ...usageWindow(request), ...(tenant !== null && { tenant: tenantName(tenant) }) });
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
      method: 'PUT', path: at(ADMIN_PATHS.release('<name>')), handle: async (request, name) => {
        const body = await readJson(request);
        return registry.publish({
          name: app(name),
          manifest: parseManifest(body.manifest),
          image: optional(body.image, 'image', (raw) => raw),
          bundle: optional(body.bundle, 'bundle', bundleId),
          owner: optional(body.owner, 'owner', subject),
        });
      },
    },
    { method: 'POST', path: at(ADMIN_PATHS.bundles), handle: async (request) => ({ bundle: await bundles.put(request) }) },
    { method: 'PUT', path: at(ADMIN_PATHS.policy), handle: async (request) => registry.setGlobalPolicy(await readJson(request)) },
    { method: 'PUT', path: at(ADMIN_PATHS.appPolicy('<name>')), handle: async (request, name) => registry.setAppPolicy(app(name), await readJson(request)) },
    {
      method: 'PUT', path: at(ADMIN_PATHS.owner('<name>')), handle: async (request, name) => {
        const owner = subject(String((await readJson(request)).owner));
        await registry.setOwner(app(name), owner);
        return { owner };
      },
    },
    { method: 'POST', path: at(ADMIN_PATHS.remove('<name>')), handle: async (_, name) => (await registry.remove(app(name)), { status: 'removed' }) },
    {
      method: 'POST', path: at(ADMIN_PATHS.unquarantine('<name>')), handle: (_, name) => {
        guard.unquarantine(found(registry.view(app(name)), name).app);
        return { quarantine: null };
      },
    },
    { method: 'POST', path: at(ADMIN_PATHS.purge('<name>')), handle: async (_, name) => (await registry.purge(app(name)), { status: 'purged' }) },
    {
      method: 'POST', path: at(ADMIN_PATHS.tokens), handle: async (request) => {
        const { name } = await readJson(request);
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

export function createAdmin(deps: AdminDeps): Server {
  const table = routes(deps);
  const consoleFile = deps.consoleFile ?? new URL('./console.html', import.meta.url);
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
          const result = await route.handle(request, match[1] && decodeURIComponent(match[1]));
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
