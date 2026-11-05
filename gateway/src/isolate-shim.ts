// The main script of every isolate worker: it stands where a --import preload would, since a worker's execArgv ignores --import.
import dc from 'node:diagnostics_channel';
import module, { syncBuiltinESMExports } from 'node:module';
import { createServer, type AddressInfo, type ListenOptions, type Server } from 'node:net';
import threads, { parentPort, workerData } from 'node:worker_threads';

const port = parentPort!;
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
syncBuiltinESMExports();

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
