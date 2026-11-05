// The isolate runner (ADR 0017): one worker_threads Worker per awake app, a watchdog, and a JSON control API on the platform network.
// It judges nothing: hangs, exits and memory overruns are reported as events and the gateway's Guard decides.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { RUNNER_PORT } from './isolate.ts';
import { RUNTIME_ENV } from './model.ts';
import { tarFiles } from './providers.ts';

export type StartRequest = {
  readonly release: number;
  /** The gateway's hash of the Injection; listed back so a restarted gateway can tell a current instance from a stale one. */
  readonly spec: string;
  readonly bundleUrl: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly storage: readonly { readonly id: string; readonly env: Readonly<Record<string, string>> }[];
  readonly readyMs: number;
};
export type Started = { readonly worker: string; readonly port: number };
export type Listed = { readonly app: string; readonly release: number; readonly spec: string; readonly worker: string; readonly port: number; readonly since: number };
export type RunnerEvent = {
  readonly seq: number; readonly t: number; readonly ev: 'ready' | 'exit' | 'hung' | 'oom';
  readonly app: string; readonly release: number; readonly worker: string; readonly code?: number; readonly reason?: string; readonly port?: number;
};
export type EventPage = { readonly startedAt: number; readonly events: readonly RunnerEvent[] };

const env = process.env;
const DATA = env.PNEUMA_SPACE_DATA ?? '/data';
const PORT = Number(env.PNEUMA_SPACE_RUNNER_PORT ?? RUNNER_PORT);
const HEAP_MB = Number(env.PNEUMA_SPACE_RUNNER_WORKER_HEAP_MB ?? 256);
const OFFHEAP_BYTES = Number(env.PNEUMA_SPACE_RUNNER_WORKER_OFFHEAP_MB ?? 256) * 2 ** 20;
const STUCK_LIMIT = Number(env.PNEUMA_SPACE_RUNNER_STUCK_LIMIT ?? 3);
const PING_MS = 1000;
const SILENCE_MS = 3000;
const TERMINATE_MS = 5000;
// Inside compose's 10 s stop grace, with room for a terminate.
const SHUTDOWN_DRAIN_MS = 3000;
const EVENT_RING = 1000;
const LOG_RING = 1000;
const SHIM = new URL('./isolate-shim.ts', import.meta.url);
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,80}$/;

type Instance = {
  readonly app: string;
  readonly release: number;
  readonly spec: string;
  readonly worker: string;
  readonly thread: Worker;
  readonly since: number;
  port: number | null;
  ping: { readonly seq: number; readonly sentAt: number } | null;
  /** Set by the first terminal event; later ones for this worker are dropped. */
  ended: boolean;
  stopping: boolean;
  error: string | null;
  readonly exited: Promise<void>;
};

const startedAt = Date.now();
const instances = new Map<string, Instance>();
const ring: RunnerEvent[] = [];
const logs = new Map<string, string[]>();
let seq = 0;
let workers = 0;
let pings = 0;
let stuck = 0;

const log = (ev: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: Date.now(), ev, ...extra }));

function record(inst: Instance, ev: RunnerEvent['ev'], extra: { code?: number; reason?: string; port?: number } = {}): void {
  const event: RunnerEvent = { seq: ++seq, t: Date.now(), ev, app: inst.app, release: inst.release, worker: inst.worker, ...extra };
  ring.push(event);
  if (ring.length > EVENT_RING) ring.shift();
  log(`worker-${ev}`, event);
}

function end(inst: Instance, ev: 'exit' | 'hung' | 'oom', extra: { code?: number; reason?: string } = {}): void {
  if (inst.ended) return;
  inst.ended = true;
  if (instances.get(inst.app) === inst) instances.delete(inst.app);
  record(inst, ev, extra);
}

/** terminate() cannot interrupt a blocking native call; such a worker is abandoned as stuck rather than taking the runner down. */
async function terminate(inst: Instance): Promise<void> {
  const done = inst.thread.terminate().then(() => true);
  if (await Promise.race([done, sleep(TERMINATE_MS, false)])) return;
  stuck++;
  if (instances.get(inst.app) === inst) instances.delete(inst.app);
  record(inst, 'exit', { reason: 'stuck' });
  void done.then(() => stuck--);
  if (stuck > STUCK_LIMIT) {
    log('runner-stuck-limit', { stuck, limit: STUCK_LIMIT });
    // process.exit waits for the stuck threads; abort does not, and compose restarts the runner.
    process.abort();
  }
}

