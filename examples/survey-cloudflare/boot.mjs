import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
const image = (await readFile('/probe/image', 'utf8')).trim();
const boot = randomUUID();
process.env.PNEUMA_SPACE_BOOT_ID = boot;
process.env.PNEUMA_SPACE_IMAGE = image;
await import('./src/server.ts');
setTimeout(() => process.exit(0), 120000).unref();
const server = http.createServer((req, res) => {
  const upstream = http.request({ host: '127.0.0.1', port: 8000, path: req.url, method: req.method, headers: req.headers }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('App starting'); });
  req.pipe(upstream);
});
server.listen(8080, '0.0.0.0');
process.once('SIGTERM', () => server.close(() => process.exit(0)));
