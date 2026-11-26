import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error The packaged CLI is a plain Node script.
import { runJobNow, showJobs, getPath } from '../cli/bin/pneuma-space.mjs';

const run = promisify(execFile), cli = new URL('../cli/bin/pneuma-space.mjs', import.meta.url).pathname;
type Job = { id: string; name: string; state: string; attempts: number; scheduledFor: number; error: string | null };
async function project(manifest: Record<string, unknown>, jobs: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'pneuma-space-cli-view-'));
  await mkdir(join(dir, 'app/jobs'), { recursive: true });
  await writeFile(join(dir, 'pneuma-space.json'), JSON.stringify({ contract: 'pneuma-space.cf/1', runtime: 'node', entry: 'server.mjs', ...manifest }));
  await writeFile(join(dir, 'app/server.mjs'), 'export {};');
  for (const name of jobs) await writeFile(join(dir, 'app/jobs', name + '.mjs'), 'export default async function () {}');
  return { dir, close: () => rm(dir, { recursive: true, force: true }) };
}
const pack = (dir: string) => run(process.execPath, [cli, 'package', dir]);
function capture() {
  const lines: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
  return { lines, text: () => lines.join('\n'), restore: () => { console.log = log; process.exitCode = 0; } };
}
// A workspace as the CLI loads it, with the control API answered from memory.
function workspace(handle: (method: string, path: string, body?: Record<string, unknown>) => unknown, origin = 'https://space.test') {
  const calls: string[] = [];
  const request = async (path: string, body?: Record<string, unknown>, method = body === undefined ? 'GET' : 'POST') => { calls.push(method + ' ' + path); return handle(method, path, body); };
  return { calls, w: { directory: '/', privateDir: '/', project: { name: 'demo', tenant: 't', origin, app: { id: 'a_1', name: 'demo' } }, client: { origin, request, headers: { authorization: 'Bearer ' + 'f'.repeat(64) } } } };
}