async function stop(inst: Instance, drainMs: number): Promise<void> {
  inst.stopping = true;
  inst.thread.postMessage({ type: 'drain' });
  if (!(await Promise.race([inst.exited.then(() => true), sleep(drainMs, false)]))) await terminate(inst);
}

function capture(app: string, stream: NodeJS.ReadableStream): void {
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
    let lines = logs.get(app);
    if (!lines) logs.set(app, (lines = []));
    lines.push(line);
    if (lines.length > LOG_RING) lines.shift();
  });
}

const appDir = (app: string) => join(DATA, 'apps', app);
const storageDir = (app: string, id: string) => join(appDir(app), 'storage', id);
const isRelease = (name: string) => /^\d+$/.test(name);

/** The release's code, downloaded and unpacked once; other releases of the app are dropped. */
async function code(app: string, release: number, url: string): Promise<string> {
  const dir = join(appDir(app), String(release));
  const entries = await readdir(appDir(app)).catch(() => [] as string[]);
  for (const name of entries) if (isRelease(name) && name !== String(release)) await rm(join(appDir(app), name), { recursive: true, force: true });
  if (entries.includes(String(release))) return dir;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`bundle download answered ${response.status}`);
  const tmp = join(appDir(app), `.tmp-${process.pid}-${Date.now()}`);
  for (const { path, body } of tarFiles(Buffer.from(await response.arrayBuffer()))) {
    await mkdir(dirname(join(tmp, path)), { recursive: true });
    await writeFile(join(tmp, path), body);
  }
  await mkdir(tmp, { recursive: true });
  await rename(tmp, dir);
  return dir;
}

async function start(app: string, request: StartRequest): Promise<Started> {
  const current = instances.get(app);
  if (current?.port && current.release === request.release && current.spec === request.spec) return { worker: current.worker, port: current.port };
  if (current) await stop(current, 0);
  const deadline = Date.now() + request.readyMs;
  const dir = await code(app, request.release, request.bundleUrl);
  const storage: Record<string, string> = {};
  for (const binding of request.storage) {
    if (!SEGMENT.test(binding.id)) throw new Error(`storage id ${binding.id} is not a path segment`);
    const target = storageDir(app, binding.id);
    await mkdir(target, { recursive: true });
    for (const [key, value] of Object.entries(binding.env)) storage[key] = value.replaceAll('{dir}', target);
  }
  // No execArgv: any value replaces the inherited --permission, and with it the bans on child_process and addons.
  const thread = new Worker(SHIM, {
    workerData: { entry: pathToFileURL(join(dir, request.entry)).href },
    env: { ...request.env, ...storage, [RUNTIME_ENV.port]: '0' },
    resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: Math.max(8, Math.round(HEAP_MB / 8)) },
    stdout: true,
    stderr: true,
  });
  const exited = Promise.withResolvers<void>();
  const inst: Instance = {
    app, release: request.release, spec: request.spec, worker: `${startedAt}:${++workers}`, thread, since: Date.now(),
    port: null, ping: null, ended: false, stopping: false, error: null, exited: exited.promise,
  };
  instances.set(app, inst);
  capture(app, thread.stdout);
  capture(app, thread.stderr);
  const ready = Promise.withResolvers<number>();
  thread.on('message', (message: { type: 'listening'; port: number } | { type: 'pong'; seq: number; external: number }) => {
    if (message.type === 'listening') {
      inst.port = message.port;
      ready.resolve(message.port);
    } else if (inst.ping?.seq === message.seq) {
      inst.ping = null;
      if (message.external > OFFHEAP_BYTES && !inst.ended) {
        end(inst, 'oom', { reason: 'offheap' });
        void terminate(inst);
      }
    }
  });
  thread.on('error', (error: Error & { code?: string }) => {
    if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') end(inst, 'oom', { reason: 'heap' });
    else inst.error = String(error.stack ?? error);
  });
  thread.on('exit', (exitCode) => {
    exited.resolve();
    ready.reject(new Error(`worker exited with code ${exitCode} before it listened${inst.error ? `: ${inst.error}` : ''}`));
    end(inst, 'exit', { code: exitCode, reason: inst.stopping ? 'stopped' : inst.error ?? undefined });
  });
  const timer = new AbortController();
  const timeout = sleep(Math.max(0, deadline - Date.now()), null, { signal: timer.signal }).catch(() => null);
  const port = await Promise.race([ready.promise, timeout]).finally(() => timer.abort());
  if (port === null) {
    await stop(inst, 0);
    throw new Error(`worker did not listen within ${request.readyMs} ms`);
  }
  record(inst, 'ready', { port });
  return { worker: inst.worker, port };
}

