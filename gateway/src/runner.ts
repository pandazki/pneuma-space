// The isolate runner (ADR 0017): one worker_threads Worker per awake app, a watchdog, and a JSON control API on the platform network.
// It judges nothing: hangs, exits and memory overruns are reported as events and the gateway's Guard decides.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
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
/** `seq` is the newest event's; `after=latest` answers it with no events, for a cursor that starts now. */
export type EventPage = { readonly startedAt: number; readonly seq: number; readonly events: readonly RunnerEvent[] };

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
const LINE_BYTES = 4 * 2 ** 10;
const LOG_BYTES = 256 * 2 ** 10;
const LOG_LINES = 1000;
/** Counted per line on top of its bytes, so empty lines are bounded too. */
const LINE_OVERHEAD = 64;
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
  /** Set by the first terminal event; later ones for this worker are dropped. The instance stays in the map until its thread is gone. */
  ended: boolean;
  stopping: boolean;
  error: string | null;
  readonly exited: Promise<void>;
  terminating: Promise<void> | null;
};

const startedAt = Date.now();
const instances = new Map<string, Instance>();
const ring: RunnerEvent[] = [];
const logs = new Map<string, { readonly lines: Buffer[]; bytes: number }>();
/** One start or stop at a time per app, so a retried start joins the one in flight instead of racing its rename. */
const queues = new Map<string, Promise<unknown>>();
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
  record(inst, ev, extra);
}

/**
 * terminate() cannot interrupt a blocking native call; such a worker is abandoned as stuck rather than taking the runner down.
 * Every caller after the first joins the first, so a worker counts toward the stuck limit once.
 */
function terminate(inst: Instance): Promise<void> {
  return (inst.terminating ??= abandonIfStuck(inst));
}

