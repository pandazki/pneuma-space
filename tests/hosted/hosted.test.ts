import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import {
  admin, appLogin, appOrigin, bearer, bundle, call, control, cookie, credential, deploy, echo, firstEvent, fixture, image, json,
  login, logout, publish, record, rows, string, unique, visit, waitFor, websocket, type Session,
} from './harness.ts';

let alice: Session;
let bob: Session;
let operator: Session;
const container = (capabilities: Record<string, unknown> = {}) => ({ image, manifest: { contract: 1, capabilities } });
const staticManifest = { contract: 1, capabilities: { static: { dir: '.' } } };

before(async () => {
  [alice, bob, operator] = await Promise.all(['alice', 'bob', 'operator'].map(login));
  execFileSync('docker', ['build', '-q', '-t', image, fixture('echo')], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (process.env.PNEUMA_SPACE_HOSTED_TEST_REGISTRY) execFileSync('docker', ['push', image], { stdio: ['ignore', 'pipe', 'pipe'] });
});
after(async () => {
  await Promise.all([alice, bob, operator].filter(Boolean).map(logout));
  execFileSync('docker', ['rmi', image], { stdio: ['ignore', 'pipe', 'pipe'] });
});

test('AC-SAAS-4 control writes require the exact Origin and CSRF', async (t) => {
  const path = `/api/tenants/${alice.tenant}/tokens`;
  const body = JSON.stringify({ kind: 'personal', label: unique() });
  for (const headers of [
    { cookie: alice.cookie },
    { cookie: alice.cookie, origin: 'http://attacker.localhost', 'x-pneuma-space-csrf': alice.csrf },
    { cookie: alice.cookie, origin: control.origin, 'x-pneuma-space-csrf': 'incorrect' },
  ]) assert.equal((await call(new URL(path, control), 'POST', { 'content-type': 'application/json', ...headers }, body)).status, 403);
  await credential(t, alice);
});

test('AC-SAAS-5 private app grants are browser-bound and single-use', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: staticManifest, bundle: await bundle(alice, fixture('static-site')) });
  const start = await call(`${appOrigin(app.name)}/_pneuma-space/login?next=%2F`);
  assert.equal(start.status, 303);
  const nonce = cookie(start, 'pneuma-space-nonce');
  const grant = await call(string(start.headers.location), 'GET', { cookie: alice.cookie });
  assert.equal(grant.status, 303);
  const completion = string(grant.headers.location);
  assert.equal((await call(completion, 'GET', { cookie: 'pneuma-space-nonce=wrong' })).status, 401);
  const finish = await call(completion, 'GET', { cookie: nonce });
  assert.equal(finish.status, 303);
  assert.equal(finish.headers.location, '/');
  const signed = { cookie: cookie(finish, 'pneuma-space-app'), nonce, completion };
  assert.equal((await call(signed.completion, 'GET', { cookie: signed.nonce })).status, 401);
  const page = await call(appOrigin(app.name), 'GET', { cookie: signed.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /static-site-index/);
  const copied = await call(appOrigin(app.name), 'GET', { cookie: alice.cookie });
  assert.equal(copied.status, 401);
});

test('AC-SAAS-4 logout rejects the next control and derived app session admission', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: staticManifest, bundle: await bundle(alice, fixture('static-site')) });
  const separate = await login('alice');
  const signed = await appLogin(app, separate);
  assert.equal((await call(appOrigin(app.name), 'GET', { cookie: signed.cookie })).status, 200);
  await logout(separate);
  assert.equal((await admin(separate, 'GET', '/api/me')).status, 401);
  assert.equal((await call(appOrigin(app.name), 'GET', { cookie: signed.cookie })).status, 401);
});

