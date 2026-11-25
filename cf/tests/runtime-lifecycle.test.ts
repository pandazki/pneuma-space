import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, type WebSocket as LocalWebSocket } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { DEFAULT_POLICY, WAKE_PHASES } from '../src/model.ts';

let mf: Miniflare;
let triggerServer: http.Server;
const actor = { kind: 'session', hash: 'test-session', csrf: 'test-csrf', user: { id: 'owner', username: 'owner', name: 'Owner', platformAdmin: true, disabled: false, createdAt: 1 } };
const manifest = { contract: 'pneuma-space.cf/1', runtime: 'static', entry: 'public/index.html', capabilities: { static: { dir: 'public' } } };
const packageBytes = JSON.stringify({ manifest, files: [{ path: 'public/index.html', body: Buffer.from('Hello').toString('base64'), contentType: 'text/html' }] });
const digest = createHash('sha256').update(packageBytes).digest('hex');
async function call(app: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return mf.dispatchFetch('http://test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-test-app': app, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function fixture(expiresAt: number | null = null) {
  const app = 'app_' + crypto.randomUUID().replaceAll('-', '');
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare("INSERT INTO apps(id,name,tenant_id,owner_id,origin,created_at,create_key,expires_at) VALUES(?,?,'tenant','owner',?,1,?,?)").bind(app, app, app, app, expiresAt).run();
  const initialized = await call(app, '/initialize', { id: app, name: app, tenantId: 'tenant', ownerId: 'owner', policy: DEFAULT_POLICY, expiresAt, manager: null });
  assert.equal(initialized.status, 200, await initialized.text());
  const key = 'apps/' + app + '/artifacts/' + digest + '/package.json';
  const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS') as unknown as R2Bucket;
  await bucket.put(key, packageBytes);
  const artifact = { digest, key, bytes: Buffer.byteLength(packageBytes), manifest };
  const published = await call(app, '/publish', { actor, artifact, expectedGeneration: 0, idempotencyKey: 'publish', ephemeral: expiresAt !== null });
  assert.equal(published.status, 200, await published.text());
  return { app, artifact };
}
before(async () => {
  const fixtureWorker = `
    import {AppCell as BaseAppCell} from './src/app.ts';
    import worker from './src/worker.ts';
    export {AppServices} from './src/app.ts';
    export class AppCell extends BaseAppCell {
      container() {
        if (!this.ctx.storage.kv.get('test:runner')) return super.container();
        const cell = this;
        return {
          running: false, images: {base: 'runner'},
          start(options) { cell.boot = options.env.PNEUMA_SPACE_BOOT_ID; },
          async setInactivityTimeout() {},
          getTcpPort() { return {fetch: async input => new URL(input.url ?? input).pathname === '/_pneuma-space/ready'
            ? Response.json({bootId: cell.boot, digest: cell.state().current.digest, ready: true, uptime: 5, phases: {fetch: 30, unpack: 4, listen: 12}})
            : new Response('woken')}; },
        };
      }
      async startBinding(scope) { if (!this.ctx.storage.kv.get('test:runner')) return super.startBinding(scope); }
      native() {
        const resources = super.native();
        return this.ctx.storage.kv.get('test:fail-purge') ? Object.assign(Object.create(resources), {destroy: async () => { throw new Error('R2 unavailable'); }}) : resources;
      }
      async containerAcquire() {
        if (!this.ctx.storage.kv.get('test:trigger')) return super.containerAcquire();
        return {fetch: request => {
          const forwarded = new Request(request);
          forwarded.headers.set('x-test-app', this.state().id);
          return this.env.TEST_TRIGGER.fetch(forwarded);
        }};
      }
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/test/forget-receipt') {
          const {key} = await request.json();
          this.ctx.storage.kv.delete('platform:receipt:' + key);
          return new Response('{}');
        }
        if (path === '/test/runner') { this.ctx.storage.kv.put('test:runner', true); return new Response('{}'); }
        if (path === '/test/fail-purge') { const {fail} = await request.json(); if (fail) this.ctx.storage.kv.put('test:fail-purge', true); else this.ctx.storage.kv.delete('test:fail-purge'); return new Response('{}'); }
        if (path === '/test/alarm') { await this.alarm(); return new Response('{}'); }
        if (path === '/test/schedules') return Response.json(this.state().schedules);
        if (path === '/test/configure-schedule') {
          const state = this.state();
          state.current.manifest.capabilities.cron = {triggers: {tick: {schedule: '* * * * *'}}};
          state.capabilities.push('cron');
          this.save(state);
          this.native().ensure(state.current.manifest);
          return new Response('{}');
        }
        if (path === '/test/deliveries') return Response.json({pending: this.deliveries?.size ?? 0});
        if (path === '/test/configure-kv') {
          const {boot} = await request.json();
          const state = this.state();
          state.current.manifest.runtime = 'node';
          state.current.manifest.capabilities.kv = {};
          state.capabilities.push('kv');
          state.runtime.bootId = boot ? 'test-boot' : null;
          state.runtime.sleepsAt = boot ? Date.now() + 60000 : null;
          this.save(state);
          this.native().ensure(state.current.manifest);
          return new Response('{}');
        }
        if (path === '/test/configure-cron') {
          const state = this.state();
          state.current.manifest.runtime = 'node';
          state.current.manifest.capabilities.cron = {triggers: {tick: {}}};
          state.capabilities.push('cron');
          state.policy.drainSeconds = 0;
          state.policy.requestSeconds = 30;
          this.save(state);
          this.ctx.storage.kv.put('test:trigger', true);
          this.native().ensure(state.current.manifest);
          return new Response('{}');
        }
        return super.fetch(request);
      }
    }
    export default {fetch(request, env) {
      if (new URL(request.url).pathname.startsWith('/test/trigger/')) return env.TEST_TRIGGER.fetch(request);
      if (new URL(request.url).pathname.startsWith('/apps/')) return worker.fetch(request, env);
      return env.PNEUMA_SPACE_APPS.getByName(request.headers.get('x-test-app')).fetch(request);
    }};
  `;
  const bundled = await build({ stdin: { contents: fixtureWorker, resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'esnext', external: ['cloudflare:workers'] });
  const streams = new Map<string, http.ServerResponse>();
  triggerServer = http.createServer((request, response) => {
    const app = String(request.headers['x-test-app']);
    if (request.url === '/test/trigger/started') { response.end(JSON.stringify({started: streams.has(app)})); return; }
    if (request.url === '/test/trigger/release') { streams.get(app)?.end(); response.end('{}'); return; }
    streams.set(app, response);
    response.write('started');
  });
  triggerServer.listen(0, '127.0.0.1');
  await once(triggerServer, 'listening');
  const address = triggerServer.address();
  assert.ok(address && typeof address !== 'string');
  const triggerWorker = `export default {fetch(request) {return fetch('http://127.0.0.1:${address.port}' + new URL(request.url).pathname, request)}};`;
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'runtime-tests', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-11-13', compatibilityFlags: ['nodejs_compat'], durableObjects: { PNEUMA_SPACE_APPS: { className: 'AppCell', useSQLite: true } }, d1Databases: ['PNEUMA_SPACE_DB'], r2Buckets: ['PNEUMA_SPACE_ARTIFACTS', 'PNEUMA_SPACE_OBJECTS'], serviceBindings: {TEST_TRIGGER: 'held-trigger'}, bindings: {PNEUMA_SPACE_CONTROL_ORIGIN: 'http://test'} },
    { name: 'held-trigger', modules: true, script: triggerWorker, compatibilityDate: '2026-11-13' },
  ] }));
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  const schema = await readFile(new URL('../schema.sql', import.meta.url).pathname, 'utf8');
  await db.exec(schema.replace(/\n/g, ' '));
  await db.prepare("INSERT INTO users(id,username,name,key_hash,platform_admin,created_at) VALUES('owner','owner','Owner','key',1,1)").run();
  await db.prepare("INSERT INTO tenants(id,name,created_at) VALUES('tenant','Tenant',1)").run();
  await db.prepare("INSERT INTO sessions(hash,user_id,csrf,created_at,expires_at) VALUES('test-session','owner','test-csrf',1,?)").bind(Date.now() + 3600000).run();
});
after(async () => { await mf?.dispose(); if (triggerServer) {triggerServer.closeAllConnections(); await new Promise<void>(resolve => triggerServer.close(() => resolve()));} });
test('CF-07 upload retry recovers a committed release before the generic receipt was saved', async () => {
  const { app } = await fixture(), uploadId = 'up_' + crypto.randomUUID();
  const snapshot = await (await call(app, '/inspect')).json() as { generation: number };
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare('INSERT INTO uploads(id,app_id,actor_hash,digest,bytes,manifest_json,generation,object_key,created_at,expires_at,ticket_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(uploadId, app, actor.hash, digest, Buffer.byteLength(packageBytes), JSON.stringify(manifest), snapshot.generation, 'apps/' + app + '/uploads/' + uploadId, Date.now(), Date.now() + 60000, Date.now() + 60000).run();
  const body = { actor, uploadId, idempotencyKey: 'upload-retry' };
  assert.equal((await call(app, '/publish-upload', body)).status, 200);
  await call(app, '/test/forget-receipt', { key: body.idempotencyKey });
  const retried = await call(app, '/publish-upload', body);
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await retried.json() as { releases: unknown[] }).releases.length, 2);
  assert.equal((await call(app, '/publish-upload', { ...body, uploadId: 'different' })).status, 409);
});
test('CF-07 publication retry creates one release in the durable journal', async () => {
  const { app, artifact } = await fixture();
  const response = await call(app, '/publish', { actor, artifact, expectedGeneration: 0, idempotencyKey: 'publish' });
  assert.equal(response.status, 200);
  const snapshot = await response.json() as { releases: unknown[] };
  assert.equal(snapshot.releases.length, 1);
});
test('CF-10 remove retains the artifact and resume restores the release', async () => {
  const { app, artifact } = await fixture();
  assert.equal((await call(app, '/action', { actor, action: { type: 'remove' }, idempotencyKey: 'remove' })).status, 200);
  const removed = await (await call(app, '/inspect')).json() as { status: string };
  assert.equal(removed.status, 'removed');
  const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS') as unknown as R2Bucket;
  assert.equal(await (await bucket.get(artifact.key))!.text(), packageBytes);
  assert.equal((await call(app, '/action', { actor, action: { type: 'resume' }, idempotencyKey: 'resume' })).status, 200);
  const resumed = await (await call(app, '/inspect')).json() as { status: string; current: { digest: string } };
  assert.equal(resumed.status, 'registered');
  assert.equal(resumed.current.digest, artifact.digest);
});
test('CF-09 broker rejects absent or retired execution scope before mutation', async () => {
  const { app } = await fixture();
  for (const scope of [undefined, { appId: app, generation: -1, bootId: 'old' }]) {
    const response = await call(app, '/broker', { scope, command: { type: 'kv.put', key: 'stale', value: true } });
    assert.equal(response.status, 409);
  }
  const response = await call(app, '/inspect');
  assert.equal((await response.json() as { current: { digest: string } }).current.digest, digest);
});
test('CF-10 purge requires removed status and exact application name', async () => {
  const { app } = await fixture();
  assert.equal((await call(app, '/action', { actor, action: { type: 'purge', confirmation: app }, idempotencyKey: 'early' })).status, 409);
  await call(app, '/action', { actor, action: { type: 'remove' }, idempotencyKey: 'remove' });
  assert.equal((await call(app, '/action', { actor, action: { type: 'purge', confirmation: 'wrong' }, idempotencyKey: 'wrong' })).status, 409);
});
test('CF-20 diagnostic reads do not change the last access or runtime counters', async () => {
  const { app } = await fixture();
  const before = await (await call(app, '/inspect')).json() as { lastAccessAt: number | null; usage: unknown };
  for (const path of ['/logs', '/events', '/usage', '/jobs', '/inspect/state']) assert.equal((await call(app, path)).status, 200);
  const after = await (await call(app, '/inspect')).json() as typeof before;
  assert.equal(after.lastAccessAt, before.lastAccessAt);
  assert.deepEqual(after.usage, before.usage);
});

