// The isolate runner (ADR 0017): one worker_threads Worker per awake app, a watchdog, and a JSON control API on the platform network.
// It judges nothing: hangs, exits and memory overruns are reported as events and the gateway's Guard decides.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from 'node:net';
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
  /** The app's `memory_mb`: its heap and its off-heap budget, each capped by this runner (ADR 0023 item 1). */
  readonly heapMb: number;
  readonly readyMs: number;
};
/** `heapMb` and `offheapMb` are what the worker runs with, below the asked value when a cap applied. */
export type Started = { readonly worker: string; readonly port: number; readonly heapMb: number; readonly offheapMb: number };
/** `starting` has not listened yet and has no port; `ending` is stopping or ended and its thread not yet gone. */
export type Listed = {
  readonly app: string; readonly release: number; readonly spec: string; readonly worker: string;
  readonly state: 'starting' | 'listening' | 'ending'; readonly port: number | null; readonly since: number;
};
export type RunnerEvent = {
  readonly seq: number; readonly t: number; readonly ev: 'ready' | 'exit' | 'hung' | 'oom' | 'forged';
  readonly app: string; readonly release: number; readonly worker: string; readonly code?: number; readonly reason?: string; readonly port?: number;
};
/** What a worker's shim posts on its port; the app runs in the same thread, so the runner checks every message's shape. */
export type WorkerMessage =
  | { readonly type: 'pong'; readonly seq: number; readonly external: number }
  | { readonly type: 'listening'; readonly port: number }
  | { readonly type: 'log'; readonly stream: 'stdout' | 'stderr'; readonly lines: readonly string[] }
  | { readonly type: 'dropped'; readonly count: number };
/** `seq` is the newest event's; `after=latest` answers it with no events, for a cursor that starts now. */
export type EventPage = { readonly startedAt: number; readonly seq: number; readonly events: readonly RunnerEvent[] };

const env = process.env;
const DATA = env.PNEUMA_SPACE_DATA ?? '/data';
const PORT = Number(env.PNEUMA_SPACE_RUNNER_PORT ?? RUNNER_PORT);
const HEAP_CAP_MB = Number(env.PNEUMA_SPACE_RUNNER_WORKER_HEAP_MB ?? 256);
const OFFHEAP_CAP_MB = Number(env.PNEUMA_SPACE_RUNNER_WORKER_OFFHEAP_MB ?? 256);
const STUCK_LIMIT = Number(env.PNEUMA_SPACE_RUNNER_STUCK_LIMIT ?? 3);
/** Worker ports; the runner's NetworkPolicy opens this range (ADR 0019 item 10). */
const [PORT_LOW, PORT_HIGH] = (env.PNEUMA_SPACE_RUNNER_PORT_RANGE ?? '32768-60999').split('-').map(Number);
/** A freed port waits this long, so a client of an ended worker does not reach the next worker on it (ADR 0019 item 8). */
const PORT_COOLDOWN_MS = 30_000;
const PING_MS = 1000;
const SILENCE_MS = 3000;
const TERMINATE_MS = 5000;
// Inside compose's 10 s stop grace, with room for a terminate.
const SHUTDOWN_DRAIN_MS = 3000;
const EVENT_RING = 1000;
const LOG_BYTES = 256 * 2 ** 10;
const LOG_LINES = 1000;
/** Counted per line on top of its bytes, so empty lines are bounded too. */
const LINE_OVERHEAD = 64;
/** The shim cuts a line at 4 KiB of UTF-8, which decodes to at most as many UTF-16 units. */
const LINE_UNITS = 4 * 2 ** 10;
const FORGED_LIMIT = 3;
const SHIM = new URL('./isolate-shim.ts', import.meta.url);
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,80}$/;

type Instance = {
  readonly app: string;
  readonly release: number;
  readonly spec: string;
  readonly worker: string;
  readonly thread: Worker;
  readonly since: number;
  /** Allocated by the runner, so a forged `listening` cannot name another app's port. */
  readonly port: number;
  readonly heapMb: number;
  readonly offheapMb: number;
  listening: boolean;
  ping: { readonly seq: number; deadline: number } | null;
  /** Set by the first terminal event; later ones for this worker are dropped. The instance stays in the map until its thread is gone. */
  ended: boolean;
  stopping: boolean;
  error: string | null;
  oom: boolean;
  forged: number;
  readonly exited: Promise<void>;
  terminating: Promise<void> | null;
};

const startedAt = Date.now();
const instances = new Map<string, Instance>();
const ring: RunnerEvent[] = [];
const logs = new Map<string, { readonly lines: string[]; bytes: number }>();
/** One start or stop at a time per app, so a retried start joins the one in flight instead of racing its rename. */
const queues = new Map<string, Promise<unknown>>();
/** Ports a worker holds from allocation until its thread exits, and when each freed port was released. */
const held = new Set<number>();
const freed = new Map<number, number>();
/** A random start, so a restarted runner, whose cooldowns are gone, does not hand out the ports its predecessor just freed. */
let nextPort = PORT_LOW + Math.floor(Math.random() * (PORT_HIGH - PORT_LOW + 1));
let seq = 0;
let workers = 0;
let pings = 0;
let stuck = 0;
let forged = 0;
let internal = 0;

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