async function abandonIfStuck(inst: Instance): Promise<void> {
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

function append(app: string, line: Buffer): void {
  let log = logs.get(app);
  if (!log) logs.set(app, (log = { lines: [], bytes: 0 }));
  const kept = Buffer.from(line.subarray(0, LINE_BYTES));
  log.lines.push(kept);
  log.bytes += kept.length + LINE_OVERHEAD;
  while (log.bytes > LOG_BYTES || log.lines.length > LOG_LINES) log.bytes -= log.lines.shift()!.length + LINE_OVERHEAD;
}

/** A line longer than LINE_BYTES is kept up to there and the rest of it, up to the next newline, is dropped. */
function capture(app: string, stream: NodeJS.ReadableStream): void {
  let partial = Buffer.alloc(0);
  let cut = false;
  stream.on('data', (chunk: Buffer) => {
    let rest = partial.length ? Buffer.concat([partial, chunk]) : chunk;
    for (let at = rest.indexOf(10); at !== -1; at = rest.indexOf(10)) {
      if (!cut) append(app, rest.subarray(0, at));
      cut = false;
      rest = rest.subarray(at + 1);
    }
    if (cut) rest = Buffer.alloc(0);
    else if (rest.length > LINE_BYTES) {
      append(app, rest);
      cut = true;
      rest = Buffer.alloc(0);
    }
    partial = Buffer.from(rest);
  });
  stream.once('end', () => { if (partial.length) append(app, partial); });
}

const appDir = (app: string) => join(DATA, 'apps', app);
const storageDir = (app: string, id: string) => join(appDir(app), 'storage', id);
const isRelease = (name: string) => /^\d+$/.test(name);

/** The release's code, downloaded and unpacked once; other releases of the app are dropped. */
async function code(app: string, release: number, url: string, deadline: number): Promise<string> {
  const dir = join(appDir(app), String(release));
  const entries = await readdir(appDir(app)).catch(() => [] as string[]);
  for (const name of entries) if (isRelease(name) && name !== String(release)) await rm(join(appDir(app), name), { recursive: true, force: true });
  if (entries.includes(String(release))) return dir;
  const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  const tar = await (async () => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`bundle download answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  })().catch((error: Error) => {
    throw signal.aborted ? new Error('bundle download did not finish within the ready timeout') : error;
  });
  const tmp = join(appDir(app), `.tmp-${process.pid}-${Date.now()}`);
  try {
    for (const { path, body } of tarFiles(tar)) {
      await mkdir(dirname(join(tmp, path)), { recursive: true });
      await writeFile(join(tmp, path), body);
    }
    await mkdir(tmp, { recursive: true });
    await rename(tmp, dir);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

async function start(app: string, request: StartRequest): Promise<Started> {
  const current = instances.get(app);
  if (current && !current.ended && current.port && current.release === request.release && current.spec === request.spec) return { worker: current.worker, port: current.port };
  if (current) await stop(current, 0);
  const deadline = Date.now() + request.readyMs;
  const dir = await code(app, request.release, request.bundleUrl, deadline);
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
    env: { ...request.env, ...storage },
    resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: Math.max(8, Math.round(HEAP_MB / 8)) },
    stdout: true,
    stderr: true,
  });
  const exited = Promise.withResolvers<void>();
  const inst: Instance = {
    app, release: request.release, spec: request.spec, worker: `${startedAt}:${++workers}`, thread, since: Date.now(),
    port: null, ping: null, ended: false, stopping: false, error: null, exited: exited.promise, terminating: null,
  };
  instances.set(app, inst);
  capture(app, thread.stdout);
  capture(app, thread.stderr);
  const ready = Promise.withResolvers<number>();
  thread.on('message', (message: { type: 'listening'; port: number } | { type: 'pong'; seq: number; external: number }) => {
    if (message.type === 'listening') {
      inst.port = message.port;
      // The hang clock starts here: a ping unanswered during startup belongs to the ready timeout.
      inst.ping = null;
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
    if (instances.get(app) === inst) instances.delete(app);
    ready.reject(new Error(`worker exited with code ${exitCode} before it listened${inst.error ? `: ${inst.error}` : ''}`));
    end(inst, 'exit', { code: exitCode, reason: inst.stopping ? 'stopped' : inst.error ?? undefined });
  });
  const timer = new AbortController();
  const timeout = sleep(Math.max(0, deadline - Date.now()), null, { signal: timer.signal }).catch(() => null);
  const port = await Promise.race([ready.promise, timeout]).finally(() => timer.abort());
  if (port === null) {
    await stop(inst, 0);
    throw new Error(`worker did not listen on ${RUNTIME_ENV.port} within ${request.readyMs} ms`);
  }
  record(inst, 'ready', { port });
  return { worker: inst.worker, port };
}

let tickedAt = performance.now();
setInterval(() => {
  const now = performance.now();
  // A runner that was itself paused gave no worker a chance to answer.
  const paused = now - tickedAt > 2 * PING_MS;
  tickedAt = now;
  for (const inst of instances.values()) {
    if (inst.ended || inst.stopping) continue;
    if (paused) inst.ping = null;
    if (!inst.ping) {
      inst.ping = { seq: ++pings, sentAt: now };
      inst.thread.postMessage({ type: 'ping', seq: inst.ping.seq });
    } else if (inst.port !== null && now - inst.ping.sentAt >= SILENCE_MS) {
      end(inst, 'hung', { reason: `no answer to the watchdog for ${SILENCE_MS} ms` });
      void terminate(inst);
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

function serial<T>(app: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(app) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(app, run);
  void run.catch(() => {}).finally(() => { if (queues.get(app) === run) queues.delete(app); });
  return run;
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
    return [...instances.values()].filter((i) => !i.ended && i.port !== null).map((i): Listed => ({ app: i.app, release: i.release, spec: i.spec, worker: i.worker, port: i.port!, since: i.since }));
  }
  if (method === 'POST' && resource === 'instances') {
    const app = segment(a);
    const parsed = await body(request);
    return serial(app, () => start(app, parsed)).catch((error: Error) => { throw new HttpError(502, error.message); });
  }
  if (method === 'DELETE' && resource === 'instances') {
    const app = segment(a);
    await serial(app, async () => {
      const inst = instances.get(app);
      const worker = url.searchParams.get('worker');
      if (inst && (worker === null || inst.worker === worker)) await stop(inst, Number(url.searchParams.get('drain') ?? 0));
      if (url.searchParams.get('retire') !== '1') return;
      logs.delete(app);
      for (const name of await readdir(appDir(app)).catch(() => [] as string[])) if (isRelease(name)) await rm(join(appDir(app), name), { recursive: true, force: true });
    });
    return null;
  }
  if (method === 'GET' && resource === 'events') {
    const raw = url.searchParams.get('after');
    const after = raw === 'latest' ? seq : Number(raw ?? 0);
    return { startedAt, seq, events: ring.filter((e) => e.seq > after) } satisfies EventPage;
  }
  if (method === 'DELETE' && resource === 'storage') {
    const app = segment(a);
    logs.delete(app);
    await rm(storageDir(app, segment(b)), { recursive: true, force: true });
    return null;
  }
  if (method === 'GET' && resource === 'logs') {
    const tail = Number(url.searchParams.get('tail') ?? 200);
    return (logs.get(segment(a))?.lines ?? []).slice(-tail).join('\n');
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

// A runner killed mid-extraction leaves its temporary directory behind.
for (const app of await readdir(join(DATA, 'apps')).catch(() => [] as string[])) {
  for (const name of await readdir(appDir(app))) if (name.startsWith('.tmp-')) await rm(join(appDir(app), name), { recursive: true, force: true });
}
server.listen(PORT, '0.0.0.0', () => log('runner-ready', { port: (server.address() as { port: number }).port, startedAt, data: DATA }));
