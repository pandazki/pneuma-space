import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream';

/** The Lease a relayed exchange runs under, as the proxy sees it. */
export type Hold = {
  /** Reclassifies the lease as a channel; `onRetire` ends the stream when the instance drains. */
  readonly channel: (onRetire: () => void) => void;
  /** Called exactly once, when the upstream exchange has ended and the response is finished or the client gone. */
  readonly release: () => void;
  /** A channel with no bytes for this long is closed. */
  readonly idleMs: number;
};

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * What a client's request passes on: its headers without hop-by-hop ones or those its Connection names. Ingress adds the platform's
 * headers after this, so nothing a client sends can name them out of the request (INV-5). An upgrade keeps `Connection: Upgrade` and `Upgrade`.
 */
export function fromClient(raw: readonly string[], upgrade: boolean): string[] {
  const out = endToEnd(raw);
  if (!upgrade) return out;
  const protocol = raw.findIndex((name, i) => i % 2 === 0 && name.toLowerCase() === 'upgrade');
  return [...out, 'Connection', 'Upgrade', 'Upgrade', raw[protocol + 1]];
}

/** Raw header list (`[name, value, ...]`) without hop-by-hop headers or those named in Connection. */
function endToEnd(raw: readonly string[]): string[] {
  const named = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'connection') for (const n of raw[i + 1].split(',')) named.add(n.trim().toLowerCase());
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (!HOP_BY_HOP.has(name) && !named.has(name)) out.push(raw[i], raw[i + 1]);
  }
  return out;
}

const DOMAIN_ATTRIBUTE = /;\s*domain\s*(=[^;]*)?(?=;|$)/gi;

/** An app's cookies stay on its own host: `Domain` goes from every `Set-Cookie` (ADR 0021 item 6). */
function hostOnly(raw: string[]): string[] {
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === 'set-cookie') raw[i + 1] = raw[i + 1].replace(DOMAIN_ATTRIBUTE, '');
  return raw;
}

/** The same for a raw response head, which the WebSocket path relays as bytes. */
function hostOnlyHead(head: Buffer): Buffer {
  const text = head.toString('latin1');
  const out = text.replace(/^set-cookie:[^\r\n]*/gim, (line) => line.replace(DOMAIN_ATTRIBUTE, ''));
  return out === text ? head : Buffer.from(out, 'latin1');
}

