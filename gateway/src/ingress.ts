import http from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  APPS_PATH, HEADERS, InputError, LOGIN_PATH, LOGOUT_PATH, NotFound, RESERVED_HEADER_PREFIX, RESERVED_SEGMENT,
  TRIGGER_BODY_LIMIT, appName, effectivePolicy, triggerName,
  type AppId, type BundleStore, type Challenge, type IdentityProvider, type Lease, type Principal, type Registry,
  type RouteView, type Runtime, type Scheduler, type Stats, type Subject,
} from './model.ts';
import { emit } from './events.ts';
import { connect, forward, tunnel, type Hold } from './proxy.ts';
import { requests, type RequestKind } from './requests.ts';
import { serveStatic, staticPath } from './static.ts';

export type IngressDeps = {
  readonly registry: Pick<Registry, 'view' | 'policy'>;
  readonly runtime: Pick<Runtime, 'acquire' | 'release' | 'channel' | 'state'>;
  readonly identity: IdentityProvider;
  readonly bundles: Pick<BundleStore, 'open'>;
  readonly scheduler: Pick<Scheduler, 'invoke'>;
  /** The last snapshot, loaded at startup (INV-7). */
  readonly stats: readonly Stats[];
  readonly flushStats: (stats: Stats[]) => Promise<void>;
  readonly deleteStats: (app: AppId) => Promise<void>;
};

type Reply = { readonly status: number; readonly headers?: OutgoingHttpHeaders; readonly error?: string };

/** Where the prologue (DESIGN 2.2 steps 1 to 7) sends a request. */
type Route =
  | { readonly to: 'reply'; readonly app: AppId | null; readonly reply: Reply }
  | { readonly to: 'identity' }
  | { readonly to: 'trigger'; readonly view: RouteView; readonly trigger: string }
  | { readonly to: 'static'; readonly view: RouteView; readonly path: string }
  | { readonly to: 'app'; readonly view: RouteView; readonly path: string; readonly headers: string[]; readonly subject: Subject | null };

/** What a request record learns on the way through, beyond what the request and response carry. */
type Trace = { subject: string | null; waitMs: number | null; cold: boolean; error: string | null };

type Counter = { requests: number; errors: number; lastAccessAt: number | null };

const log = emit;

function reply(app: AppId | null, status: number, error?: string, headers?: OutgoingHttpHeaders): Route {
  return { to: 'reply', app, reply: { status, error, headers } };
}

function challenge(who: Challenge): Reply {
  return who.status === 303 ? { status: 303, headers: { location: who.location } } : { status: 401, error: 'sign in or send Authorization: Bearer <token>' };
}

/** Inbound headers minus every X-Pneuma-Space-* and X-Forwarded-Prefix, plus the ones the platform sets (INV-5). */
function forwardedHeaders(req: IncomingMessage, view: RouteView, who: Principal | null): string[] {
  const out: string[] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    // CGI-style servers read X_Pneuma_Space_Subject as X-Pneuma-Space-Subject.
    const name = raw[i].toLowerCase().replaceAll('_', '-');
    if (!name.startsWith(RESERVED_HEADER_PREFIX) && name !== HEADERS.prefix) out.push(raw[i], raw[i + 1]);
  }
  out.push(HEADERS.prefix, `${APPS_PATH}/${view.name}`);
  if (who) {
    out.push(HEADERS.subject, who.subject, HEADERS.name, who.name);
    if (who.subject === view.owner) out.push(HEADERS.owner, '1');
  }
  return out;
}

function send(res: ServerResponse, { status, headers, error }: Reply): void {
  const body = error === undefined ? '' : JSON.stringify({ error });
  res.writeHead(status, { ...headers, ...(body && { 'content-type': 'application/json' }), 'content-length': Buffer.byteLength(body) }).end(body);
}