/** Lines come from the shim, already cut at 4 KiB and held to its per-second budget. */
function append(app: string, line: string): void {
  let log = logs.get(app);
  if (!log) logs.set(app, (log = { lines: [], bytes: 0 }));
  log.lines.push(line);
  log.bytes += Buffer.byteLength(line) + LINE_OVERHEAD;
  while (log.bytes > LOG_BYTES || log.lines.length > LOG_LINES) log.bytes -= Buffer.byteLength(log.lines.shift()!) + LINE_OVERHEAD;
}

/** Output that went around the shim's process.stdout.write is counted, never split, so a 64 MiB chunk costs the main thread one message. */
function dropNative(app: string, stream: NodeJS.ReadableStream): void {
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => { bytes += chunk.length; });
  stream.once('end', () => { if (bytes) append(app, `dropped ${bytes} bytes written around the log capture`); });
}

const appDir = (app: string) => join(DATA, 'apps', app);
const storageDir = (app: string, id: string) => join(appDir(app), 'storage', id);
const isRelease = (name: string) => /^\d+$/.test(name);

/** By index, since `every` skips holes and `for…of` yields them as undefined. */
function strings(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  for (let i = 0; i < raw.length; i++) if (typeof raw[i] !== 'string' || raw[i].length > LINE_UNITS) return false;
  return true;
}

function parse(raw: unknown): WorkerMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const valid =
    m.type === 'pong' ? typeof m.seq === 'number' && typeof m.external === 'number'
    : m.type === 'listening' ? Number.isInteger(m.port)
    : m.type === 'log' ? (m.stream === 'stdout' || m.stream === 'stderr') && strings(m.lines)
    : m.type === 'dropped' ? Number.isInteger(m.count)
    : false;
  return valid ? (m as WorkerMessage) : null;
}

/** A message the shim would not send came from app code that reached the port; a worker that keeps sending them is ended. */
function reject(inst: Instance): void {
  forged++;
  record(inst, 'forged');
  if (++inst.forged < FORGED_LIMIT) return;
  end(inst, 'exit', { reason: 'forged' });
  void terminate(inst);
}

/** The wildcard bind the worker makes, and loopback, where a listener bound to 127.0.0.1 alone would take the worker's local connections. */
async function bindable(port: number): Promise<boolean> {
  for (const host of [undefined, '127.0.0.1']) {
    const probe = new Server();
    if (!(await new Promise<boolean>((ok) => probe.once('error', () => ok(false)).listen(port, host, () => ok(true))))) return false;
    await new Promise((ok) => probe.close(ok));
  }
  return true;
}

/** Round-robin over the range, skipping held, cooling and otherwise bound ports; the worker binds the port itself. */
async function allocate(): Promise<number> {
  for (let tried = 0; tried <= PORT_HIGH - PORT_LOW; tried++) {
    const port = nextPort;
    nextPort = port >= PORT_HIGH ? PORT_LOW : port + 1;
    if (held.has(port) || Date.now() - (freed.get(port) ?? -Infinity) < PORT_COOLDOWN_MS) continue;
    held.add(port);
    if (await bindable(port)) return port;
    held.delete(port);
  }
  throw new HttpError(503, `no worker port in ${PORT_LOW}-${PORT_HIGH} is free and out of its ${PORT_COOLDOWN_MS} ms cooldown`);
}

function release(port: number): void {
  held.delete(port);
  freed.set(port, Date.now());
}

