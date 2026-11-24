import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as EngineResponse } from 'miniflare';
import { DEFAULT_POLICY, type Manifest } from '../src/model.ts';
import { record, text } from '../src/util.ts';
import { parseNativeCommand } from '../src/resources.ts';
let mf: Miniflare;
let turnGate: { started: () => void; release: Promise<void> } | null = null;
before(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./resource-worker.ts', import.meta.url).href)], bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'resources', modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-11-13', durableObjects: { TEST: { className: 'ResourceProbe', useSQLite: true } }, r2Buckets: ['PNEUMA_SPACE_OBJECTS'], outboundService: async request => {
    assert.equal(request.headers.get('authorization'), 'Bearer private-token');
    const gate = turnGate; if (gate) { gate.started(); await gate.release; }
    return EngineResponse.json({ iceServers: [{ urls: ['turn:relay.example:3478'], username: 'short-user', credential: 'short-secret' }] });
  }, bindings: { PNEUMA_SPACE_ACCOUNT_ID: 'example', PNEUMA_SPACE_OBJECT_BUCKET: 'objects', PNEUMA_SPACE_R2_ACCESS_KEY_ID: 'test', PNEUMA_SPACE_R2_SECRET_ACCESS_KEY: 'secret', PNEUMA_SPACE_TURN_KEY_ID: 'test-key', PNEUMA_SPACE_TURN_API_TOKEN: 'private-token' } }));
  await mf.ready;
});
after(async () => { await mf?.dispose(); });
async function call(app: string, body: unknown): Promise<{ status: number; data: unknown; fields: Record<string, unknown> }> {
  const response = await mf.dispatchFetch('http://' + app, { method: 'POST', body: JSON.stringify(body) });
  const data: unknown = await response.json();
  const fields = data && typeof data === 'object' && !Array.isArray(data) ? record(data) : {};
  return { status: response.status, data, fields };
}
async function ensure(app: string, capabilities: Manifest['capabilities'] = { db: {}, kv: {}, files: {}, object: {} }): Promise<void> {
  assert.equal((await call(app, { action: 'ensure', manifest: { contract: 'pneuma-space.cf/1', runtime: 'node', entry: 'app.mjs', capabilities } })).status, 200);
}
const run = (app: string, command: unknown) => call(app, { command });
test('CF-08 application SQL cannot read or mutate hidden platform KV', async () => {
  await ensure('hidden'); await call('hidden', { action: 'retire' });
  for (const sql of ['SELECT * FROM __cf_kv', 'DELETE FROM __cf_kv', 'DROP TABLE __cf_kv', 'ALTER TABLE __cf_kv RENAME TO stolen', 'SELECT * FROM _cf_KV', 'DELETE FROM _cf_KV', 'DROP TABLE _cf_KV', 'ALTER TABLE _cf_KV RENAME TO stolen']) assert.ok([400, 403].includes((await run('hidden', { type: 'db.query', sql, params: [] })).status));
  assert.deepEqual((await call('hidden', { action: 'platform' })).data, [['platform:generation', 2]]);
});
test('CF-08 SQL batch is atomic on statement failure', async () => {
  await ensure('sql');
  assert.equal((await run('sql', { type: 'db.query', sql: 'CREATE TABLE notes(body TEXT)', params: [] })).status, 200);
  assert.equal((await run('sql', { type: 'db.batch', statements: [{ sql: 'INSERT INTO notes VALUES (?)', params: ['durable'] }, { sql: 'INSERT INTO missing VALUES (1)', params: [] }] })).status, 400);
  assert.deepEqual((await run('sql', { type: 'db.query', sql: 'SELECT * FROM notes', params: [] })).fields.rows, []);
});
test('CF-09 retired execution cannot mutate SQL, KV or files', async () => {
  await ensure('fence'); await call('fence', { action: 'retire' });
  for (const command of [{ type: 'db.query', sql: 'CREATE TABLE stale(x)', params: [] }, { type: 'kv.put', key: 'stale', value: 1 }, { type: 'files.put', path: 'stale', body: 'eA==' }]) {
    assert.equal((await call('fence', { command, scope: { appId: 'test', generation: 1, bootId: 'old' } })).fields.error, 'stale');
  }
  assert.equal((await run('fence', { type: 'kv.get', key: 'stale' })).data, null);
});
test('CF-14 concurrent CAS allows exactly one matching revision', async () => {
  await ensure('cas');
  const first = await run('cas', { type: 'kv.put', key: 'key', value: 0 });
  const results = await Promise.all([1, 2].map(value => run('cas', { type: 'kv.put', key: 'key', value, expected: first.fields.revision })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});
test('CF-14 concurrent increments preserve every update', async () => {
  await ensure('increment');
  await Promise.all(Array.from({ length: 30 }, () => run('increment', { type: 'kv.increment', key: 'counter', amount: 1 })));
  assert.equal((await run('increment', { type: 'kv.get', key: 'counter' })).fields.value, 30);
});
test('CF-14 undeclared capability is refused', async () => {
  await ensure('undeclared', { kv: {} });
  assert.equal((await run('undeclared', { type: 'files.get', path: 'secret' })).status, 403);
});
test('CF-14 publish delivers the JSON value to the broadcast hook', async () => {
  await ensure('publish');
  assert.deepEqual((await run('publish', { type: 'kv.publish', channel: 'live', value: { count: 1 } })).data, { subscribers: 2 });
  assert.deepEqual((await call('publish', { action: 'platform' })).data, [['platform:last-broadcast', { channel: 'live', value: { count: 1 } }]]);
});
test('CF-10 suspension retains files and revisions through ensure', async () => {
  await ensure('retain');
  const saved = await run('retain', { type: 'files.put', path: 'draft.txt', body: 'aGVsbG8=', expected: null });
  await call('retain', { action: 'suspend' });
  assert.equal((await run('retain', { type: 'files.get', path: 'draft.txt' })).status, 409);
  await ensure('retain');
  assert.deepEqual((await run('retain', { type: 'files.get', path: 'draft.txt' })).data, saved.data);
});
test('CF-20 quota refusal rolls back the file mutation and revision', async () => {
  await ensure('quota');
  assert.equal((await call('quota', { policy: { ...DEFAULT_POLICY, storageBytes: 100 }, command: { type: 'files.put', path: 'too-big', body: btoa('x'.repeat(1000)) } })).status, 429);
  assert.equal((await run('quota', { type: 'files.get', path: 'too-big' })).data, null);
});
test('CF-20 SQL result limit rolls back a writing statement', async () => {
  await ensure('result');
  await run('result', { type: 'db.query', sql: 'CREATE TABLE result(body)', params: [] });
  assert.equal((await run('result', { type: 'db.query', sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 1001) INSERT INTO result SELECT x FROM n RETURNING body", params: [] })).status, 413);
  assert.deepEqual((await run('result', { type: 'db.query', sql: 'SELECT * FROM result', params: [] })).fields.rows, []);
});
test('CF-20 malformed command and oversized file are refused before storage', () => {
  for (const command of [{ type: 'kv.put', key: 'x', value: Infinity }, { type: 'files.put', path: '../x', body: '' }, { type: 'files.put', path: 'x', body: 'not base64' }, { type: 'files.put', path: 'x', body: btoa('x'.repeat(65537)) }, { type: 'db.query', sql: 'SELECT 1; SELECT 2', params: [] }]) assert.throws(() => parseNativeCommand(command));
});
test('CF-11 upload completion validates R2 HEAD size and content type', async () => {
  await ensure('objects');
  const ticket = (await run('objects', { type: 'object.upload', key: 'hello.txt', bytes: 5, contentType: 'text/plain' })).fields;
  const key = decodeURIComponent(new URL(text(ticket.url, 'ticket URL', 4096)).pathname.split('/').slice(2).join('/'));
  const { PNEUMA_SPACE_OBJECTS: bucket } = await mf.getBindings<{ PNEUMA_SPACE_OBJECTS: R2Bucket }>();
  await bucket.put(key, 'wrong-length', { httpMetadata: { contentType: 'text/plain' } });
  assert.equal((await run('objects', { type: 'object.complete', id: ticket.id })).status, 409);
  await bucket.put(key, 'hello', { httpMetadata: { contentType: 'text/plain' } });
  assert.equal((await run('objects', { type: 'object.complete', id: ticket.id })).fields.bytes, 5);
});
test('CF-11 purge waits for signed upload expiry and cleans again', async () => {
  await ensure('purge'); await call('purge', { action: 'retire' });
  await run('purge', { type: 'db.query', sql: 'CREATE TABLE data(x)', params: [] });
  await run('purge', { type: 'kv.put', key: 'value', value: 1 });
  const ticket = (await run('purge', { type: 'object.upload', key: 'late.txt', bytes: 4, contentType: 'text/plain' })).fields;
  const key = decodeURIComponent(new URL(text(ticket.url, 'ticket URL', 4096)).pathname.split('/').slice(2).join('/'));
  const retryAt = (await call('purge', { action: 'destroy' })).fields.retryAt;
  assert.equal(typeof retryAt, 'number'); assert.equal(typeof ticket.expiresAt, 'number');
  assert.ok(Number(retryAt) >= Number(ticket.expiresAt));
  const { PNEUMA_SPACE_OBJECTS: bucket } = await mf.getBindings<{ PNEUMA_SPACE_OBJECTS: R2Bucket }>();
  await bucket.put(key, 'late');
  await call('purge', { action: 'expire' });
  assert.deepEqual((await call('purge', { action: 'destroy' })).data, { retryAt: null });
  assert.equal(await bucket.head(key), null);
  assert.equal((await run('purge', { type: 'kv.put', key: 'late', value: 1 })).status, 410);
  assert.deepEqual((await call('purge', { action: 'platform' })).data, [['platform:generation', 2]]);
  assert.deepEqual((await call('purge', { action: 'destroy' })).data, { retryAt: null });
});
test('CF-20 SQL blob results preserve bytes and respect result limits', async () => {
  await ensure('blob');
  assert.deepEqual((await run('blob', { type: 'db.query', sql: "SELECT x'0001ff' AS bytes", params: [] })).fields.rows, [{ bytes: 'AAH/' }]);
  assert.equal((await run('blob', { type: 'db.query', sql: 'SELECT zeroblob(300000) AS bytes', params: [] })).status, 413);
});
test('CF-20 SQL writes respect database byte quota', async () => {
  await ensure('sqlquota');
  await run('sqlquota', { type: 'db.query', sql: 'CREATE TABLE big(bytes)', params: [] });
  assert.equal((await call('sqlquota', { policy: { ...DEFAULT_POLICY, storageBytes: 32768 }, command: { type: 'db.query', sql: 'INSERT INTO big VALUES(zeroblob(65536))', params: [] } })).status, 429);
  assert.deepEqual((await run('sqlquota', { type: 'db.query', sql: 'SELECT * FROM big', params: [] })).fields.rows, []);
});
test('CF-20 file listings paginate within bounded result bytes', async () => {
  await ensure('pages');
  for (let n = 0; n < 5; n++) await run('pages', { type: 'files.put', path: 'page' + n, body: btoa('x'.repeat(65536)) });
  const first = (await run('pages', { type: 'files.list' })).fields;
  assert.ok(Array.isArray(first.items)); assert.ok(first.items.length < 5); assert.equal(typeof first.nextCursor, 'string');
  let count = first.items.length; let cursor = first.nextCursor;
  while (cursor) { const next = (await run('pages', { type: 'files.list', cursor })).fields; assert.ok(Array.isArray(next.items)); count += next.items.length; cursor = next.nextCursor; }
  assert.equal(count, 5);
});
test('CF-09 retirement during awaited credential IO refuses the result', async () => {
  await ensure('turnfence', { rtc: {} });
  let start = () => {}; let finish = () => {};
  const started = { promise: new Promise<void>(resolve => { start = resolve; }), resolve: () => start() };
  const release = { promise: new Promise<void>(resolve => { finish = resolve; }), resolve: () => finish() };
  turnGate = { started: () => started.resolve(), release: release.promise };
  const pending = call('turnfence', { command: { type: 'rtc.credentials' }, scope: { appId: 'test', generation: 1, bootId: 'old' } });
  try {
    await started.promise;
    await call('turnfence', { action: 'retire' });
    release.resolve();
    assert.equal((await pending).fields.error, 'stale');
  } finally { release.resolve(); turnGate = null; }
});
test('CF-10 purge drops application tables with foreign key dependencies', async () => {
  await ensure('foreignkeys');
  await run('foreignkeys', { type: 'db.batch', statements: [
    { sql: 'CREATE TABLE a_parent(id PRIMARY KEY)', params: [] },
    { sql: 'CREATE TABLE z_child(parent REFERENCES a_parent(id))', params: [] },
    { sql: 'INSERT INTO a_parent VALUES(1)', params: [] },
    { sql: 'INSERT INTO z_child VALUES(1)', params: [] },
  ] });
  assert.deepEqual((await call('foreignkeys', { action: 'destroy' })).data, { retryAt: null });
  assert.deepEqual(record((await call('foreignkeys', { action: 'inventory' })).fields.db).tables, []);
});
test('CF-14 expired KV is absent from get and list and permits create CAS', async () => {
  await ensure('ttl');
  await run('ttl', { type: 'kv.put', key: 'ttl', value: 'old', ttl: 10 });
  await call('ttl', { action: 'expire-kv' });
  assert.deepEqual((await run('ttl', { type: 'kv.list' })).data, { items: [] });
  assert.equal((await run('ttl', { type: 'kv.get', key: 'ttl' })).data, null);
  assert.equal((await run('ttl', { type: 'kv.put', key: 'ttl', value: 'new', expected: null })).status, 200);
});
test('CF-03 native object purge preserves another application prefix', async () => {
  await ensure('object-owner'); await ensure('object-neighbor');
  const ticket = (await run('object-owner', { type: 'object.upload', key: 'keep.txt', bytes: 4, contentType: 'text/plain' })).fields;
  const key = decodeURIComponent(new URL(text(ticket.url, 'ticket URL', 4096)).pathname.split('/').slice(2).join('/'));
  const { PNEUMA_SPACE_OBJECTS: bucket } = await mf.getBindings<{ PNEUMA_SPACE_OBJECTS: R2Bucket }>();
  await bucket.put(key, 'keep', { httpMetadata: { contentType: 'text/plain' } });
  await run('object-owner', { type: 'object.complete', id: ticket.id });
  await call('object-neighbor', { action: 'destroy' });
  assert.equal((await bucket.head(key))?.size, 4);
});
test('CF-10 purge preserves the platform alarm storage and fence', async () => {
  await ensure('alarm'); await call('alarm', { action: 'retire' });
  const alarm = await call('alarm', { action: 'alarm' });
  assert.equal(alarm.status, 200, JSON.stringify(alarm.data));
  assert.equal(typeof alarm.fields.alarm, 'number');
  assert.deepEqual(record((await call('alarm', { action: 'inventory' })).fields.db).tables, []);
  assert.equal((await run('alarm', { type: 'db.query', sql: 'CREATE TABLE ordinary(value)', params: [] })).status, 200);
  assert.deepEqual((await call('alarm', { action: 'destroy' })).data, { retryAt: null });
  assert.equal((await call('alarm', { action: 'read-alarm' })).fields.alarm, alarm.fields.alarm);
  assert.deepEqual(record((await call('alarm', { action: 'inventory' })).fields.db).tables, []);
  assert.deepEqual((await call('alarm', { action: 'platform' })).data, [['platform:generation', 2]]);
});