test('AC-SAAS-6 another account cannot list or visit a private container application', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, container({ ws: {} }));
  const other = await credential(t, bob);
  const before = record(json(await admin(alice, 'GET', `/api/apps/${app.name}`)));
  assert.equal(record(before.app).access, 'tenant');
  assert.ok(!rows(json(await admin(bob, 'GET', '/api/apps'))).some((row) => row.name === app.name));
  assert.equal((await admin(bob, 'GET', `/api/apps/${app.name}`)).status, 404);
  assert.equal((await visit(app, other.token)).status, 403);
  assert.equal((await websocket(app, bearer(other.token))).status, 403);
  const after = record(json(await admin(alice, 'GET', `/api/apps/${app.name}`)));
  assert.ok(['asleep', 'none'].includes(string(after.instance)));
});

for (const runtime of ['static', 'isolate']) test(`AC-SAAS-6 another account cannot visit a private ${runtime} application`, { timeout: 60_000 }, async (t) => {
  const publication = runtime === 'static'
    ? { image: null, manifest: staticManifest, bundle: await bundle(alice, fixture('static-site')) }
    : { image: null, manifest: JSON.parse(readFileSync(fixture('isolate') + '/pneuma-space.json', 'utf8')), bundle: await bundle(alice, fixture('isolate')) };
  const app = await deploy(t, alice, publication);
  const other = await credential(t, bob);
  const denied = await visit(app, other.token);
  assert.equal(denied.status, 403);
  assert.doesNotMatch(denied.text, /static-site-index/);
  const detail = record(json(await admin(alice, 'GET', `/api/apps/${app.name}`)));
  assert.ok(['asleep', 'none'].includes(string(detail.instance)));
});

test('AC-SAAS-7 a selected-app credential filters reads and rejects another app', { timeout: 60_000 }, async (t) => {
  const first = await deploy(t, alice, container());
  const second = await deploy(t, alice, container());
  assert.equal((await admin(alice, 'PUT', `/api/apps/${first.name}/policy`, { idle_seconds: 600 })).status, 200);
  const scoped = await credential(t, alice, { scopes: ['read', 'invoke'], appIds: [first.id] });
  const api = (path: string) => call(new URL(path, control), 'GET', bearer(scoped.token));
  assert.deepEqual(rows(json(await api('/api/apps'))).map((row) => row.id), [first.id]);
  assert.equal((await api(`/api/apps/${second.name}`)).status, 404);
  assert.equal((await visit(first, scoped.token)).status, 200);
  assert.equal((await visit(second, scoped.token)).status, 403);
  assert.equal((await api(`/api/tenants/${alice.tenant}/quota`)).status, 404);
  const state = record(json(await api(`/api/state?tenant=${alice.tenant}`)));
  assert.deepEqual(rows(state.apps).map((row) => row.app), [first.name]);
  const audit = rows(json(await api(`/api/audit?tenant=${alice.tenant}`)));
  assert.ok(audit.length > 0);
  assert.ok(audit.every((row) => record(row.details).appId === first.id));
});

test('AC-SAAS-7 a read credential cannot invoke, publish, remove or issue credentials', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, container({ ws: {}, files: {}, cron: { triggers: { work: {} } } }));
  const scoped = await credential(t, alice, { scopes: ['read'] });
  const auth = bearer(scoped.token);
  assert.equal((await call(new URL(`/api/apps/${app.name}`, control), 'GET', auth)).status, 200);
  assert.equal((await visit(app, scoped.token)).status, 403);
  assert.equal((await websocket(app, auth)).status, 403);
  assert.equal((await visit(app, scoped.token, '/_pneuma-space/trigger/work', 'POST')).status, 403);
  assert.equal((await call(new URL(`/api/apps/${app.name}/remove`, control), 'POST', auth)).status, 403);
  assert.equal((await call(new URL(`/api/apps/${app.name}/release`, control), 'PUT', { ...auth, 'content-type': 'application/json' }, JSON.stringify(container()))).status, 403);
  assert.equal((await call(new URL(`/api/tenants/${alice.tenant}/tokens`, control), 'POST', { ...auth, 'content-type': 'application/json' }, JSON.stringify({ kind: 'personal' }))).status, 403);
});

