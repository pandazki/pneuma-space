import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream';
import type { Duplex } from 'node:stream';

export type Target = { host: string; port: number };

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function endToEnd(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  const named = String(headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim());
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && !HOP_BY_HOP.has(k) && !named.includes(k)) out[k] = v;
  }
  return out;
}

// Path A. Framing (Content-Length vs chunked) is left to Node on each leg; pipeline gives back-pressure and tears both sides down on error.
export function forward(req: http.IncomingMessage, res: http.ServerResponse, target: Target): void {
  const up = http.request({ ...target, method: req.method, path: req.url, headers: endToEnd(req.headers) }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, endToEnd(ur.headers));
    pipeline(ur, res, () => {});
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502).end();
    else res.destroy();
  });
  pipeline(req, up, () => {});
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
}

// Path B. Replays the upgrade request verbatim and relays raw bytes. An end is forwarded as a half-close; an error destroys both sides.
export function tunnel(req: http.IncomingMessage, client: Duplex, head: Buffer, target: Target): void {
  const up = net.connect(target, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  up.setNoDelay(true);
  if (client instanceof net.Socket) client.setNoDelay(true);
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
}

export function createRelay(target: Target): http.Server {
  return http.createServer((req, res) => forward(req, res, target))
    .on('upgrade', (req, socket, head) => tunnel(req, socket, head, target));
}