function sendRaw(socket: net.Socket, { status, headers, error }: Reply): void {
  const body = error === undefined ? '' : JSON.stringify({ error });
  const lines = [`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}`, 'connection: close', `content-length: ${Buffer.byteLength(body)}`];
  for (const [name, value] of Object.entries(headers ?? {})) lines.push(`${name}: ${value}`);
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

/**
 * The path an app's URL parser will see: `%2e` decoded, `\` read as `/` (WHATWG URL does both), `//` collapsed and
 * dot segments resolved. Null when it climbs above the app root.
 */
function normalize(rest: string): string | null {
  const segments = rest.replace(/%2e/gi, '.').replaceAll('\\', '/').split('/').slice(1);
  const out: string[] = [];
  for (const [i, segment] of segments.entries()) {
    if (segment === '..' && out.pop() === undefined) return null;
    if (segment !== '' && segment !== '.' && segment !== '..') out.push(segment);
    else if (i === segments.length - 1) out.push('');
  }
  return `/${out.join('/')}`;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The 8080 server: prologue, paths A to D (DESIGN 2.2) and Stats. */
export class Ingress {
  readonly server: http.Server;
  readonly #deps: IngressDeps;
  readonly #stats = new Map<AppId, Counter>();

  constructor(deps: IngressDeps) {
    this.#deps = deps;
    for (const { app, requests, errors, lastAccessAt } of deps.stats) this.#stats.set(app, { requests, errors, lastAccessAt });
    this.server = http.createServer({ requestTimeout: 0 }, (req, res) => void this.#request(req, res))
      .on('upgrade', (req: IncomingMessage, socket: net.Socket, head: Buffer) => void this.#upgrade(req, socket, head));
  }

  listen(port: number, host?: string): Promise<number> {
    return new Promise((resolve) => this.server.listen(port, host, () => {
      const bound = (this.server.address() as AddressInfo).port;
      log('ingress-listening', null, { port: bound });
      resolve(bound);
    }));
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  snapshot(): Stats[] {
    return [...this.#stats].map(([app, counter]) => ({ app, ...counter }));
  }

  flush(): Promise<void> {
    return this.#deps.flushStats(this.snapshot());
  }

  /** For a purged app: its counter and row go, so no later flush brings the row back. */
  forget(app: AppId): Promise<void> {
    this.#stats.delete(app);
    return this.#deps.deleteStats(app);
  }

  #count(app: AppId, status: number): void {
    const counter = this.#stats.get(app) ?? { requests: 0, errors: 0, lastAccessAt: null };
    counter.requests += 1;
    if (status >= 500) counter.errors += 1;
    counter.lastAccessAt = Date.now();
    this.#stats.set(app, counter);
  }

  #record(app: AppId, kind: RequestKind, req: IncomingMessage, status: number, started: number, trace: Trace): void {
    requests.record({ app, kind, method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0], status, ms: performance.now() - started, ...trace });
  }

  /** The gateway's reason, when it has one, wins over the text the client is shown. */
  #send(res: ServerResponse, reply: Reply, trace: Trace): void {
    trace.error ??= reply.error ?? null;
    send(res, reply);
  }

  #view(name: string): RouteView | null {
    let view: RouteView | null;
    try {
      view = this.#deps.registry.view(appName(name));
    } catch (error) {
      if (error instanceof InputError) return null;
      throw error;
    }
    return view?.status === 'registered' && view.release !== null ? view : null;
  }

  async #route(req: IncomingMessage, upgrade: boolean): Promise<Route> {
    const raw = req.url ?? '/';
    const q = raw.indexOf('?');
    const pathname = q < 0 ? raw : raw.slice(0, q);
    const search = q < 0 ? '' : raw.slice(q);
    if (!upgrade && (pathname === LOGIN_PATH || pathname === LOGOUT_PATH)) return { to: 'identity' };

    const match = /^\/apps\/([^/]+)(\/.*)?$/.exec(pathname);
    const view = match && this.#view(match[1]);
    if (!match || !view) return reply(null, 404, 'no app at this address');
    if (match[2] === undefined) return reply(view.app, 308, undefined, { location: `${APPS_PATH}/${view.name}/${search}` });
    const rest = normalize(match[2]);
    if (rest === null) return reply(view.app, 400, 'the path climbs above the app root');

    if (rest === `/${RESERVED_SEGMENT}` || rest.startsWith(`/${RESERVED_SEGMENT}/`)) {
      const trigger = /^\/_pneuma-space\/trigger\/([^/]+)$/.exec(rest);
      if (upgrade || req.method !== 'POST' || !trigger) return reply(view.app, 404, `no platform endpoint at ${rest}`);
      return { to: 'trigger', view, trigger: trigger[1] };
    }
    if (!upgrade && view.bundle && (req.method === 'GET' || req.method === 'HEAD')) {
      const path = staticPath(view.bundle, rest);
      if (path !== null) return { to: 'static', view, path };
    }
    if (upgrade && !view.kinds.has('ws')) return reply(view.app, 426, 'this app does not declare the "ws" capability');

    let who: Principal | null = null;
    if (view.identity) {
      const result = await this.#deps.identity.authenticate(req);
      if ('subject' in result) who = result;
      else if (view.identity.required !== false) return { to: 'reply', app: view.app, reply: challenge(result) };
    }
    if (view.image === null) return reply(view.app, 404, 'no file at this path');
    return { to: 'app', view, path: rest + search, headers: forwardedHeaders(req, view, who), subject: who?.subject ?? null };
  }

  /** Step 8: acquire and connect; a connect failure precedes the request line, so it is retried once with a fresh lease. */
  async #open(app: AppId): Promise<{ lease: Lease; socket: net.Socket }> {
    for (let attempt = 1; ; attempt++) {
      const lease = await this.#deps.runtime.acquire(app, 'request');
      try {
        return { lease, socket: await connect(lease.address) };
      } catch (error) {
        this.#deps.runtime.release(lease);
        if (attempt === 2) throw error;
      }
    }
  }

  async #upstream(view: RouteView, trace: Trace): Promise<{ hold: Hold; socket: net.Socket } | Reply> {
    const from = performance.now();
    trace.cold = this.#deps.runtime.state(view.app) !== 'awake';
    try {
      const { lease, socket } = await this.#open(view.app);
      trace.waitMs = performance.now() - from;
      const { runtime, registry } = this.#deps;
      return {
        socket,
        hold: {
          channel: (onRetire) => runtime.channel(lease, onRetire),
          release: () => runtime.release(lease),
          idleMs: effectivePolicy(registry.policy(), view.policyOverride).connection_idle_seconds * 1000,
        },
      };
    } catch (error) {
      trace.waitMs = performance.now() - from;
      if (error instanceof NotFound) return { status: 404, error: 'no app at this address' };
      trace.error = String(error);
      log('wake-failed', view.app, { error: String(error) });
      return { status: 502, error: `the app did not start; run appctl logs ${view.name}` };
    }
  }

  async #request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const trace: Trace = { subject: null, waitMs: null, cold: false, error: null };
    try {
      const route = await this.#route(req, false);
      if (route.to !== 'identity') {
        const app = route.to === 'reply' ? route.app : route.view.app;
        const kind = route.to === 'static' ? 'static' : 'request';
        if (route.to === 'app') trace.subject = route.subject;
        if (app) res.once('close', () => {
          this.#count(app, res.statusCode);
          this.#record(app, kind, req, res.statusCode, started, trace);
        });
      }
      switch (route.to) {
        case 'reply': return this.#send(res, route.reply, trace);
        case 'identity': return await this.#deps.identity.serve(req, res);
        case 'static': return await serveStatic(req, res, this.#deps.bundles, route.view.bundle!, route.path);
        case 'trigger': return await this.#trigger(req, res, route.view, route.trigger, trace);
        case 'app': {
          const upstream = await this.#upstream(route.view, trace);
          if ('status' in upstream) return this.#send(res, upstream, trace);
          return forward(req, res, upstream.socket, route.path, route.headers, upstream.hold);
        }
      }
    } catch (error) {
      trace.error = String(error);
      log('ingress-error', null, { url: req.url, error: String(error) });
      if (!res.headersSent) send(res, { status: 500, error: 'internal error; see the gateway log' });
      else res.destroy();
    }
  }

  async #upgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    const started = performance.now();
    socket.on('error', () => socket.destroy());
    try {
      const route = await this.#route(req, true);
      if (route.to !== 'app') {
        if (route.to === 'reply') {
          if (route.app) {
            this.#count(route.app, route.reply.status);
            this.#record(route.app, 'ws', req, route.reply.status, started, { subject: null, waitMs: null, cold: false, error: route.reply.error ?? null });
          }
          return sendRaw(socket, route.reply);
        }
        return sendRaw(socket, { status: 404 });
      }
      const app = route.view.app;
      const trace: Trace = { subject: route.subject, waitMs: null, cold: false, error: null };
      const upstream = await this.#upstream(route.view, trace);
      const status = 'status' in upstream ? upstream.status : 101;
      this.#count(app, status);
      if ('status' in upstream) {
        trace.error ??= upstream.error ?? null;
        this.#record(app, 'ws', req, status, started, trace);
        return sendRaw(socket, upstream);
      }
      socket.once('close', () => this.#record(app, 'ws', req, status, started, trace));
      tunnel(req, socket, head, upstream.socket, route.path, route.headers, upstream.hold);
    } catch (error) {
      log('ingress-error', null, { url: req.url, error: String(error) });
      socket.destroy();
    }
  }

  async #trigger(req: IncomingMessage, res: ServerResponse, view: RouteView, raw: string, trace: Trace): Promise<void> {
    const who = await this.#deps.identity.authenticate(req);
    if (!('subject' in who)) return this.#send(res, challenge(who), trace);
    trace.subject = who.subject;
    if (!who.subject.startsWith('service:') && who.subject !== view.owner) {
      return this.#send(res, { status: 403, error: 'triggers accept a service token or the owner' }, trace);
    }
    const body = await readBody(req, TRIGGER_BODY_LIMIT);
    if (body === null) return this.#send(res, { status: 413, error: `trigger body exceeds ${TRIGGER_BODY_LIMIT} bytes`, headers: { connection: 'close' } }, trace);
    try {
      const key = req.headers[HEADERS.idempotencyKey];
      const delivery = await this.#deps.scheduler.invoke({
        app: view.app, trigger: triggerName(raw), caller: who.subject, idempotencyKey: typeof key === 'string' ? key : null, body,
      });
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ delivery }));
    } catch (error) {
      if (error instanceof NotFound || error instanceof InputError) return this.#send(res, { status: 404, error: `no trigger "${raw}" in the current release` }, trace);
      throw error;
    }
  }
}
