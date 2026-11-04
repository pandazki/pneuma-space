import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream';

/** The Lease a relayed exchange runs under, as the proxy sees it. */
export type Hold = {
  /** Reclassifies the lease as a channel; `onRetire` ends the stream when the instance drains. */
  readonly channel: (onRetire: () => void) => void;
  /** Called exactly once, when the upstream exchange has ended. */
  readonly release: () => void;
  /** A channel with no bytes for this long is closed. */
  readonly idleMs: number;
};

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

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

/** Path A. Streams both bodies with back-pressure; Node picks Content-Length or chunked framing on each leg. */
export function forward(
  req: http.IncomingMessage, res: http.ServerResponse, socket: net.Socket,
  path: string, headers: readonly string[], hold: Hold,
): void {
  let stream = false;
  const up = http.request({ createConnection: () => socket, method: req.method, path, headers: endToEnd(headers) }, (ur) => {
    if (res.destroyed) return void ur.resume();
    stream = String(ur.headers['content-type']).startsWith('text/event-stream');
    if (stream) {
      const end = () => { res.destroy(); up.destroy(); };
      hold.channel(end);
      res.setTimeout(hold.idleMs, end);
    }
    res.writeHead(ur.statusCode ?? 502, ur.statusMessage, endToEnd(ur.rawHeaders));
    ur.pipe(res);
    ur.on('error', () => res.destroy());
  });
  up.once('close', hold.release);
  up.on('error', () => {
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
 * Path B. Replays the upgrade request and relays raw bytes. An end is forwarded as a half-close; only an error destroys
 * the other side, because destroying on close drops bytes still buffered.
 */
export function tunnel(
  req: http.IncomingMessage, client: net.Socket, head: Buffer, up: net.Socket,
  path: string, headers: readonly string[], hold: Hold,
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
      const all = Buffer.concat([responseHead, chunk]);
      const end = all.indexOf('\r\n\r\n');
      if (end < 0) return void (responseHead = all);
      responseHead = null;
      if (!/^HTTP\/1\.[01] 101/.test(all.toString('latin1', 0, 12))) return send(all);
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