test('CF-35 packaging refuses a declared job without its file and a job file without its trigger', async () => {
  const cases: [Record<string, unknown>, string[], RegExp][] = [
    [{ capabilities: { kv: {}, cron: { triggers: { tidy: { schedule: '0 3 * * *' } } } } }, [], /declares the job tidy, but app\/jobs\/tidy\.mjs is missing/],
    [{ capabilities: { kv: {}, cron: { triggers: {} } } }, ['tidy'], /app\/jobs\/tidy\.mjs is not declared/],
    [{ capabilities: { kv: {} } }, ['tidy'], /app\/jobs\/tidy\.mjs is not declared/],
  ];
  for (const [manifest, jobs, error] of cases) {
    const p = await project(manifest, jobs);
    try { await assert.rejects(pack(p.dir), error); } finally { await p.close(); }
  }
  const p = await project({ capabilities: { kv: {}, cron: { triggers: { tidy: { schedule: '0 3 * * *' }, sweep: {} } } } }, ['tidy', 'sweep']);
  try { assert.match((await pack(p.dir)).stdout, /"digest"/); } finally { await p.close(); }
});
test('CF-35 run invokes the job, waits for its delivery and prints the outcome and the app output since', async () => {
  const at = Date.now();
  let job: Job | null = null, polls = 0;
  const { w, calls } = workspace((method, path, body) => {
    if (method === 'POST' && path === '/apps/a_1/jobs') return job = { id: 'manual_k', name: String(body?.name), state: 'due', attempts: 0, scheduledFor: at, error: null };
    if (path === '/apps/a_1/jobs') { polls++; if (job) Object.assign(job, polls === 1 ? { state: 'delivering', attempts: 1 } : { state: 'done' }); return { items: [job] }; }
    if (path === '/apps/a_1/logs') return { items: [{ at: at - 60000, level: 'info', message: 'before the run' }, { at: at + 50, level: 'info', message: 'job tidy finished delivery manual_k (attempt 1) in 12 ms' }] };
    throw new Error('unexpected ' + path);
  });
  const out = capture();
  try { await runJobNow(w, 'tidy', { interval: 5 }); assert.equal(process.exitCode ?? 0, 0); } finally { out.restore(); }
  assert.deepEqual(calls.slice(0, 1), ['POST /apps/a_1/jobs']);
  assert.match(out.text(), /tidy finished delivery manual_k on attempt 1/);
  assert.match(out.text(), /App output \(UTC\):\n\S+ {2}info {2}job tidy finished delivery manual_k/);
  assert.doesNotMatch(out.text(), /before the run/);
});
test('CF-35 run reports a failed attempt with its error and exits 1', async () => {
  const job: Job = { id: 'manual_k', name: 'tidy', state: 'due', attempts: 0, scheduledFor: Date.now(), error: null };
  const { w } = workspace((method, path) => {
    if (method === 'POST') return { ...job };
    if (path.endsWith('/jobs')) return { items: [{ ...job, attempts: 1, error: 'Trigger returned HTTP 500' }] };
    return { items: [] };
  });
  const out = capture();
  let code;
  try { await runJobNow(w, 'tidy', { interval: 5 }); code = process.exitCode; } finally { out.restore(); }
  assert.equal(code, 1);
  assert.match(out.text(), /Attempt 1 of tidy failed: Trigger returned HTTP 500\. The platform retries it/);
});
test('CF-35 run explains a token without the publish or manage permission and an undeclared job', async () => {
  for (const [code, message] of [['token_scope', /needs the publish or manage permission/], ['trigger', /live release has no job tidy/]] as const) {
    const { w } = workspace(() => { throw Object.assign(new Error('refused'), { code }); });
    await assert.rejects(runJobNow(w, 'tidy', { interval: 5 }), message);
  }
});
test('CF-35 jobs lists the declared schedules, only the last 10 deliveries newest first, and the last 20 lines of app output', async () => {
  const items: Job[] = Array.from({ length: 12 }, (_, i) => ({ id: 'scheduled_1_tidy_' + i, name: 'tidy', state: i === 11 ? 'failed' : 'done', attempts: i === 11 ? 5 : 1, scheduledFor: Date.UTC(2026, 10, 27, 0, i), error: i === 11 ? 'Trigger returned HTTP 500' : null }));
  const logs = Array.from({ length: 25 }, (_, i) => ({ at: 1000 + i, level: 'info', message: 'line ' + i }));
  const { w } = workspace(((method: string, path: string) => path === '/apps/a_1' ? { expiresAt: null, current: { manifest: { capabilities: { cron: { triggers: { tidy: { schedule: '*/1 * * * *' }, sweep: {} } } } } } } : path.endsWith('/logs') ? { items: logs } : { items: [...items].reverse() }) as never);
  const out = capture();
  try { await showJobs(w); } finally { out.restore(); }
  assert.match(out.text(), /tidy {2}\*\/1 \* \* \* \*\n {2}sweep {2}on demand only/);
  const ids = out.text().match(/scheduled_1_tidy_\d+/g);
  assert.deepEqual(ids, Array.from({ length: 10 }, (_, i) => 'scheduled_1_tidy_' + (11 - i)));
  assert.match(out.text(), /Last 10 of 12 deliveries/);
  assert.match(out.text(), /tidy {2}failed {2}attempts 5 {2}scheduled_1_tidy_11 {2}Trigger returned HTTP 500/);
  assert.deepEqual(out.text().match(/line \d+/g), Array.from({ length: 20 }, (_, i) => 'line ' + (i + 5)));
});
test('CF-36 get requests a path of the app with the token as a Bearer header only and prints the status and the start of the reply', async () => {
  const seen: { url: string; authorization?: string }[] = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url!, authorization: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: ['x'.repeat(3000)] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port, { w } = workspace(() => ({}), origin), out = capture();
  try {
    assert.equal(await getPath(w, '/api/items?limit=2'), 200);
    for (const outside of ['../../api/v1/me', 'https://elsewhere.test/']) await assert.rejects(getPath(w, outside), /inside this app/);
  } finally { out.restore(); server.close(); }
  assert.deepEqual(seen, [{ url: '/apps/demo/api/items?limit=2', authorization: 'Bearer ' + 'f'.repeat(64) }]);
  assert.match(out.text(), /GET \/apps\/demo\/api\/items\?limit=2: 200, application\/json, 3014 bytes/);
  assert.match(out.text(), /\{"items":\["x{1989}\n\[first 2000 of 3014 bytes\]/);
  assert.doesNotMatch(out.text(), /f{64}/);
});
