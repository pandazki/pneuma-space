import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../sdk/db.ts';
import { need } from '../sdk/env.ts';
import { kv } from '../sdk/kv.ts';
import { body, serve } from '../sdk/serve.ts';
import type { Context, Delivery } from '../sdk/serve.ts';
import { ws } from '../sdk/ws.ts';
import type { Socket } from '../sdk/ws.ts';

const files = need('files').dir;
await mkdir(files, { recursive: true });
const sql = db();
const store = await kv();
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

await sql.exec(`CREATE TABLE IF NOT EXISTS note (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`);

const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function page({ prefix, identity, res }: Context) {
  const notes = await sql.query<{ author: string; body: string }>(
    'SELECT author, body FROM note ORDER BY created_at DESC LIMIT 20');
  const tick = await readFile(join(files, 'last-tick.json'), 'utf8').catch(() => 'never');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>PneumaSpace app</title><link rel="stylesheet" href="${prefix}/style.css"></head>
<body data-prefix="${html(prefix)}">
<h1>Hello, ${html(identity?.name ?? 'anonymous')}</h1>
<form method="post" action="${prefix}/notes"><input name="body" required><button>Add note</button></form>
<ul>${notes.map((n) => `<li>${html(n.body)} <small>${html(n.author)}</small></li>`).join('')}</ul>
<h2>Room</h2><form id="say"><input name="text"><button>Send</button></form><ul id="room"></ul>
<p>Last tick: ${html(tick)}</p>
<script src="${prefix}/app.js"></script></body></html>`);
}

async function addNote({ prefix, identity, req, res }: Context) {
  const text = new URLSearchParams((await body(req)).toString()).get('body')?.trim();
  if (text) {
    await sql.exec('INSERT INTO note (id, author, body, created_at) VALUES (?, ?, ?, ?)',
      [randomUUID(), identity?.subject ?? 'anonymous', text, new Date().toISOString()]);
  }
  res.writeHead(303, { location: `${prefix}/` }).end();
}

// Declaring "static": {"dir": "public"} in pneuma-space.json makes the platform serve these
// without waking the app; the URLs stay the same, so this function can then be deleted.
async function asset({ url, res }: Context): Promise<boolean> {
  const file = join(PUBLIC, decodeURIComponent(url.pathname));
  if (!file.startsWith(PUBLIC)) return false;
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) return false;
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(bytes);
  return true;
}

async function tick(delivery: Delivery) {
  await writeFile(join(files, 'last-tick.json'), JSON.stringify({ delivery: delivery.id, at: new Date().toISOString() }));
}

const routes: Record<string, (ctx: Context) => Promise<void>> = { 'GET /': page, 'POST /notes': addNote };

const server = serve(async (ctx) => {
  const route = routes[`${ctx.req.method} ${ctx.url.pathname}`];
  if (route) return route(ctx);
  if (ctx.req.method === 'GET' && (await asset(ctx))) return;
  ctx.res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}, { triggers: { tick } });

// Every container subscribes and fans out locally, so the room works with one container or many.
// The last 50 messages live in KV, so a new tab or a reconnect after the app slept sees them.
const room = new Set<Socket>();
const log = store.key('room:log');
await store.subscribe('room', (message) => room.forEach((socket) => socket.send(message)));
ws(server, async (socket) => {
  if (socket.url.pathname !== '/room') return socket.close(1008, 'unknown path');
  socket.onclose = () => room.delete(socket);
  for (const message of (await store.redis.lRange(log, 0, 49)).reverse()) socket.send(message);
  room.add(socket);
  socket.onmessage = async (data) => {
    const text = String(data).trim().slice(0, 500);
    if (!text) return;
    const message = JSON.stringify({ from: socket.identity?.name ?? 'anonymous', text, at: new Date().toISOString() });
    await store.redis.multi().lPush(log, message).lTrim(log, 0, 49).exec();
    await store.publish('room', message);
  };
});
