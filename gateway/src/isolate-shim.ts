// The main script of every isolate worker: it stands where a --import preload would, since a worker's execArgv ignores --import.
import dc from 'node:diagnostics_channel';
import { syncBuiltinESMExports } from 'node:module';
import type { ListenOptions, Server } from 'node:net';
import threads, { parentPort, workerData } from 'node:worker_threads';

const port = parentPort!;
const memoryUsage = process.memoryUsage.bind(process);
const appPort = Number(process.env.PNEUMA_SPACE_PORT);

// From a worker, process.kill(process.pid) ends the whole runner (spike S4).
for (const name of ['kill', 'abort', '_kill']) Object.defineProperty(process, name, { value: undefined });

// A nested worker gets a fresh process with kill intact and runs outside the watchdog and resourceLimits.
threads.Worker = class {
  constructor() {
    throw Object.assign(new Error('isolate apps cannot start worker threads, as they cannot start child processes'), { code: 'ERR_ACCESS_DENIED' });
  }
} as unknown as typeof threads.Worker;
syncBuiltinESMExports();

const asked = new WeakSet<Server>();
let listening = false;
dc.tracingChannel('net.server.listen').subscribe({
  asyncStart(message) {
    const { server, options } = message as { server: Server; options: ListenOptions };
    if (options.path === undefined && options.port !== undefined && Number(options.port) === appPort) asked.add(server);
  },
  asyncEnd(message) {
    const { server } = message as { server: Server };
    if (listening || !asked.has(server)) return;
    listening = true;
    port.postMessage({ type: 'listening', port: (server.address() as { port: number }).port });
  },
});

port.on('message', (message: { type: 'ping'; seq: number } | { type: 'drain' }) => {
  if (message.type === 'ping') port.postMessage({ type: 'pong', seq: message.seq, external: memoryUsage().external });
  // Signals never reach a worker, so the app's SIGTERM handler is the one shutdown path in both runtimes.
  else process.emit('SIGTERM');
});
port.unref();

await import(workerData.entry);