test('AC-SAAS-7 credential revocation rejects the next admission', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, container());
  const issued = await credential(t, alice);
  assert.equal((await visit(app, issued.token)).status, 200);
  assert.equal((await admin(alice, 'DELETE', `/api/tenants/${alice.tenant}/tokens/${issued.id}`)).status, 200);
  assert.equal((await visit(app, issued.token)).status, 401);
  assert.equal((await call(new URL('/api/apps', control), 'GET', bearer(issued.token))).status, 401);
});

test('AC-SAAS-7 credential expiry rejects the next admission', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, container());
  const issued = await credential(t, alice, { expiresAt: Date.now() + 1500 });
  assert.equal((await call(new URL('/api/apps', control), 'GET', bearer(issued.token))).status, 200);
  await waitFor(async () => (await call(new URL('/api/apps', control), 'GET', bearer(issued.token))).status === 401, 'credential expiration');
  assert.equal((await visit(app, issued.token)).status, 401);
});

test('AC-SAAS-7 credential metadata exposes neither secret nor hash', async (t) => {
  const issued = await credential(t, alice);
  const reply = await admin(alice, 'GET', `/api/tenants/${alice.tenant}/tokens`);
  assert.equal(reply.status, 200);
  const metadata = rows(json(reply)).find((row) => row.id === issued.id);
  assert.ok(metadata);
  assert.ok(!('hash' in metadata) && !('token' in metadata));
  assert.ok(!reply.text.includes(issued.token));
});

test('AC-SAAS-9 hosted container files and SQLite survive remove and republish', { timeout: 120_000 }, async (t) => {
  const publication = container({ files: {}, db: {} });
  const app = await deploy(t, alice, publication);
  const issued = await credential(t, alice);
  for (const kind of ['files', 'db']) {
    assert.equal((await visit(app, issued.token, `/${kind}/saved`, 'PUT', 'retained')).status, 200);
  }
  assert.equal((await admin(alice, 'POST', `/api/apps/${app.name}/remove`)).status, 200);
  assert.equal((await publish(alice, app.name, publication)).status, 200);
  for (const kind of ['files', 'db']) {
    const reply = await visit(app, issued.token, `/${kind}/saved`);
    assert.equal(reply.status, 200, reply.text);
    assert.equal(record(json(reply)).value, 'retained');
  }
});

test('AC-SAAS-9 hosted container PostgreSQL remains available through the original contract', { timeout: 120_000 }, async (t) => {
  const publication = container({ db: {} });
  const app = await deploy(t, alice, publication);
  const changed = await admin(alice, 'PUT', `/api/apps/${app.name}/policy`, { db_backend: 'postgres' });
  assert.equal(changed.status, 200, changed.text);
  const released = await publish(alice, app.name, publication);
  assert.equal(released.status, 200, released.text);
  const issued = await credential(t, alice);
  const saved = await visit(app, issued.token, '/db/saved', 'PUT', 'postgres-retained');
  assert.equal(saved.status, 200, saved.text);
  const reply = await visit(app, issued.token, '/db/saved');
  assert.equal(reply.status, 200, reply.text);
  assert.equal(record(json(reply)).value, 'postgres-retained');
});

test('AC-SAAS-9 hosted container KV and pubsub remain available through the original contract', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, alice, container({ kv: {} }));
  const issued = await credential(t, alice);
  assert.equal((await visit(app, issued.token, '/kv/saved', 'PUT', 'kv-retained')).status, 200);
  assert.equal(record(json(await visit(app, issued.token, '/kv/saved'))).value, 'kv-retained');
  assert.equal(record(json(await visit(app, issued.token, '/kv-pubsub'))).received, true);
});