test('CF-09 upload from a retired generation cannot activate after remove and resume', async () => {
  const { app, artifact } = await fixture();
  const old = await (await call(app, '/inspect')).json() as { generation: number };
  await call(app, '/action', { actor, action: { type: 'remove' }, idempotencyKey: 'remove' });
  await call(app, '/action', { actor, action: { type: 'resume' }, idempotencyKey: 'resume' });
  const response = await call(app, '/publish', { actor, artifact, expectedGeneration: old.generation, idempotencyKey: 'stale-upload' });
  assert.equal(response.status, 409);
  const snapshot = await (await call(app, '/inspect')).json() as { releases: unknown[] };
  assert.equal(snapshot.releases.length, 1);
});
test('CF-10 completed purge keeps a terminal tombstone and deletes artifacts', async () => {
  const { app, artifact } = await fixture();
  await call(app, '/action', { actor, action: { type: 'remove' }, idempotencyKey: 'remove' });
  const purged = await call(app, '/action', { actor, action: { type: 'purge', confirmation: app }, idempotencyKey: 'purge' });
  assert.equal(purged.status, 200, await purged.text());
  const snapshot = await (await call(app, '/inspect')).json() as { status: string; current: unknown };
  assert.equal(snapshot.status, 'purged');
  assert.equal(snapshot.current, null);
  const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS') as unknown as R2Bucket;
  assert.equal(await bucket.get(artifact.key), null);
  const response = await call(app, '/broker', { scope: { appId: app, generation: 0, bootId: 'retired' }, command: { type: 'kv.put', key: 'late', value: true } });
  assert.equal(response.status, 409);
});
test('CF-07 unavailable Container restores the previous release after activation fails', async () => {
  const { app, artifact } = await fixture();
  const old = await (await call(app, '/inspect')).json() as { generation: number };
  const nextManifest = { contract: 'pneuma-space.cf/1', runtime: 'node', entry: 'main.mjs', capabilities: {} };
  const bytes = JSON.stringify({ manifest: nextManifest, files: [{ path: 'main.mjs', body: Buffer.from('process.exit(1)').toString('base64'), contentType: 'text/javascript' }] });
  const nextDigest = createHash('sha256').update(bytes).digest('hex');
  const key = 'apps/' + app + '/artifacts/' + nextDigest + '/package.json';
  const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS') as unknown as R2Bucket;
  await bucket.put(key, bytes);
  const response = await call(app, '/publish', { actor, expectedGeneration: old.generation, idempotencyKey: 'failed-start', artifact: { manifest: nextManifest, digest: nextDigest, bytes: Buffer.byteLength(bytes), key } });
  assert.equal(response.status, 503);
  const restored = await (await call(app, '/inspect')).json() as { current: { digest: string }; releases: unknown[] };
  assert.equal(restored.current.digest, artifact.digest);
  assert.equal(restored.releases.length, 1);
});