setInterval(() => {
  const now = performance.now();
  for (const inst of instances.values()) {
    if (inst.ended || inst.stopping) continue;
    if (inst.ping && now - inst.ping.sentAt >= SILENCE_MS) {
      end(inst, 'hung', { reason: `no answer to the watchdog for ${SILENCE_MS} ms` });
      void terminate(inst);
    } else if (!inst.ping) {
      inst.ping = { seq: ++pings, sentAt: now };
      inst.thread.postMessage({ type: 'ping', seq: inst.ping.seq });
    }
  }
}, PING_MS);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function body(request: IncomingMessage): Promise<StartRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as StartRequest;
}

function segment(raw: string | undefined): string {
  if (!raw || !SEGMENT.test(raw)) throw new HttpError(404, `no such path segment ${raw}`);
  return raw;
}

async function route(request: IncomingMessage, url: URL): Promise<unknown> {
  const [resource, a, b] = url.pathname.split('/').filter(Boolean);
  const method = request.method;
  if (method === 'GET' && resource === 'health') return { ok: true, startedAt, stuck, workers: instances.size };
  if (method === 'GET' && resource === 'instances' && !a) {
    return [...instances.values()].filter((i) => i.port !== null).map((i): Listed => ({ app: i.app, release: i.release, spec: i.spec, worker: i.worker, port: i.port!, since: i.since }));
  }
  if (method === 'POST' && resource === 'instances') {
    const app = segment(a);
    return start(app, await body(request)).catch((error: Error) => { throw new HttpError(502, error.message); });
  }
  if (method === 'DELETE' && resource === 'instances') {
    const app = segment(a);
    const inst = instances.get(app);
    if (inst) await stop(inst, Number(url.searchParams.get('drain') ?? 0));
    if (url.searchParams.get('retire') === '1') {
      for (const name of await readdir(appDir(app)).catch(() => [] as string[])) if (isRelease(name)) await rm(join(appDir(app), name), { recursive: true, force: true });
    }
    return null;
  }
  if (method === 'GET' && resource === 'events') {
    const after = Number(url.searchParams.get('after') ?? 0);
    return { startedAt, events: ring.filter((e) => e.seq > after) } satisfies EventPage;
  }
  if (method === 'DELETE' && resource === 'storage') {
    await rm(storageDir(segment(a), segment(b)), { recursive: true, force: true });
    return null;
  }
  if (method === 'GET' && resource === 'logs') {
    const tail = Number(url.searchParams.get('tail') ?? 200);
    return (logs.get(segment(a)) ?? []).slice(-tail).join('\n');
  }
  throw new HttpError(404, `no route ${method} ${url.pathname}`);
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  route(request, new URL(request.url ?? '/', 'http://runner')).then(
    (result) => {
      if (result === null) response.writeHead(204).end();
      else if (typeof result === 'string') response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(result);
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    },
    (error: Error) => {
      response.writeHead(error instanceof HttpError ? error.status : 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    },
  );
});

process.once('SIGTERM', async () => {
  server.close();
  await Promise.all([...instances.values()].map((inst) => stop(inst, SHUTDOWN_DRAIN_MS)));
  log('runner-stopped');
  if (stuck > 0) process.abort();
  process.exit(0);
});

server.listen(PORT, '0.0.0.0', () => log('runner-ready', { port: (server.address() as { port: number }).port, startedAt, data: DATA }));
