import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractPackage } from './package.mjs';

const broker = process.env.PNEUMA_SPACE_BROKER ?? 'http://pneuma-space.internal';
const boot = process.env.PNEUMA_SPACE_BOOT_ID;
const digest = process.env.PNEUMA_SPACE_DIGEST;
const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-'));
const response = await fetch(broker + '/boot');
if (!response.ok) throw new Error('Package fetch failed: ' + response.status);
const manifest = await extractPackage(Buffer.from(await response.arrayBuffer()), digest, directory);
let ready = false;
let exited = false;
let logs = [];
let sending = false;
async function flush() {
  if (sending || !logs.length) return;
  sending = true;
  const batch = logs.splice(0, 100);
  try { await fetch(broker + '/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: batch }), signal: AbortSignal.timeout(5000) }); }
  catch { logs = [...batch, ...logs].slice(-100); }
  finally { sending = false; }
}
const child = spawn(process.execPath, [manifest.entry], {
  cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: 'production', PNEUMA_SPACE_PORT: '8000', PORT: '8000', PNEUMA_SPACE_BROKER: broker },
});
for (const [stream, level] of [[child.stdout, 'info'], [child.stderr, 'error']]) stream.on('data', chunk => {
  for (const message of chunk.toString().split('\n').filter(Boolean)) logs.push({ level, message: message.slice(0, 2000) });
  logs = logs.slice(-100);
  void flush();
});
child.on('exit', () => { exited = true; ready = false; });
const server = http.createServer((req, res) => {
  if (req.url === '/_pneuma-space/ready') {
    res.writeHead(ready && !exited ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ bootId: boot, digest, ready }));
    return;
  }
  if (!ready) { res.writeHead(503); res.end(); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: 8000, path: req.url, method: req.method, headers: req.headers }, reply => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
    res.on('close', () => reply.destroy());
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  if (!ready) { socket.destroy(); return; }
  const upstream = net.connect(8000, '127.0.0.1', () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.listen(Number(process.env.PNEUMA_SPACE_SUPERVISOR_PORT ?? 8080), '0.0.0.0');
for (let attempt = 0; attempt < 150 && !exited; attempt++) {
  ready = await new Promise(resolve => {
    const socket = net.connect(8000, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (!ready) { await flush(); child.kill('SIGKILL'); process.exitCode = 1; server.close(); }
setInterval(flush, 1000).unref();
process.on('SIGTERM', () => { child.kill('SIGTERM'); server.close(); setTimeout(() => process.exit(), 1000).unref(); });