test('CF-20 application policy cannot exceed the tenant storage allocation', async () => {
  const { app } = await fixture();
  const response = await call(app, '/action', { actor, action: { type: 'policy', policy: { storageBytes: 1000000000 } }, idempotencyKey: 'over-quota' });
  assert.equal(response.status, 409);
  const snapshot = await (await call(app, '/inspect')).json() as { policy: { storageBytes: number } };
  assert.equal(snapshot.policy.storageBytes, DEFAULT_POLICY.storageBytes);
});

test('CF-11 purge waits for package upload expiry and the alarm removes late staging bytes', async () => {
  const { app, artifact } = await fixture();
  const now = Date.now();
  const expires = now + 300;
  const key = 'apps/' + app + '/uploads/late.json';
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare('INSERT INTO uploads(id,app_id,actor_hash,digest,bytes,manifest_json,generation,object_key,created_at,expires_at,ticket_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .bind('late_' + app, app, actor.hash, digest, Buffer.byteLength(packageBytes), JSON.stringify(manifest), 1, key, now, now + 600000, expires).run();
  await call(app, '/action', { actor, action: { type: 'remove' }, idempotencyKey: 'remove' });
  const response = await call(app, '/action', { actor, action: { type: 'purge', confirmation: app }, idempotencyKey: 'purge' });
  assert.equal(response.status, 200);
  const pending = await response.json() as { pending: boolean; retryAt: number };
  assert.equal(pending.pending, true);
  assert.equal(pending.retryAt, expires + 2000);
  assert.equal((await (await call(app, '/inspect')).json() as { status: string }).status, 'purging');
  const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS') as unknown as R2Bucket;
  await bucket.put(key, 'late upload');
  assert.ok(await bucket.get(artifact.key));
  let status = 'purging';
  for (const deadline = Date.now() + 8000; Date.now() < deadline && status !== 'purged';) {
    await new Promise(resolve => setTimeout(resolve, 100));
    status = (await (await call(app, '/inspect')).json() as { status: string }).status;
  }
  assert.equal(status, 'purged');
  assert.equal(await bucket.get(key), null);
  assert.equal(await bucket.get(artifact.key), null);
  const row = await db.prepare('SELECT purged_at FROM apps WHERE id=?').bind(app).first<{ purged_at: number | null }>();
  assert.ok(row?.purged_at);
});

test('CF-13 remove cancels a held trigger without waiting for its response and late completion stays cancelled', async () => {
  const { app } = await fixture();
  await call(app, '/test/configure-cron', {});
  const created = await call(app, '/jobs', {actor, name: 'tick', payload: null, idempotencyKey: 'held-job'});
  assert.equal(created.status, 200);
  let started = false;
  for (const deadline = Date.now() + 5000; Date.now() < deadline && !started;) {
    started = (await (await call(app, '/test/trigger/started')).json() as {started: boolean}).started;
    if (!started) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(started, 'The trigger must hold an actual Worker response body.');
  const removal = call(app, '/action', {actor, action: {type: 'remove'}, idempotencyKey: 'remove-held'});
  const result = await Promise.race([removal, new Promise<null>(resolve => setTimeout(() => resolve(null), 1000))]);
  await call(app, '/test/trigger/release', {});
  await removal;
  assert.ok(result, 'Remove must finish while the trigger response is still held.');
  assert.equal(result.status, 200);
  let pending = 1;
  for (const deadline = Date.now() + 5000; Date.now() < deadline && pending;) {
    pending = (await (await call(app, '/test/deliveries')).json() as {pending: number}).pending;
    if (pending) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(pending, 0, 'The retired delivery must finish before its persisted state is checked.');
  const snapshot = await (await call(app, '/inspect')).json() as {status: string};
  assert.equal(snapshot.status, 'removed');
  const jobs = await (await call(app, '/jobs')).json() as {items: {state: string; attempts: number}[]};
  assert.deepEqual(jobs.items.map(job => ({state: job.state, attempts: job.attempts})), [{state: 'cancelled', attempts: 1}]);
});

test('CF-14 browser subscriptions survive sleep while execution subscriptions retire with their boot', async () => {
  const { app } = await fixture();
  await call(app, '/test/configure-kv', {boot: true});
  const snapshot = await (await call(app, '/inspect')).json() as {generation: number; runtime: {bootId: string}};
  const browserResponse = await call(app, '/subscribe/changes', undefined, {upgrade: 'websocket', 'x-pneuma-space-actor': encodeURIComponent(JSON.stringify(actor))});
  assert.equal(browserResponse.status, 101);
  const browser = browserResponse.webSocket!; browser.accept();
  const nodeResponse = await call(app, '/scoped-subscribe/changes', undefined, {upgrade: 'websocket', 'x-pneuma-space-scope': JSON.stringify({appId: app, generation: snapshot.generation, bootId: snapshot.runtime.bootId})});
  assert.equal(nodeResponse.status, 101);
  const node = nodeResponse.webSocket!; node.accept();
  const retired = new Promise<void>(resolve => node.addEventListener('close', () => resolve(), {once: true}));
  const message = new Promise<unknown>(resolve => browser.addEventListener('message', event => resolve(JSON.parse(String(event.data))), {once: true}));
  assert.equal((await call(app, '/action', {actor, action: {type: 'sleep'}, idempotencyKey: 'sleep-subscribers'})).status, 200);
  await retired;
  assert.equal(browser.readyState, 1);
  const published = await call(app, '/data', {actor, command: {type: 'kv.publish', channel: 'changes', value: {saved: true}}});
  assert.equal(published.status, 200);
  assert.deepEqual(await message, {saved: true});
  browser.close();
});
test('CF-04 native subscribers revalidate sessions and tokens without waking Node', async () => {
  const { app } = await fixture();
  await call(app, '/test/configure-kv', {});
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  const sessionHash = 'session_' + app, tokenHash = 'token_' + app;
  await db.prepare("INSERT INTO memberships(tenant_id,user_id,role) VALUES('tenant','owner','admin') ON CONFLICT DO NOTHING").run();
  await db.prepare("INSERT INTO sessions(hash,user_id,csrf,created_at,expires_at) VALUES(?,'owner','subscriber',1,?)").bind(sessionHash, Date.now() + 60000).run();
  await db.prepare("INSERT INTO tokens(id,hash,tenant_id,user_id,label,scopes_json,app_ids_json,expires_at,created_at) VALUES(?,?,'tenant','owner','subscriber','[\"invoke\"]',?,?,1)").bind(tokenHash, tokenHash, JSON.stringify([app]), Date.now() + 60000).run();
  const actors = [{...actor, hash: sessionHash}, {kind: 'token', hash: tokenHash, user: actor.user, tenantId: 'tenant', scopes: ['invoke'], appIds: [app]}];
  const sockets: LocalWebSocket[] = [];
  const closes: Promise<void>[] = [];
  for (const subscriber of [...actors, actor]) {
    const response = await call(app, '/subscribe/changes', undefined, {upgrade: 'websocket', 'x-pneuma-space-actor': encodeURIComponent(JSON.stringify(subscriber))});
    assert.equal(response.status, 101);
    const socket = response.webSocket!; socket.accept(); sockets.push(socket);
    if (subscriber !== actor) closes.push(new Promise<void>(resolve => socket.addEventListener('close', () => {socket.close(); resolve();}, {once: true})));
  }
  await db.prepare('UPDATE sessions SET revoked_at=? WHERE hash=?').bind(Date.now(), sessionHash).run();
  await db.prepare('UPDATE tokens SET revoked_at=? WHERE hash=?').bind(Date.now(), tokenHash).run();
  const message = new Promise<unknown>(resolve => sockets[2].addEventListener('message', event => resolve(JSON.parse(String(event.data))), {once: true}));
  await new Promise(resolve => setTimeout(resolve, 15500));
  const published = await call(app, '/data', {actor, command: {type: 'kv.publish', channel: 'changes', value: 'after-revocation'}});
  assert.deepEqual(await published.json(), {subscribers: 1});
  assert.equal(await message, 'after-revocation');
  let timer: ReturnType<typeof setTimeout>;
  await Promise.race([Promise.all(closes), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Subscriber authorization alarm did not close revoked credentials.')), 30000);})]).finally(() => clearTimeout(timer));
  assert.ok(sockets.slice(0, 2).every(socket => socket.readyState !== 1));
  assert.equal(sockets[2].readyState, 1);
  sockets[2].close();
  const snapshot = await (await call(app, '/inspect')).json() as {usage: {wakes: number}};
  assert.equal(snapshot.usage.wakes, 0);
});

test('CF-20 static admission charges the app quota without waking Node', async () => {
  const { app } = await fixture();
  const snapshot = await (await call(app, '/inspect')).json() as {generation: number};
  await call(app, '/action', {actor, action: {type: 'policy', policy: {requestsPerDay: 1}}, idempotencyKey: 'limit'});
  assert.equal((await call(app, '/admit', {expectedGeneration: snapshot.generation})).status, 204);
  assert.equal((await call(app, '/admit', {expectedGeneration: snapshot.generation})).status, 429);
  const after = await (await call(app, '/inspect')).json() as {usage: {requests: number; wakes: number}};
  assert.equal(after.usage.requests, 1);
  assert.equal(after.usage.wakes, 0);
});
test('CF-09 retired static admission neither serves nor consumes request quota', async () => {
  const { app } = await fixture();
  const snapshot = await (await call(app, '/inspect')).json() as {generation: number};
  await call(app, '/action', {actor, action: {type: 'remove'}, idempotencyKey: 'remove'});
  await call(app, '/action', {actor, action: {type: 'resume'}, idempotencyKey: 'resume'});
  assert.equal((await call(app, '/admit', {expectedGeneration: snapshot.generation})).status, 409);
  const after = await (await call(app, '/inspect')).json() as {usage: {requests: number}};
  assert.equal(after.usage.requests, 0);
});
test('CF-20 native subscriptions share the app request budget with static admission', async () => {
  const { app } = await fixture();
  await call(app, '/test/configure-kv', {});
  await call(app, '/action', {actor, action: {type: 'policy', policy: {requestsPerDay: 1}}, idempotencyKey: 'limit'});
  const first = await call(app, '/subscribe/changes', undefined, {upgrade: 'websocket', 'x-pneuma-space-actor': encodeURIComponent(JSON.stringify(actor))});
  assert.equal(first.status, 101);
  first.webSocket!.accept();
  const snapshot = await (await call(app, '/inspect')).json() as {generation: number};
  assert.equal((await call(app, '/admit', {expectedGeneration: snapshot.generation})).status, 429);
  const second = await call(app, '/subscribe/changes', undefined, {upgrade: 'websocket', 'x-pneuma-space-actor': encodeURIComponent(JSON.stringify(actor))});
  assert.equal(second.status, 429);
  first.webSocket!.close();
});
test('CF-25 a sleeping Node app answers its static index without waking', async () => {
  const { app } = await fixture();
  await call(app, '/test/configure-kv', {});
  const bucket = await mf.getR2Bucket('PNEUMA_SPACE_ARTIFACTS') as unknown as R2Bucket;
  await bucket.put('apps/' + app + '/artifacts/' + digest + '/static/index.html', 'Shell', { httpMetadata: { contentType: 'text/html' } });
  const session = crypto.randomUUID().replaceAll('-', '').repeat(2);
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare("INSERT INTO sessions(hash,user_id,csrf,created_at,expires_at) VALUES(?,'owner','csrf',1,?)").bind(createHash('sha256').update(session).digest('hex'), Date.now() + 3600000).run();
  const page = await mf.dispatchFetch('http://test/apps/' + app + '/', { headers: { cookie: '__Host-pneuma-space-control=' + session } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'Shell');
  const snapshot = await (await call(app, '/inspect')).json() as { runtime: { bootId: string | null }; usage: { requests: number; wakes: number } };
  assert.deepEqual([snapshot.runtime.bootId, snapshot.usage.wakes, snapshot.usage.requests], [null, 0, 1]);
});
async function requestWake() {
  const { app } = await fixture();
  await call(app, '/test/configure-kv', {});
  await call(app, '/test/runner', {});
  assert.equal(await (await call(app, '/_pneuma-space/invoke/')).text(), 'woken');
  return app;
}
test('CF-28 a request wake records the duration of each phase in the app detail', async () => {
  const app = await requestWake();
  const { wake, runtime } = await (await call(app, '/inspect')).json() as { runtime: { bootId: string }; wake: { bootId: string; outcome: string; error: null; phases: Record<string, number | null> } };
  assert.deepEqual([wake.bootId, wake.outcome, wake.error], [runtime.bootId, 'ready', null]);
  assert.deepEqual(Object.keys(wake.phases), [...WAKE_PHASES]);
  assert.deepEqual([wake.phases.fetch, wake.phases.unpack, wake.phases.listen], [30, 4, 12]);
  for (const phase of ['reserve', 'container', 'confirm', 'respond']) assert.equal(typeof wake.phases[phase], 'number', phase);
});
test('CF-28 each wake appends an event carrying its record', async () => {
  const app = await requestWake();
  const { runtime } = await (await call(app, '/inspect')).json() as { runtime: { bootId: string } };
  const events = await (await call(app, '/events')).json() as { items: { type: string; data?: { bootId: string; outcome: string } }[] };
  assert.deepEqual(events.items.filter(event => event.type === 'wake-ready').map(event => [event.data?.bootId, event.data?.outcome]), [[runtime.bootId, 'ready']]);
});

async function expiries(app: string): Promise<{ user_id: string; result: string; detail: string }[]> {
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  return (await db.prepare("SELECT user_id,result,detail FROM audit WHERE app_id=? AND action='app.expire' ORDER BY at,id").bind(app).all<{ user_id: string; result: string; detail: string }>()).results;
}
async function until(check: () => Promise<boolean>, what: string) {
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail(what);
}
test('CF-29 an ephemeral app ends itself at its expiry with no caller, audited as the platform', async () => {
  const { app } = await fixture(Date.now() + 1500);
  await until(async () => (await (await call(app, '/inspect')).json() as { status: string }).status === 'purged', 'The app did not end at its expiry.');
  assert.deepEqual((await expiries(app)).map(row => [row.user_id, row.result]), [['platform', 'started'], ['platform', 'ok']]);
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  assert.ok((await db.prepare('SELECT purged_at FROM apps WHERE id=?').bind(app).first<{ purged_at: number | null }>())?.purged_at);
});
test('CF-29 an expiry that keeps failing writes one error row until its outcome changes, then resumes to the end', async () => {
  const { app } = await fixture(Date.now() + 1500);
  await call(app, '/test/fail-purge', { fail: true });
  await until(async () => (await expiries(app)).some(row => row.result === 'error'), 'The failed end was not audited.');
  await call(app, '/test/alarm');
  await call(app, '/test/alarm');
  assert.deepEqual((await expiries(app)).map(row => row.result), ['started', 'error']);
  await call(app, '/test/fail-purge', { fail: false });
  await call(app, '/test/alarm');
  const rows = await expiries(app);
  assert.deepEqual([rows.map(row => row.result), JSON.parse(rows[2].detail).resumed], [['started', 'error', 'ok'], true]);
  assert.equal((await (await call(app, '/inspect')).json() as { status: string }).status, 'purged');
});
test('CF-29 an expiry whose audit row cannot be written still ends the app', async () => {
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  await db.prepare("CREATE TRIGGER audit_down BEFORE INSERT ON audit WHEN NEW.action='app.expire' AND NEW.result='started' BEGIN SELECT RAISE(ABORT, 'audit down'); END").run();
  try {
    const { app } = await fixture(Date.now() + 1500);
    await until(async () => (await (await call(app, '/inspect')).json() as { status: string }).status === 'purged', 'The app did not end at its expiry.');
  } finally { await db.prepare('DROP TRIGGER audit_down').run(); }
});
test('CF-29 an end the directory failed to record reaches it on a later alarm', async () => {
  const db = await mf.getD1Database('PNEUMA_SPACE_DB');
  const purgedAt = async (app: string) => (await db.prepare('SELECT purged_at FROM apps WHERE id=?').bind(app).first<{ purged_at: number | null }>())?.purged_at ?? null;
  await db.prepare("CREATE TRIGGER directory_down BEFORE UPDATE OF purged_at ON apps WHEN NEW.purged_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'directory down'); END").run();
  let app = '';
  try {
    ({ app } = await fixture(Date.now() + 1500));
    await until(async () => (await (await call(app, '/inspect')).json() as { status: string }).status === 'purged', 'The app did not end at its expiry.');
    await call(app, '/test/alarm');
  } finally { await db.prepare('DROP TRIGGER directory_down').run(); }
  assert.equal(await purgedAt(app), null);
  await call(app, '/test/alarm');
  assert.ok(await purgedAt(app));
});
test('CF-29 an ephemeral app schedules no trigger while a manual job still runs', async () => {
  const { app } = await fixture(Date.now() + 600000);
  await call(app, '/test/configure-schedule', {});
  await call(app, '/action', { actor, action: { type: 'remove' }, idempotencyKey: 'remove' });
  await call(app, '/action', { actor, action: { type: 'resume' }, idempotencyKey: 'resume' });
  assert.deepEqual(await (await call(app, '/test/schedules')).json(), {});
  const job = await call(app, '/jobs', { actor, name: 'tick', payload: null, idempotencyKey: 'manual' });
  assert.equal(job.status, 200);
  assert.equal((await job.json() as { name: string }).name, 'tick');
});