test('AC-SAAS-9 hosted object bytes transfer directly with original signed URLs', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, alice, container({ object: {} }));
  const issued = await credential(t, alice);
  const put = record(json(await visit(app, issued.token, '/presign?method=PUT&key=uploads/hosted.txt')));
  const upload = await call(string(put.url), 'PUT', {}, 'hosted-object');
  assert.equal(upload.status, 200, upload.text);
  const get = record(json(await visit(app, issued.token, '/presign?method=GET&key=uploads/hosted.txt')));
  const downloaded = await call(string(get.url));
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.text, 'hosted-object');
  assert.notEqual(new URL(string(get.url)).port, new URL(appOrigin(app.name)).port);
});

test('AC-SAAS-9 hosted WebSockets retain original bidirectional messages', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, container({ ws: {} }));
  const issued = await credential(t, alice);
  const opened = await websocket(app, bearer(issued.token));
  assert.equal(opened.status, 101);
  assert.ok(opened.socket);
  t.after(() => opened.socket?.destroy());
  assert.equal(await echo(opened.socket, 'hosted-websocket'), 'hosted-websocket');
});

test('AC-SAAS-9 hosted on-demand triggers retain the original delivery contract', { timeout: 90_000 }, async (t) => {
  const app = await deploy(t, alice, container({ files: {}, identity: {}, cron: { triggers: { work: {} } } }));
  const issued = await credential(t, alice);
  const invoked = await visit(app, issued.token, '/_pneuma-space/trigger/work', 'POST', 'hosted-trigger');
  assert.equal(invoked.status, 202, invoked.text);
  const delivery = string(record(json(invoked)).delivery);
  const run = await waitFor(async () => {
    const reply = await visit(app, issued.token, '/deliveries');
    if (reply.status !== 200) return null;
    return rows(json(reply)).find((row) => row.delivery === delivery) ?? null;
  }, 'trigger delivery');
  assert.equal(run.body, 'hosted-trigger');
  assert.equal(run.subject, alice.subject);
});

test('AC-SAAS-9 hosted isolate files and SQLite retain the original application contract', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: JSON.parse(readFileSync(fixture('isolate') + '/pneuma-space.json', 'utf8')), bundle: await bundle(alice, fixture('isolate')) });
  const issued = await credential(t, alice);
  const saved = await visit(app, issued.token, '/note', 'PUT', 'hosted-isolate');
  assert.equal(saved.status, 200, saved.text);
  const reply = await visit(app, issued.token, '/note');
  assert.equal(reply.status, 200, reply.text);
  assert.deepEqual(json(reply), { file: 'hosted-isolate', rows: ['hosted-isolate'] });
});

test('AC-SAAS-10 operator monitoring remains available and signup grants no operator role', async () => {
  const me = record(json(await admin(alice, 'GET', '/api/me')));
  assert.equal(me.platformAdmin, false);
  for (const path of ['/api/metrics', '/api/requests', '/api/cluster']) {
    const operational = await admin(operator, 'GET', path);
    assert.equal(operational.status, 200, `${path}: ${operational.text.slice(0, 200)}`);
    assert.equal((await admin(alice, 'GET', path)).status, 403, path);
  }
  const metrics = record(json(await admin(operator, 'GET', '/api/metrics')));
  assert.ok(typeof record(metrics.gateway).rssBytes === 'number');
  assert.ok(Array.isArray(record(metrics.series).requests));
  assert.equal((await admin(operator, 'GET', '/api/health')).status, 200);
});

test('AC-SAAS-13 hosted application receives identity without platform credentials', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, container({ identity: {} }));
  const issued = await credential(t, alice);
  const reply = await call(`${appOrigin(app.name)}/headers`, 'GET', { ...bearer(issued.token), cookie: `${alice.cookie}; application=kept`, 'x-pneuma-space-subject': 'spoofed' });
  assert.equal(reply.status, 200, reply.text);
  const headers = record(json(reply));
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, 'application=kept');
  assert.equal(headers['x-pneuma-space-subject'], alice.subject);
});

test('AC-SAAS-11 hosted purge requires the exact removed application name', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, container());
  assert.equal((await admin(alice, 'POST', `/api/apps/${app.name}/remove`)).status, 200);
  const denied = await admin(alice, 'POST', `/api/apps/${app.name}/purge`, { confirm: 'wrong-name' });
  assert.equal(denied.status, 400, denied.text);
  assert.equal((await admin(alice, 'GET', `/api/apps/${app.name}`)).status, 200);
});

