import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export type Identity = { readonly subject: string; readonly name: string; readonly owner: boolean };
export type Inbound = { readonly prefix: string; readonly identity: Identity | null; readonly url: URL };
export type Context = Inbound & { readonly req: IncomingMessage; readonly res: ServerResponse };
export type Handler = (ctx: Context) => unknown;
export type Delivery = {
  readonly id: string;
  readonly attempt: number;
  readonly scheduledFor: string | null;
  readonly subject: string | null;
  readonly body: Buffer;
};
export type Triggers = Readonly<Record<string, (delivery: Delivery) => unknown>>;

const TRIGGER = /^\/_pneuma\/trigger\/([^/]+)$/;

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

export function inbound(req: IncomingMessage): Inbound {
  const prefix = (header(req, 'x-forwarded-prefix') ?? '').replace(/\/+$/, '');
  const url = new URL(req.url ?? '/', 'http://app');
  // The gateway already strips the prefix; this keeps a dev run that sends the full path working the same.
  if (prefix && (url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) {
    url.pathname = url.pathname.slice(prefix.length) || '/';
  }
  const subject = header(req, 'x-pneuma-subject');
  const identity = subject
    ? { subject, name: header(req, 'x-pneuma-name') ?? subject, owner: header(req, 'x-pneuma-owner') === '1' }
    : null;
  return { prefix, identity, url };
}

export async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function trigger(ctx: Context, name: string, triggers: Triggers): Promise<void> {
  const run = Object.hasOwn(triggers, name) ? triggers[name] : undefined;
  if (!run) return void ctx.res.writeHead(404).end(`no trigger "${name}"`);
  if (ctx.req.method !== 'POST') return void ctx.res.writeHead(405, { allow: 'POST' }).end();
  await run({
    id: header(ctx.req, 'x-pneuma-delivery') ?? '',
    attempt: Number(header(ctx.req, 'x-pneuma-attempt') ?? 1),
    scheduledFor: header(ctx.req, 'x-pneuma-scheduled-for'),
    subject: header(ctx.req, 'x-pneuma-subject'),
    body: await body(ctx.req),
  });
  ctx.res.writeHead(204).end();
}

export function serve(handler: Handler, options: { triggers?: Triggers; port?: number } = {}): Server {
  const server = http.createServer(async (req, res) => {
    const ctx: Context = { ...inbound(req), req, res };
    try {
      const name = TRIGGER.exec(ctx.url.pathname)?.[1];
      await (name === undefined ? handler(ctx) : trigger(ctx, decodeURIComponent(name), options.triggers ?? {}));
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });
  server.listen(options.port ?? 8000, '0.0.0.0');
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
  return server;
}
