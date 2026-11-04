import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ADMIN_PATHS, ADMIN_PORT, Conflict, InputError, NotFound,
  appName, bundleId, parseManifest, subject,
  type BundleStore, type Registry,
} from './model.ts';

export type AdminDeps = {
  readonly registry: Registry;
  readonly bundles: BundleStore;
  readonly consoleFile?: string | URL;
};

const BODY_LIMIT = 1024 * 1024;

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

function routes({ registry, bundles }: AdminDeps): Route[] {
  const app = (name: string | undefined) => appName(name!);
  const found = <T>(value: T | null, name: string | undefined): T => {
    if (value === null) throw new NotFound(`no app named "${name}"`);
    return value;
  };
  const at = (path: string) => new RegExp(`^${path.replace('<name>', '([^/]+)')}$`);
  return [
    { method: 'GET', path: at(ADMIN_PATHS.health), handle: () => ({ ok: true }) },
    { method: 'GET', path: at(ADMIN_PATHS.apps), handle: () => registry.listing() },
    { method: 'GET', path: at(ADMIN_PATHS.app('<name>')), handle: (_, name) => found(registry.detail(app(name)), name) },
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
        registry.setOwner(app(name), owner);
        return { owner };
      },
    },
    { method: 'POST', path: at(ADMIN_PATHS.remove('<name>')), handle: async (_, name) => (await registry.remove(app(name)), { status: 'removed' }) },
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
          return send(response, 200, await route.handle(request, match[1] && decodeURIComponent(match[1])));
        }
      }
      send(response, 404, { error: `no endpoint ${request.method} ${path}` });
    } catch (error) {
      const status = statusOf(error);
      if (status === 500) console.log(JSON.stringify({ t: Date.now(), ev: 'admin-error', app: null, path, error: String(error) }));
      send(response, status, { error: (error as Error).message });
    }
  });
}

export function startAdmin(deps: AdminDeps, { port = ADMIN_PORT, host = '127.0.0.1' }: { port?: number; host?: string } = {}): Promise<Server> {
  const server = createAdmin(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject).listen(port, host, () => {
      const { port: bound } = server.address() as AddressInfo;
      console.log(JSON.stringify({ t: Date.now(), ev: 'admin-listening', app: null, host, port: bound }));
      resolve(server);
    });
  });
}