const streamDirectory = fileURLToPath(new URL('./fixtures/stream/', import.meta.url));
const streamPublication = async () => ({ image: null, manifest: JSON.parse(readFileSync(streamDirectory + 'pneuma-space.json', 'utf8')), bundle: await bundle(alice, streamDirectory) });

test('AC-SAAS-9 hosted SSE delivers before the stream closes', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, await streamPublication());
  const signed = await appLogin(app);
  assert.equal(await firstEvent(app, { cookie: signed.cookie }), `data: ${alice.subject}`);
});

test('AC-SAAS-13 hosted application cannot set reserved platform cookies', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, await streamPublication());
  const issued = await credential(t, alice);
  const reply = await visit(app, issued.token, '/cookies');
  assert.equal(reply.status, 200, reply.text);
  assert.deepEqual(reply.headers['set-cookie'], ['application=kept; Path=/']);
});

test('AC-SAAS-9 hosted scheduled triggers retain the original delivery contract', { timeout: 90_000 }, async (t) => {
  const app = await deploy(t, alice, container({ files: {}, cron: { triggers: { minutely: { schedule: '* * * * *' } } } }));
  const issued = await credential(t, alice);
  const delivered = await waitFor(async () => {
    const reply = await admin(alice, 'GET', `/api/apps/${app.name}`);
    return rows(record(json(reply)).deliveries).find((row) => row.trigger === 'minutely' && row.state === 'done') ?? null;
  }, 'scheduled hosted delivery', 75_000);
  assert.ok(typeof delivered.scheduledFor === 'number');
  const runs = rows(json(await visit(app, issued.token, '/deliveries')));
  assert.ok(runs.some((run) => run.delivery === delivered.id && run.trigger === 'minutely'));
});

test('AC-SAAS-9 hosted RTC injects the original ICE configuration', { timeout: 60_000, skip: process.env.PNEUMA_SPACE_HOSTED_TEST_RTC !== 'true' && 'enable the hosted RTC profile and PNEUMA_SPACE_HOSTED_TEST_RTC=true' }, async (t) => {
  const app = await deploy(t, alice, container({ rtc: {} }));
  const issued = await credential(t, alice);
  const reply = await visit(app, issued.token, '/ice');
  assert.equal(reply.status, 200, reply.text);
  const ice = rows(record(json(reply)).iceServers);
  assert.equal(ice.length, 2);
  assert.ok(typeof ice[1]?.username === 'string' && typeof ice[1]?.credential === 'string');
});

test('AC-SAAS-4 application cookies require the exact Origin for writes and WebSockets', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, container({ files: {}, ws: {} }));
  const signed = await appLogin(app);
  for (const headers of [{ cookie: signed.cookie }, { cookie: signed.cookie, origin: 'http://other.apps.localhost:58080' }]) {
    assert.equal((await call(`${appOrigin(app.name)}/files/origin`, 'PUT', headers, 'denied')).status, 403);
    assert.equal((await websocket(app, headers)).status, 403);
  }
  const headers = { cookie: signed.cookie, origin: appOrigin(app.name) };
  const saved = await call(`${appOrigin(app.name)}/files/origin`, 'PUT', headers, 'same-origin');
  assert.equal(saved.status, 200, saved.text);
  assert.equal(record(json(await call(`${appOrigin(app.name)}/files/origin`, 'GET', headers))).value, 'same-origin');
  const opened = await websocket(app, headers);
  assert.equal(opened.status, 101);
  assert.ok(opened.socket);
  try { assert.equal(await echo(opened.socket, 'same-origin'), 'same-origin'); }
  finally { opened.socket.destroy(); }
});

