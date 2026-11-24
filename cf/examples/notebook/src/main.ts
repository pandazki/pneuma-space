import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { space } from '../../../sdk/index.ts';

const server = http.createServer(async (request, response) => {
  const send = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  try {
    const url = new URL(request.url ?? '/', 'http://notebook');
    if (request.method === 'POST' && url.pathname === '/_pneuma-space/trigger/heartbeat') {
      const delivery = String(request.headers['x-pneuma-space-delivery'] ?? '');
      await space.db.query('CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
      await space.db.query('INSERT OR IGNORE INTO deliveries(id,at) VALUES(?,?)', [delivery, Date.now()]);
      return send({ recorded: true });
    }
    if (url.pathname === '/api/state') {
      await space.db.query('CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at INTEGER NOT NULL,author TEXT NOT NULL)');
      await space.db.query('CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
      const [notes, visits, document, objects, jobs] = await Promise.all([
        space.db.query('SELECT * FROM notes ORDER BY created_at DESC LIMIT 100'), space.kv.increment('visits'),
        space.files.get('document.txt'), space.objects.list(), space.db.query('SELECT * FROM deliveries ORDER BY at DESC LIMIT 10'),
      ]);
      return send({ notes: notes.rows, visits: visits.value, document: document ? new TextDecoder().decode(space.files.bytes(document)) : '', objects: objects.items, deliveries: jobs.rows, user: decodeURIComponent(String(request.headers['x-pneuma-space-name'] ?? '')), subject: request.headers['x-pneuma-space-subject'] });
    }
    if (url.pathname === '/api/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.write('data: connected\n\n');
      const timer = setInterval(() => response.write('data: ' + Date.now() + '\n\n'), 1000);
      const end = setTimeout(() => response.end(), 5000);
      response.on('close', () => { clearInterval(timer); clearTimeout(end); }); return;
    }
    if (request.method !== 'POST') return send({ error: 'Not found' }, 404);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 100000) return send({ error: 'Too large' }, 413); chunks.push(chunk); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send({ error: 'Expected an object' }, 400);
    if (url.pathname === '/api/notes' && 'body' in body && typeof body.body === 'string' && body.body.length > 0 && body.body.length <= 4000) {
      await space.db.query('CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at INTEGER NOT NULL,author TEXT NOT NULL)');
      await space.db.query('INSERT INTO notes(id,body,created_at,author) VALUES(?,?,?,?)', [randomUUID(), body.body, Date.now(), String(request.headers['x-pneuma-space-subject'])]);
      await space.kv.publish('notes', { changed: true }); return send({ saved: true });
    }
    if (url.pathname === '/api/document' && 'body' in body && typeof body.body === 'string') {
      await space.files.put('document.txt', new TextEncoder().encode(body.body)); return send({ saved: true });
    }
    if (url.pathname === '/api/upload' && 'key' in body && typeof body.key === 'string' && 'bytes' in body && typeof body.bytes === 'number' && 'contentType' in body && typeof body.contentType === 'string') return send(await space.objects.upload({ key: body.key, bytes: body.bytes, contentType: body.contentType }));
    if (url.pathname === '/api/complete' && 'id' in body && typeof body.id === 'string') return send(await space.objects.complete(body.id));
    if (url.pathname === '/api/download' && 'key' in body && typeof body.key === 'string') return send(await space.objects.download(body.key));
    if (url.pathname === '/api/rtc') return send(await space.rtc.credentials());
    return send({ error: 'Invalid request' }, 400);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Request failed');
    send({ error: error instanceof Error ? error.message : 'Request failed' }, 500);
  }
});
server.listen(Number(process.env.PNEUMA_SPACE_PORT), '0.0.0.0');