/** An uncaught value from the app, or a forged one; it may be anything, `undefined` included. */
function describe(error: unknown): string {
  try {
    return String((error as Error | undefined)?.stack ?? error);
  } catch {
    return 'an error that cannot be printed';
  }
}

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
  if (current && !current.ended && current.listening && current.release === request.release && current.spec === request.spec) return started(current);
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
  const port = await allocate();
  const heapMb = Math.min(request.heapMb, HEAP_CAP_MB);
  const offheapMb = Math.min(request.heapMb, OFFHEAP_CAP_MB);
  let thread: Worker;
  try {
    // No execArgv: any value replaces the inherited --permission, and with it the bans on child_process and addons.
    thread = new Worker(SHIM, {
      workerData: { entry: pathToFileURL(join(dir, request.entry)).href, port },
      env: { ...request.env, ...storage },
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.max(8, Math.round(heapMb / 8)) },
      stdout: true,
      stderr: true,
    });
  } catch (error) {
    release(port);
    throw error;
  }
  const exited = Promise.withResolvers<void>();
  const inst: Instance = {
    app, release: request.release, spec: request.spec, worker: `${startedAt}:${++workers}`, thread, since: Date.now(),
    port, heapMb, offheapMb, listening: false, ping: null, ended: false, stopping: false, error: null, oom: false, forged: 0, exited: exited.promise, terminating: null,
  };
  instances.set(app, inst);
  dropNative(app, thread.stdout);
  dropNative(app, thread.stderr);
  const ready = Promise.withResolvers<true>();
  thread.on('message', (raw: unknown) => {
    if (inst.ended) return;
    const message = parse(raw);
    if (message === null || (message.type === 'listening' && (inst.listening || message.port !== port))) return reject(inst);
    if (message.type === 'log') {
      for (const line of message.lines) {
        append(app, line);
        process.stdout.write(`${JSON.stringify({ t: Date.now(), app, release: inst.release, stream: message.stream, line })}\n`);
      }
    }
    else if (message.type === 'dropped') append(app, `dropped ${message.count} lines`);
    else if (message.type === 'listening') {
      inst.listening = true;
      // The hang clock starts here: a ping unanswered during startup belongs to the ready timeout.
      inst.ping = null;
      ready.resolve(true);
    } else if (inst.ping?.seq === message.seq) {
      inst.ping = null;
      if (message.external > inst.offheapMb * 2 ** 20 && !inst.ended) {
        end(inst, 'oom', { reason: 'offheap' });
        void terminate(inst);
      }
    }
  });
  // The message behind this event can be forged on Node's internal port, so it only ever ends the worker; the watchdog runs until the real exit.
  thread.on('error', (error: unknown) => {
    void terminate(inst);
    if ((error as { code?: unknown } | undefined)?.code === 'ERR_WORKER_OUT_OF_MEMORY') inst.oom = true;
    else inst.error = describe(error);
  });
  thread.on('exit', (exitCode) => {
    exited.resolve();
    release(port);
    if (instances.get(app) === inst) instances.delete(app);
    ready.reject(new Error(`worker exited with code ${exitCode} before it listened${inst.error ? `: ${inst.error}` : ''}`));
    if (inst.oom) end(inst, 'oom', { reason: 'heap' });
    else end(inst, 'exit', { code: exitCode, reason: inst.stopping ? 'stopped' : inst.error ?? undefined });
  });
  const timer = new AbortController();
  const timeout = sleep(Math.max(0, deadline - Date.now()), null, { signal: timer.signal }).catch(() => null);
  if ((await Promise.race([ready.promise, timeout]).finally(() => timer.abort())) === null) {
    await stop(inst, 0);
    throw new Error(`worker did not listen on ${RUNTIME_ENV.port} within ${request.readyMs} ms`);
  }
  record(inst, 'ready', { port });
  return started(inst);
}

const started = (inst: Instance): Started => ({ worker: inst.worker, port: inst.port, heapMb: inst.heapMb, offheapMb: inst.offheapMb });

let tickedAt = performance.now();
setInterval(() => {
  const now = performance.now();
  // A late tick means this thread was busy or paused and read no pong meanwhile; the delay is not the worker's silence.
  const late = Math.max(0, now - tickedAt - PING_MS);
  tickedAt = now;
  for (const inst of instances.values()) {
    if (inst.ended || inst.stopping) continue;
    if (!inst.ping) {
      inst.ping = { seq: ++pings, deadline: now + SILENCE_MS };
      inst.thread.postMessage({ type: 'ping', seq: inst.ping.seq });
      continue;
    }
    inst.ping.deadline += late;
    if (inst.listening && now >= inst.ping.deadline) {
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
  if (method === 'GET' && resource === 'health') return { ok: true, startedAt, stuck, forged, internal, workers: instances.size };
  if (method === 'GET' && resource === 'instances' && !a) {
    return [...instances.values()].map((i): Listed => ({
      app: i.app, release: i.release, spec: i.spec, worker: i.worker, port: i.listening ? i.port : null, since: i.since,
      state: i.ended || i.stopping ? 'ending' : i.listening ? 'listening' : 'starting',
    }));
  }
  if (method === 'POST' && resource === 'instances') {
    const app = segment(a);
    const parsed = await body(request);
    return serial(app, () => start(app, parsed)).catch((error: Error) => { throw error instanceof HttpError ? error : new HttpError(502, error.message); });
  }
  if (method === 'DELETE' && resource === 'instances') {
    const app = segment(a);
    await serial(app, async () => {
      const inst = instances.get(app);
      const worker = url.searchParams.get('worker');
      // A stop naming an earlier worker leaves the current one, its code and its log alone (ADR 0027 item 2).
      if (inst && worker !== null && inst.worker !== worker) return;
      if (inst) await stop(inst, Number(url.searchParams.get('drain') ?? 0));
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

// No message, and no fault in Node's own handling of one, may take every app down with the runner.
const fault = (error: unknown) => {
  internal++;
  log('runner-internal', { message: String((error as Error)?.message ?? error), stack: String((error as Error)?.stack ?? '').split('\n').slice(0, 5).join('\n') });
};
process.on('uncaughtException', fault);
process.on('unhandledRejection', fault);

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