test('AC-SAAS-7 a recreated name does not inherit an old AppId credential', { timeout: 60_000 }, async (t) => {
  const publication = container();
  const app = await deploy(t, alice, publication);
  const issued = await credential(t, alice, { scopes: ['read', 'invoke'], appIds: [app.id] });
  assert.equal((await visit(app, issued.token)).status, 200);
  assert.equal((await admin(alice, 'POST', `/api/apps/${app.name}/remove`)).status, 200);
  assert.equal((await admin(alice, 'POST', `/api/apps/${app.name}/purge`, { confirm: app.name })).status, 200);
  assert.equal((await publish(alice, app.name, publication)).status, 200);
  const detail = record(json(await admin(alice, 'GET', `/api/apps/${app.name}`)));
  assert.notEqual(record(detail.app).id, app.id);
  assert.equal((await call(new URL(`/api/apps/${app.name}`, control), 'GET', bearer(issued.token))).status, 404);
  assert.equal((await visit(app, issued.token)).status, 403);
});

test('AC-SAAS-7 public static admission still enforces a supplied credential scope', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: staticManifest, bundle: await bundle(alice, fixture('static-site')) });
  assert.equal((await admin(alice, 'PUT', `/api/apps/${app.name}/access`, { access: 'public' })).status, 200);
  const issued = await credential(t, alice, { scopes: ['read'] });
  const anonymous = await call(appOrigin(app.name));
  assert.equal(anonymous.status, 200);
  assert.match(anonymous.text, /static-site-index/);
  const denied = await visit(app, issued.token);
  assert.equal(denied.status, 403);
  assert.doesNotMatch(denied.text, /static-site-index/);
});

test('AC-SAAS-8 revocation during real provisioning keeps the prior release and files', {
  skip: process.env.PNEUMA_SPACE_HOSTED_TEST_PAUSE_OBJECTS !== 'true' && 'enable the temporary object-service pause on the hosted development stack',
  timeout: 60_000,
}, async (t) => {
  assert.equal(control.origin, 'http://localhost:58081');
  const app = await deploy(t, alice, container({ files: {} }));
  const token = await credential(t, alice);
  assert.equal((await visit(app, token.token, '/files/saved', 'PUT', 'kept')).status, 200);
  const prior = record(record(json(await admin(alice, 'GET', `/api/apps/${app.name}`))).app).current;
  const objects = 'pneuma-space-hosted-rustfs-1';
  const manifest = { contract: 1, capabilities: { files: {}, kv: {}, object: {} } };
  execFileSync('docker', ['pause', objects], { stdio: 'pipe' });
  let publishing: Promise<import('./harness.ts').Reply> | undefined;
  let completed: import('./harness.ts').Reply | undefined;
  try {
    publishing = call(new URL(`/api/apps/${app.name}/release`, control), 'PUT', {
      ...bearer(token.token), 'content-type': 'application/json',
    }, JSON.stringify({ image, bundle: null, manifest })).then((reply) => { completed = reply; return reply; });
    await waitFor(async () => {
      if (completed) throw new Error(`publish finished before the barrier: ${completed.status} ${completed.text}`);
      const detail = record(json(await admin(alice, 'GET', `/api/apps/${app.name}`)));
      return rows(detail.bindings).some((binding) => binding.kind === 'kv');
    }, 'KV provisioned before blocked object provisioning', 10_000);
    const revoked = await admin(alice, 'DELETE', `/api/tenants/${alice.tenant}/tokens/${token.id}`);
    assert.equal(revoked.status, 200, revoked.text);
  } finally {
    execFileSync('docker', ['unpause', objects], { stdio: 'pipe' });
  }
  assert.ok(publishing);
  const denied = await publishing;
  assert.equal(denied.status, 403, denied.text);
  const detail = record(json(await admin(alice, 'GET', `/api/apps/${app.name}`)));
  assert.equal(record(detail.app).current, prior);
  assert.equal(rows(detail.releases).length, 1);
  const replacement = await credential(t, alice);
  assert.equal(record(json(await visit(app, replacement.token, '/files/saved'))).value, 'kept');
});
