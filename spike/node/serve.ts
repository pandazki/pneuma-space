import http from 'node:http';
import { once } from 'node:events';
import { createRelay } from './relay.ts';

const [role, port, upstreamPort] = process.argv.slice(2);
const CHUNK = Buffer.alloc(64 * 1024, 0x61);
const SMALL = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));

function upstream(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/big') {
      let left = Number(url.searchParams.get('bytes'));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      while (left > 0) {
        const n = Math.min(left, CHUNK.length);
        left -= n;
        if (!res.write(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n))) await once(res, 'drain');
      }
      res.end();
    } else if (url.pathname === '/small') {
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (!m) return void res.writeHead(200, { 'content-length': SMALL.length, 'accept-ranges': 'bytes' }).end(SMALL);
      const [a, b] = [Number(m[1]), Number(m[2])];
      res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${SMALL.length}`, 'content-length': b - a + 1 }).end(SMALL.subarray(a, b + 1));
    } else if (url.pathname === '/sink') {
      let n = 0;
      for await (const c of req) n += c.length;
      res.writeHead(200, { 'content-type': 'text/plain' }).end(String(n));
    } else res.writeHead(404).end();
  }).on('upgrade', (_req, socket) => {
    socket.setNoDelay(true);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
}

const server = role === 'relay' ? createRelay({ host: '127.0.0.1', port: Number(upstreamPort) }) : upstream();
server.listen(Number(port), '127.0.0.1', () => process.send?.({ ready: true }));
process.on('message', (m: { rss?: boolean }) => { if (m.rss) process.send?.({ mem: process.memoryUsage() }); });
process.on('disconnect', () => process.exit(0));
