import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export type Identity = { readonly subject: string; readonly name: string; readonly owner: boolean };
export type Inbound = { readonly prefix: string; readonly identity: Identity | null; readonly url: URL };
export type Context = Inbound & { readonly req: IncomingMessage; readonly res: ServerResponse };
export type Handler = (ctx: Context) => unknown;

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

export function inbound(req: IncomingMessage): Inbound {
  const url = new URL(req.url ?? '/', 'http://app');
  const subject = header(req, 'x-pneuma-space-subject');
  const identity = subject
    ? { subject, name: header(req, 'x-pneuma-space-name') ?? subject, owner: header(req, 'x-pneuma-space-owner') === '1' }
    : null;
  return { prefix: '', identity, url };
}

export async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) throw new Error('body limit');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function serve(handler: Handler, options: { port?: number } = {}): Server {
  const server = http.createServer(async (req, res) => {
    const ctx: Context = { ...inbound(req), req, res };
    try {
      await handler(ctx);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });
  server.listen(options.port ?? Number(process.env.PNEUMA_SPACE_PORT ?? 8000), '0.0.0.0');
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
  return server;
}
