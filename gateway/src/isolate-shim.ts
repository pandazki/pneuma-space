// The main script of every isolate worker: it stands where a --import preload would, since a worker's execArgv ignores --import.
import dc from 'node:diagnostics_channel';
import module, { syncBuiltinESMExports } from 'node:module';
import { createServer, type AddressInfo, type ListenOptions, type Server } from 'node:net';
import v8 from 'node:v8';
import threads, { parentPort, workerData } from 'node:worker_threads';

const port = parentPort!;
// Messages the app could post on it would reach the runner's main thread unbudgeted, and could forge listening or pong.
threads.parentPort = null;
const memoryUsage = process.memoryUsage.bind(process);

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

function refill(): string[] {
  const now = performance.now();
  if (now - budget.at < 1000) return [];
  const lines = budget.dropped ? [`dropped ${budget.dropped} lines`] : [];
  Object.assign(budget, { at: now, spent: 0, dropped: 0 });
  return lines;
}

function logged(bytes: Buffer): void {
  const lines = refill();
  // A loop over bytes, not indexOf per line: 64 MiB of newlines takes about 50 ms here instead of a second.
  for (let start = 0, i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 10) continue;
    if (i === bytes.length && start === i) break;
    const length = Math.min(i - start, LINE_BYTES);
    if (budget.spent + length + LINE_COST <= LOG_BUDGET) {
      budget.spent += length + LINE_COST;
      lines.push(bytes.toString('utf8', start, start + length));
    } else budget.dropped++;
    start = i + 1;
  }
  if (lines.length) port.postMessage({ type: 'log', lines });
  if (budget.dropped && !budget.notice) {
    budget.notice = true;
    setTimeout(() => {
      budget.notice = false;
      const notice = refill();
      if (notice.length) port.postMessage({ type: 'log', lines: notice });
    }, budget.at + 1000 - performance.now()).unref();
  }
}

for (const stream of [process.stdout, process.stderr]) {
  stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    logged(typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) process.nextTick(done);
    return true;
  }) as typeof stream.write;
}

port.on('message', (message: { type: 'ping'; seq: number } | { type: 'drain' }) => {
  if (message.type === 'ping') port.postMessage({ type: 'pong', seq: message.seq, external: memoryUsage().external });
  // Signals never reach a worker, so the app's SIGTERM handler is the one shutdown path in both runtimes.
  else process.emit('SIGTERM');
});
port.unref();

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
    port.postMessage({ type: 'listening', port: appPort });
  },
});

await import(workerData.entry);
