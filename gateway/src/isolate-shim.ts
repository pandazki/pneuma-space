// The main script of every isolate worker: it stands where a --import preload would, since a worker's execArgv ignores --import.
import dc from 'node:diagnostics_channel';
import type { AddressInfo, Server } from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';

const port = parentPort!;

// From a worker, process.kill(process.pid) ends the whole runner (spike S4).
for (const name of ['kill', 'abort', '_kill']) Object.defineProperty(process, name, { value: undefined });

let listening = false;
dc.tracingChannel('net.server.listen').subscribe({
  asyncEnd(message) {
    if (listening) return;
    listening = true;
    port.postMessage({ type: 'listening', port: ((message as { server: Server }).server.address() as AddressInfo).port });
  },
});

port.on('message', (message: { type: 'ping'; seq: number } | { type: 'drain' }) => {
  if (message.type === 'ping') port.postMessage({ type: 'pong', seq: message.seq, external: process.memoryUsage().external });
  // Signals never reach a worker, so the app's SIGTERM handler is the one shutdown path in both runtimes.
  else process.emit('SIGTERM');
});
port.unref();

await import(workerData.entry);