/** Resolves once TCP is up, so a failure here is known to precede the request line. */
export function connect(address: string): Promise<net.Socket> {
  const colon = address.lastIndexOf(':');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address.slice(0, colon), port: Number(address.slice(colon + 1)) });
    socket.once('connect', () => {
      socket.off('error', reject);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/** Path A, with `headers` already end to end. Streams both bodies with back-pressure; Node picks Content-Length or chunked framing on each leg. */
export function forward(
  req: http.IncomingMessage, res: http.ServerResponse, socket: net.Socket,
  path: string, headers: readonly string[], hold: Hold, failed: (reason: string) => void,
): void {
  let stream = false;
  const up = http.request({ createConnection: () => socket, method: req.method, path, headers: [...headers] }, (ur) => {
    if (res.destroyed) return void ur.resume();
    stream = String(ur.headers['content-type']).startsWith('text/event-stream');
    if (stream) {
      const end = () => { res.destroy(); up.destroy(); };
      hold.channel(end);
      res.setTimeout(hold.idleMs, end);
    }
    res.writeHead(ur.statusCode ?? 502, ur.statusMessage, hostOnly(endToEnd(ur.rawHeaders)));
    ur.pipe(res);
    ur.on('error', () => res.destroy());
  });
  let open = 2;
  const done = () => --open === 0 && hold.release();
  up.once('close', done);
  res.once('close', done);
  up.on('error', (error) => {
    failed(String(error));
    if (!res.headersSent && !res.destroyed) res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"the app closed the connection"}');
    else res.destroy();
  });
  pipeline(req, up, () => {});
  // A request lease lasts until the app finishes the response (DESIGN 1.4), so a vanished client only stops the copy; a channel ends with either side.
  res.on('close', () => {
    if (res.writableFinished) return;
    if (stream) return void up.destroy();
    const ur = up.res;
    if (ur) {
      ur.unpipe(res);
      ur.resume();
    }
  });
}

const CLOSE_GOING_AWAY = Buffer.from([0x88, 0x02, 0x03, 0xe9]);

/** Tracks WebSocket frame boundaries so a close frame is never written into the middle of another frame. */
class FrameCursor {
  #header: number[] = [];
  #payload = 0;

  get atBoundary(): boolean {
    return this.#header.length === 0 && this.#payload === 0;
  }

  /** Consumes `chunk`; with `stop`, returns the offset just past the first frame end instead of the chunk length. */
  advance(chunk: Buffer, stop: boolean): number {
    let i = 0;
    while (i < chunk.length) {
      if (this.#payload > 0) {
        const n = Math.min(this.#payload, chunk.length - i);
        this.#payload -= n;
        i += n;
      } else {
        this.#header.push(chunk[i++]);
        const h = this.#header;
        if (h.length < 2) continue;
        const len7 = h[1] & 0x7f;
        const size = 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + (h[1] & 0x80 ? 4 : 0);
        if (h.length < size) continue;
        const bytes = Buffer.from(h);
        this.#payload = len7 === 126 ? bytes.readUInt16BE(2) : len7 === 127 ? Number(bytes.readBigUInt64BE(2)) : len7;
        this.#header = [];
      }
      if (stop && this.atBoundary) return i;
    }
    return i;
  }
}

/**
 * Path B, with `headers` already end to end. Replays the upgrade request and relays raw bytes. An end is forwarded as a half-close;
 * only an error destroys the other side, because destroying on close drops bytes still buffered.
 */
export function tunnel(
  req: http.IncomingMessage, client: net.Socket, head: Buffer, up: net.Socket,
  path: string, headers: readonly string[], hold: Hold, answered: (status: number) => void,
): void {
  const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
  for (let i = 0; i < headers.length; i += 2) lines.push(`${headers[i]}: ${headers[i + 1]}`);
  up.write(lines.join('\r\n') + '\r\n\r\n');
  if (head.length) up.write(head);
  client.setNoDelay(true);

  let released = false;
  const release = () => {
    if (!released) hold.release();
    released = true;
  };
  up.once('close', release);
  client.once('close', release);
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());

  const frames = new FrameCursor();
  let responseHead: Buffer | null = Buffer.alloc(0);
  let closing = false;
  const goAway = () => {
    client.unpipe(up);
    client.resume();
    client.end(CLOSE_GOING_AWAY);
    up.destroy();
  };
  const close = () => {
    closing = true;
    if (frames.atBoundary) goAway();
  };
  const send = (chunk: Buffer) => {
    if (chunk.length && !client.write(chunk)) up.pause();
  };
  client.on('drain', () => up.resume());

  up.on('data', (chunk: Buffer) => {
    if (responseHead) {
      const buffered = Buffer.concat([responseHead, chunk]);
      const headEnd = buffered.indexOf('\r\n\r\n');
      if (headEnd < 0) return void (responseHead = buffered);
      responseHead = null;
      const head = hostOnlyHead(buffered.subarray(0, headEnd + 4));
      const all = Buffer.concat([head, buffered.subarray(headEnd + 4)]);
      const end = head.length - 4;
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(all.toString('latin1', 0, all.indexOf('\r\n')))?.[1] ?? 0);
      answered(status);
      if (status !== 101) return send(all);
      send(all.subarray(0, end + 4));
      hold.channel(close);
      client.setTimeout(hold.idleMs, () => (frames.atBoundary ? goAway() : client.destroy()));
      chunk = all.subarray(end + 4);
    }
    if (!closing) {
      frames.advance(chunk, false);
      return send(chunk);
    }
    send(chunk.subarray(0, frames.advance(chunk, true)));
    if (frames.atBoundary) goAway();
  });
  up.on('end', () => client.end());
  client.pipe(up);
}
