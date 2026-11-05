// The isolate app of AC-ISO: built-ins only, with a file, a SQLite row, and two drills that a worker cannot survive.
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const env = process.env;
const files = env.PNEUMA_SPACE_FILES_DIR!;
const db = new DatabaseSync(new URL(env.PNEUMA_SPACE_DB_URL!).pathname);
db.exec('CREATE TABLE IF NOT EXISTS notes (body TEXT NOT NULL)');

const text = async (request: IncomingMessage) => Buffer.concat(await request.toArray()).toString('utf8');

createServer(async (request, response) => {
  const path = new URL(request.url!, 'http://app').pathname;
  if (path === '/hang') for (;;);
  if (path === '/bloat') {
    const held: number[][] = [];
    for (;;) held.push(new Array(1e5).fill(held.length));
  }
  if (path === '/note' && request.method === 'PUT') {
    const body = await text(request);
    await writeFile(`${files}/note.txt`, body);
    db.prepare('INSERT INTO notes (body) VALUES (?)').run(body);
    return response.end('saved');
  }
  if (path === '/note') {
    const file = await readFile(`${files}/note.txt`, 'utf8').catch(() => null);
    const rows = db.prepare('SELECT body FROM notes').all().map((row) => row.body);
    return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ file, rows }));
  }
  response.end(`${env.PNEUMA_SPACE_APP} ${env.PNEUMA_SPACE_RELEASE}`);
}).listen(Number(env.PNEUMA_SPACE_PORT), '0.0.0.0');

process.on('SIGTERM', () => process.exit(0));
