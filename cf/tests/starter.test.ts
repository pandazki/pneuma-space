import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Stored = { value: unknown; ttl?: number };
// The starter app runs as on the platform: its own server.mjs, with the broker the runner names in PNEUMA_SPACE_BROKER.
async function starter(jobs: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'pneuma-space-starter-'));
  await cp(new URL('../cli/templates/demo', import.meta.url).pathname, dir, { recursive: true });
  const manifestPath = join(dir, 'pneuma-space.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.capabilities.cron = { triggers: Object.fromEntries(Object.keys(jobs).map(name => [name, { schedule: '0 3 * * *' }])) };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(join(dir, 'app/jobs'));
  for (const [name, source] of Object.entries(jobs)) await writeFile(join(dir, 'app/jobs', name + '.mjs'), source);
  const kv = new Map<string, Stored>();
  const broker = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const command = JSON.parse(text), reply = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (command.type === 'kv.get') { const item = kv.get(command.key); return reply(item ? { key: command.key, value: item.value, revision: 1, expiresAt: null } : null); }
    if (command.type === 'kv.put') { kv.set(command.key, { value: command.value, ttl: command.ttl }); return reply({ value: command.value, revision: 1 }); }
    if (command.type === 'kv.increment') { const value = Number(kv.get(command.key)?.value ?? 0) + command.amount; kv.set(command.key, { value }); return reply({ value, revision: 1 }); }
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'input', message: 'Unsupported command.' } }));
  });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const free = net.createServer().listen(0, '127.0.0.1'); await once(free, 'listening');
  const port = (free.address() as net.AddressInfo).port; free.close();
  const output: string[] = [];
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['server.mjs'], { cwd: join(dir, 'app'), env: { ...process.env, PNEUMA_SPACE_PORT: String(port), PNEUMA_SPACE_BROKER: 'http://127.0.0.1:' + (broker.address() as net.AddressInfo).port } });
  for (const [stream, level] of [[child.stdout, 'info'], [child.stderr, 'error']] as const) stream.on('data', (chunk: Buffer) => output.push(...String(chunk).split('\n').filter(Boolean).map(line => level + ' ' + line)));
  const origin = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) { try { await fetch(origin + '/api/proof'); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
  // A delivery as the platform sends it (src/app.ts deliver): POST to the trigger path with its id, attempt and JSON payload.
  const deliver = (name: string, id: string, payload: unknown = null, attempt = 1) => fetch(origin + '/_pneuma-space/trigger/' + name, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pneuma-space-delivery': id, 'x-pneuma-space-delivery-attempt': String(attempt) }, body: JSON.stringify(payload) });
  return { origin, kv, output, deliver, close: async () => { child.kill(); broker.close(); await rm(dir, { recursive: true, force: true }); } };
}
const tally = "import {native} from '../space.mjs';\nexport default async function ({payload}) { await native({type: 'kv.increment', key: 'tally', amount: payload?.by ?? 1}); }\n";

test('CF-35 a starter job runs once per delivery id, with the payload, and a repeated delivery answers 200 without running', async () => {
  const app = await starter({ tally });
  try {
    assert.equal((await app.deliver('tally', 'd1', { by: 2 })).status, 200);
    assert.equal((await app.deliver('tally', 'd1', { by: 2 }, 2)).status, 200);
    assert.equal((await app.deliver('tally', 'd2')).status, 200);
    assert.equal(app.kv.get('tally')?.value, 3);
    assert.ok(app.output.some(line => line.startsWith('info job tally skipped delivery d1')), app.output.join('\n'));
    assert.ok(app.output.some(line => /^info job tally finished delivery d2 \(attempt 1\)/.test(line)), app.output.join('\n'));
  } finally { await app.close(); }
});
test('CF-35 a job that throws answers 500, logs its name, delivery and error, and runs again on the next attempt', async () => {
  const app = await starter({ flaky: "import {native} from '../space.mjs';\nexport default async function () { const n = await native({type: 'kv.increment', key: 'tries', amount: 1}); if (n.value < 2) throw new Error('not yet'); }\n" });
  try {
    assert.equal((await app.deliver('flaky', 'd3')).status, 500);
    assert.ok(app.output.includes('error job flaky failed delivery d3 (attempt 1): not yet'), app.output.join('\n'));
    assert.equal((await app.deliver('flaky', 'd3', null, 2)).status, 200);
    assert.equal(app.kv.get('tries')?.value, 2);
  } finally { await app.close(); }
});
test('CF-35 the starter data API still answers beside the job route', async () => {
  const app = await starter({ tally });
  try {
    const response = await fetch(app.origin + '/api/items');
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { items: unknown[] }).items.length, 4);
  } finally { await app.close(); }
});
