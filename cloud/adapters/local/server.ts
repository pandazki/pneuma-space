import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LIMITS } from '../../core/model.ts';
import type { CloudConfig } from '../../core/config.ts';
import { createRouter } from '../../http/router.ts';
import { errorResponse } from '../../http/security.ts';
import { LocalBackend } from './backend.ts';
import { developmentIdentity, developmentLogin } from './development-login.ts';

export async function startLocalServer(options: { directory: string; port: number; consoleHtml?: string }): Promise<{ server: Server; backend: LocalBackend; config: CloudConfig; close(): Promise<void> }> {
  const config: CloudConfig = { controlOrigin: `http://localhost:${options.port}`, appsDomain: `apps.localhost:${options.port}`, secureCookies: false, limits: DEFAULT_LIMITS, enabled: true };
  const backend = new LocalBackend(options.directory, config);
  const consoleHtml = options.consoleHtml ?? await readFile(new URL('../../http/console.html', import.meta.url), 'utf8');
  const route = createRouter({ config, backend, consoleHtml, identity: developmentIdentity(config.controlOrigin) });
  const development = developmentLogin(backend, config);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const method = incoming.method ?? 'GET';
      const init: RequestInit & { duplex: 'half' } = { method, headers: incoming.headers as Record<string, string>, duplex: 'half' };
      if (method !== 'GET' && method !== 'HEAD') init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`, init);
      const response = await development(request) ?? await route(request);
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
      if (response.headers.getSetCookie().length) outgoing.setHeader('set-cookie', response.headers.getSetCookie());
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const response = errorResponse(error);
      outgoing.writeHead(response.status, { 'content-type': 'application/json' });
      outgoing.end(await response.text());
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolveStarted, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolveStarted); });
  const address = server.address();
  if (address && typeof address === 'object') {
    config.controlOrigin = `http://localhost:${address.port}`;
    config.appsDomain = `apps.localhost:${address.port}`;
  }
  return { server, backend, config, close: async () => { await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed())); backend.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PNEUMA_SPACE_LOCAL_PORT ?? 8787);
  const app = await startLocalServer({ port, directory: process.env.PNEUMA_SPACE_LOCAL_DATA ?? resolve(import.meta.dirname, '../../.data') });
  process.stdout.write(`PneumaSpace local console: ${app.config.controlOrigin}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
