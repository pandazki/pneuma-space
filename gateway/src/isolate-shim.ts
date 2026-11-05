// The main script of every isolate worker: it stands where a --import preload would, since a worker's execArgv ignores --import.
import dc from 'node:diagnostics_channel';
import module, { syncBuiltinESMExports } from 'node:module';
import { createServer, type AddressInfo, type ListenOptions, type Server } from 'node:net';
import { Readable, Writable } from 'node:stream';
import v8 from 'node:v8';
import threads, { parentPort, workerData } from 'node:worker_threads';
import type { WorkerMessage } from './runner.ts';

const memoryUsage = process.memoryUsage.bind(process);
const port = parentPort!;
// Node dispatches every incoming message through `this[kHybridDispatch]`, so an app that patched EventTarget.prototype, or MessagePort's, would be handed this port.
const chain: object[] = [];
for (let proto = Object.getPrototypeOf(port); proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) chain.push(proto);
Object.setPrototypeOf(port, chain.reduceRight((parent, proto) => Object.create(parent, Object.getOwnPropertyDescriptors(proto)), Object.prototype));
const post: (message: WorkerMessage) => void = port.postMessage.bind(port);
port.on('message', (message: { type: 'ping'; seq: number } | { type: 'drain' }) => {
  if (message.type === 'ping') post({ type: 'pong', seq: message.seq, external: memoryUsage().external });
  // Signals never reach a worker, so the app's SIGTERM handler is the one shutdown path in both runtimes.
  else process.emit('SIGTERM');
});
port.unref();
threads.parentPort = null;

// From a worker, process.kill(process.pid) ends the whole runner (spike S4).
for (const name of ['kill', 'abort', '_kill']) Object.defineProperty(process, name, { value: undefined });

const denied = (message: string) => Object.assign(new Error(message), { code: 'ERR_ACCESS_DENIED' });
// A nested worker, and the thread module.register runs hooks on, get a fresh process with kill intact and run outside the watchdog and resourceLimits.
threads.Worker = class {
  constructor() {
    throw denied('isolate apps cannot start worker threads, as they cannot start child processes');
  }
} as unknown as typeof threads.Worker;
module.register = () => {
  throw denied('isolate apps cannot register off-thread module hooks; module.registerHooks runs in the app thread');
};
// V8 flags are process-wide: --allow-natives-syntax lets %AbortJS end the whole runner.
v8.setFlagsFromString = () => {
  throw denied('isolate apps cannot set V8 flags, which apply to every app in the runner');
};
syncBuiltinESMExports();

const LINE_BYTES = 4 * 2 ** 10;
/** Log bytes per second a worker may send the runner, whose main thread every worker shares; each line also costs LINE_COST, so empty lines are budgeted too. */
const LOG_BUDGET = 64 * 2 ** 10;
const LINE_COST = 64;
const budget = { at: performance.now(), spent: 0, dropped: 0, notice: false };
const EMPTY = Buffer.alloc(0);
/** The start of a line whose newline is not written yet, already cut to LINE_BYTES. */
let held = EMPTY;

function refill(): void {
  const now = performance.now();
  if (now - budget.at < 1000) return;
  if (budget.dropped) post({ type: 'dropped', count: budget.dropped });
  Object.assign(budget, { at: now, spent: 0, dropped: 0 });
}

function logged(bytes: Buffer): void {
  refill();
  const lines: string[] = [];
  // A loop over bytes, not indexOf per line: 64 MiB of newlines takes about 50 ms here instead of a second.
  for (let start = 0, i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 10) continue;
    const end = Math.min(i, start + LINE_BYTES - held.length);
    if (i === bytes.length) {
      if (end > start) held = Buffer.concat([held, bytes.subarray(start, end)]);
      break;
    }
    const length = held.length + end - start;
    if (budget.spent + length + LINE_COST <= LOG_BUDGET) {
      budget.spent += length + LINE_COST;
      lines.push(held.length ? Buffer.concat([held, bytes.subarray(start, end)]).toString('utf8') : bytes.toString('utf8', start, end));
    } else budget.dropped++;
    held = EMPTY;
    start = i + 1;
  }
  if (lines.length) post({ type: 'log', lines });
  if (budget.dropped) noticeLater();
}

/** The drop count is sent when the budget refills, even if the app writes nothing more. */
function noticeLater(): void {
  if (budget.notice) return;
  budget.notice = true;
  setTimeout(() => {
    budget.notice = false;
    refill();
    if (budget.dropped) noticeLater();
  }, Math.max(0, budget.at + 1000 - performance.now())).unref();
}

// Node's own stdio streams each hold an internal port whose unknown messages fail an assertion on the runner's main thread.
// Node's worker bootstrap calls this on process.stdout and process.stderr, by name, whenever the runner reads their native stream.
const wantsMore = Object.getOwnPropertySymbols(Object.getPrototypeOf(process.stdout)).find((key) => key.description === 'kStdioWantsMoreDataCallback')!;
const sink = () => Object.assign(new Writable({ write(chunk: Buffer, _encoding, done) { logged(chunk); done(); } }), { [wantsMore]: () => {} });
const [stdout, stderr] = [sink(), sink()];
const stdin = new Readable({ read() { this.push(null); } });
for (const [name, value] of Object.entries({ stdout, stderr, stdin })) Object.defineProperty(process, name, { value, enumerable: true });
// The global console keeps the streams it first wrote to.
Object.assign(console, { _stdout: stdout, _stderr: stderr });

// A port fixed before the app runs tells its server from any other it listens with.
const appPort = await new Promise<number>((resolve, reject) => {
  const probe = createServer().once('error', reject).listen(0, () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
});
process.env.PNEUMA_SPACE_PORT = String(appPort);

const asked = new WeakSet<Server>();
let listening = false;
dc.tracingChannel('net.server.listen').subscribe({
  asyncStart(message) {
    const { server, options } = message as { server: Server; options: ListenOptions };
    if (options.path === undefined && Number(options.port) === appPort) asked.add(server);
  },
  asyncEnd(message) {
    const { server } = message as { server: Server };
    if (listening || !asked.has(server)) return;
    listening = true;
    post({ type: 'listening', port: appPort });
  },
});

await import(workerData.entry);
