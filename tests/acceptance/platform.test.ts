import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OWNER, adminClient, adminUrl, appJson, appPut, appUrl, bucketExists, cleanup, connect, containerIp, deploy, docker, images, inNetwork,
  median, publish, restartGateway, runningContainerFor, scratch, serviceToken, setIdle, setupSuite, sleep, stack, summary, teardownSuite,
  uniqueName, volumeExists, waitFor, waitInstance,
} from './harness.ts';

before(setupSuite);
after(teardownSuite);

const plain = { image: images.echo, capabilities: {} };

test('AC-P-1', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, plain);
  const first = await appJson(app.name, '/');
  assert.equal(first.prefix, `/apps/${app.name}`);
  const address = (await summary(app.name)).address;
  publish(app.name, { ...plain, image: images.echo2 });
  assert.equal((await summary(app.name)).address, address);
  assert.equal((await appJson(app.name, '/')).variant, '2', 'the same address answers from the new release');
});

test('AC-P-2', { timeout: 60_000 }, async (t) => {
  const caps = { files: {} };
  const app = await deploy(t, { image: images.echo, capabilities: caps });
  await appPut(app.name, '/files/note', 'written-by-release-1');
  assert.equal((await summary(app.name)).release, 1);
  publish(app.name, { image: images.echo2, capabilities: caps });
  assert.equal((await summary(app.name)).release, 2);
  assert.equal((await appJson(app.name, '/files/note')).value, 'written-by-release-1');
  publish(app.name, { image: images.echo2, capabilities: caps });
  assert.equal((await summary(app.name)).release, 2, 'identical inputs publish nothing');
  assert.equal((await adminClient.app(app.name)).body.releases.length, 2);
});

test('AC-P-3', { timeout: 90_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { kv: {} } });
  assert.ok((await appJson(app.name, '/env')).PNEUMA_SPACE_KV_URL);
  await appPut(app.name, '/kv/kept', 'before-removal');
  publish(app.name, { image: images.echo, capabilities: {} });
  const without = await appJson(app.name, '/env');
  assert.equal(without.PNEUMA_SPACE_KV_URL, undefined);
  assert.equal(without.PNEUMA_SPACE_KV_PREFIX, undefined);
  publish(app.name, { image: images.echo, capabilities: { kv: {} } });
  assert.ok((await appJson(app.name, '/env')).PNEUMA_SPACE_KV_URL);
  assert.equal((await appJson(app.name, '/kv/kept')).value, 'before-removal');
});

test('AC-P-4', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { files: {} } });
  await appPut(app.name, '/files/n', 'before-sleep');
  await setIdle(app.name, 2);
  await waitInstance(app.name, 'asleep', 20_000);
  assert.equal(runningContainerFor(app.id), null);
  assert.equal((await appJson(app.name, '/files/n')).value, 'before-sleep');
});

test('AC-P-5', { timeout: 300_000 }, async (t) => {
  const checkout = mkdtempSync(join(scratch, 'pneuma-space-acc-clean-'));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const env = { ...process.env, PNEUMA_SPACE_NETWORK: 'pneuma-space-acc-clean', PNEUMA_SPACE_HTTP_PORT: '18180', PNEUMA_SPACE_ADMIN_PORT: '18181', PNEUMA_SPACE_OBJECT_PORT: '19100' };
  const compose = (...args: string[]) => execFileSync('docker', ['compose', '-p', 'pneuma-space-acc-clean', ...args], { cwd: checkout, env, stdio: 'pipe' });
  t.after(() => {
    compose('down', '-v', '--rmi', 'local');
    rmSync(checkout, { recursive: true, force: true });
  });
  execFileSync('sh', ['-c', `git -C '${repo}' archive HEAD | tar -x -C '${checkout}'`]);
  compose('up', '-d');
  const console = await waitFor(async () => {
    const response = await fetch('http://127.0.0.1:18181/').catch(() => null);
    return response?.ok && response.headers.get('content-type')?.startsWith('text/html') ? response : null;
  }, 120_000, 'the console at 127.0.0.1:18181');
  assert.match(await console.text(), /<html|<!doctype/i);
});

test('AC-P-6', { timeout: 30_000 }, async () => {
  const response = await fetch(adminUrl + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
  const page = await response.text();
  for (const field of ['/api/apps', '/api/metrics', 'leases', 'logs', '/release', '/policy', "act('remove')", "act('purge')", 'releases', 'bindings', 'deliveries', 'requests', 'errors']) {
    assert.ok(page.includes(field), `console has ${field}`);
  }
  assert.doesNotMatch(page, /\/api\/tokens/, 'no token page');
  assert.doesNotMatch(page, /\/api\/policy\b/, 'no global policy page');
  assert.doesNotMatch(page, /\/owner\b/, 'no owner change');
});

test('AC-P-13', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, plain);
  const metrics = async () => (await fetch(adminUrl + '/api/metrics')).json();
  const total = (series: number[]) => series.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < 2; i++) await metrics();
  const since = Date.now() / 1000;
  const timings: number[] = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    await metrics();
    timings.push(performance.now() - start);
  }
  const until = Date.now() / 1000 + 1;
  const events = docker('events', '--since', since.toFixed(3), '--until', until.toFixed(3), '--filter', `label=pneuma-space.network=${stack.network}`, '--format', '{{.Type}} {{.Action}}');
  t.diagnostic(`GET /api/metrics: median ${median(timings).toFixed(1)} ms, all ${timings.map((v) => v.toFixed(1)).join(' ')} ms`);
  assert.ok(median(timings) < 50, `median ${median(timings).toFixed(1)} ms, gate 50 ms`);
  assert.equal(events, '', 'no Docker activity while answering metrics');

  const before = await metrics();
  await appJson(app.name, '/');
  const after = await metrics();
  assert.equal(after.wakes.last24h.count - before.wakes.last24h.count, 1, 'one wake');
  assert.equal(typeof after.events.findLast((e: any) => e.ev === 'awake' && e.app === app.name)?.ms, 'number', 'the wake carries its latency');
  assert.equal(total(after.series.requests) - total(before.series.requests), 1, 'one request');

  const page = await (await fetch(adminUrl + '/')).text();
  for (const section of ['services', 'fleet', 'wakes', 'traffic', 'deliveries', 'host', 'events']) assert.ok(page.includes(`'data-section': '${section}'`), `overview has ${section}`);
  for (const marker of ['zh: {', 'en: {', 'data-theme']) assert.ok(page.includes(marker), `console has ${marker}`);
});

// The browser half (lanes, graph selection, redis stop and start, runner off, unquarantine) is verified by screenshots.
test('AC-P-16', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { db: {} } });
  const health = async () => (await fetch(adminUrl + '/api/health')).json();
  await health();
  const since = Date.now() / 1000;
  const timings: number[] = [];
  let body: any;
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    body = await health();
    timings.push(performance.now() - start);
  }
  const until = Date.now() / 1000 + 1;
  const events = docker('events', '--since', since.toFixed(3), '--until', until.toFixed(3), '--filter', `label=pneuma-space.network=${stack.network}`, '--format', '{{.Type}} {{.Action}}');
  t.diagnostic(`GET /api/health: median ${median(timings).toFixed(1)} ms`);
  assert.ok(median(timings) < 50, `median ${median(timings).toFixed(1)} ms, gate 50 ms`);
  assert.equal(events, '', 'no Docker activity while answering health');
  assert.deepEqual(Object.keys(body.runtimes).sort(), ['container', 'isolate']);
  assert.ok(body.runtimes.container.health.includes('exit') && body.runtimes.isolate.health.includes('hang'), JSON.stringify(body.runtimes));
  assert.equal(body.runtimes.isolate.profile, 'isolate');
  assert.ok(['sqlite', 'postgres'].includes(body.policy.db_backend), JSON.stringify(body.policy));

  const listed = (await (await fetch(adminUrl + '/api/apps')).json()).find((a: any) => a.name === app.name);
  assert.equal(listed.dbBackend, body.policy.db_backend);
});

test('AC-P-14', { timeout: 90_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { ws: {} } });
  await setIdle(app.name, 5);
  const socket = await connect(app.name, '/ws?mode=echo');
  assert.equal((await summary(app.name)).sleepsAt, null, 'null while a channel lease is held');
  const before = Date.now();
  socket.ws.close();
  const sleepsAt = await waitFor(async () => (await summary(app.name)).sleepsAt, 5000, 'sleepsAt after the lease is released');
  const after = Date.now();
  t.diagnostic(`sleepsAt is ${sleepsAt - before} ms after the close was sent`);
  assert.ok(sleepsAt >= before + 5000 && sleepsAt <= after + 5000, 'last release plus idle_seconds');
  await waitInstance(app.name, 'asleep', 20_000);
  assert.ok(Date.now() <= sleepsAt + 10_000, `asleep ${Date.now() - sleepsAt} ms after sleepsAt`);

  const seqs = (await (await fetch(adminUrl + '/api/metrics')).json()).events.map((e: { seq: number }) => e.seq);
  assert.ok(seqs.length > 1 && seqs.every((seq: number, i: number) => i === 0 || seq > seqs[i - 1]), 'seq strictly increases');

  const page = await (await fetch(adminUrl + '/')).text();
  assert.ok(page.includes('data-live'), 'overview has the live indicator');
  for (const section of ['seats', 'timeline', 'attention', 'tail']) assert.ok(page.includes(`'data-section': '${section}'`), `overview has ${section}`);
});

test('AC-P-15', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { files: {}, ws: {}, cron: { triggers: { report: {} } } } });
  const requests = async (after: number) => (await fetch(`${adminUrl}/api/requests?after=${after}&limit=1000`)).json();
  const newer = (after: number, kind: string) => waitFor(async () => (await requests(after)).filter((r: any) => r.app === app.name && r.kind === kind).at(-1), 15_000, `a ${kind} record`);
  const start = (await requests(0)).at(-1)?.seq ?? 0;

  await appJson(app.name, '/');
  const cold = await newer(start, 'request');
  const wake = (await (await fetch(adminUrl + '/api/metrics')).json()).events.findLast((e: any) => e.ev === 'awake' && e.app === app.name);
  assert.ok((await requests(start)).every((r: any) => r.seq > start), 'only records after the cursor');
  assert.equal(cold.cold, true, 'the first request found the app asleep');
  assert.ok(cold.ms >= wake.ms, `ms ${cold.ms} against a wake of ${wake.ms} ms`);

  const since = Date.now() / 1000;
  const timings: number[] = [];
  for (let i = 0; i < 7; i++) {
    const begun = performance.now();
    await requests(0);
    timings.push(performance.now() - begun);
  }
  const until = Date.now() / 1000 + 1;
  const events = docker('events', '--since', since.toFixed(3), '--until', until.toFixed(3), '--filter', `label=pneuma-space.network=${stack.network}`, '--format', '{{.Type}} {{.Action}}');
  t.diagnostic(`GET /api/requests: median ${median(timings).toFixed(1)} ms, all ${timings.map((v) => v.toFixed(1)).join(' ')} ms`);
  assert.ok(median(timings) < 50, `median ${median(timings).toFixed(1)} ms, gate 50 ms`);
  assert.equal(events, '', 'no Docker activity while answering requests');

  const beforeWs = (await requests(0)).at(-1).seq;
  const socket = await connect(app.name, '/ws?mode=echo');
  await sleep(300);
  socket.ws.close();
  await socket.closed;
  const ws = await newer(beforeWs, 'ws');
  assert.equal((await requests(beforeWs)).filter((r: any) => r.app === app.name && r.kind === 'ws').length, 1, 'one ws record');
  assert.ok(ws.status === 101 && ws.ms >= 300, `ws record ${ws.status} ${ws.ms} ms`);

  const beforeTrigger = (await requests(0)).at(-1).seq;
  const invoked = await fetch(appUrl(app.name, '/_pneuma-space/trigger/report'), { method: 'POST', headers: { authorization: `Bearer ${await serviceToken(uniqueName('svc'))}` } });
  assert.equal(invoked.status, 202);
  await newer(beforeTrigger, 'trigger');
  const triggers = (await requests(beforeTrigger)).filter((r: any) => r.app === app.name && r.kind === 'trigger');
  assert.deepEqual(triggers.map((r: any) => [r.status, r.path]), [[200, '/_pneuma-space/trigger/report']], 'one trigger record with the app\'s answer');

  const page = await (await fetch(adminUrl + '/')).text();
  for (const section of ['filter', 'requests', 'realtime-events']) assert.ok(page.includes(`'data-section': '${section}'`), `realtime page has ${section}`);
  assert.ok(page.includes('#/realtime') && page.includes('/api/requests?after='), 'the realtime page polls the request cursor');
  assert.ok(page.includes('const TIMELINE_ROWS = 10;') && page.includes('timeline({ cap: TIMELINE_ROWS })') && page.includes('.splice(cap)'), 'the overview timeline draws at most 10 apps');
});

test('AC-P-7', { timeout: 90_000 }, async (t) => {
  const perApp = await deploy(t, plain);
  const global = await deploy(t, plain);
  await appJson(perApp.name, '/');
  await setIdle(perApp.name, 5);
  await waitInstance(perApp.name, 'asleep', 25_000);

  await appJson(global.name, '/');
  t.after(() => adminClient.setPolicy({ idle_seconds: 60 }));
  assert.ok((await adminClient.setPolicy({ idle_seconds: 5 })).status < 300);
  await waitInstance(global.name, 'asleep', 25_000);
});

test('AC-P-8', { timeout: 900_000 }, async (t) => {
  const names = Array.from({ length: 500 }, (_, i) => `${uniqueName('seed')}-${i}`);
  const batches = async (items: string[], size: number, run: (name: string) => Promise<unknown>) => {
    for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(run));
  };
  t.after(() => batches(names, 20, cleanup));
  await batches(names, 20, async (name) => {
    const reply = await adminClient.publish(name, { image: images.echo, manifest: { contract: 1, capabilities: {} }, owner: OWNER });
    assert.ok(reply.status < 300, `publish ${name}: ${reply.status} ${JSON.stringify(reply.body)}`);
  });
  await batches(names.slice(0, 20), 5, (name) => appJson(name, '/'));
  assert.ok(docker('ps', '-q', '--filter', `label=pneuma-space.network=${stack.network}`).split('\n').length >= 20, '20 apps running');

  // Docker is still settling the 20 wakes; the gate measures the listing, not that.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (let i = 0; i < 2; i++) await fetch(adminUrl + '/api/apps');
  const since = Date.now() / 1000;
  const timings: number[] = [];
  let listed: any[] = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    listed = await (await fetch(adminUrl + '/api/apps')).json();
    timings.push(performance.now() - start);
  }
  const until = Date.now() / 1000 + 1;
  const events = docker('events', '--since', since.toFixed(3), '--until', until.toFixed(3), '--filter', `label=pneuma-space.network=${stack.network}`, '--format', '{{.Type}} {{.Action}}');
  t.diagnostic(`GET /api/apps with ${listed.length} apps: median ${median(timings).toFixed(1)} ms, all ${timings.map((v) => v.toFixed(1)).join(' ')} ms; docker events during listing: ${events.split('\n').filter(Boolean).length}`);
  assert.ok(listed.length >= 500);
  assert.ok(listed.filter((a) => a.instance === 'awake').length >= 20, '20 awake in the listing');
  assert.ok(median(timings) < 100, `median ${median(timings).toFixed(1)} ms, gate 100 ms`);
  assert.equal(events, '', 'no Docker activity while listing');
});

test('AC-P-9', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { files: {}, db: {}, object: {} } });
  await appPut(app.name, '/files/a', 'kept');
  await appPut(app.name, '/db/a', 'kept');
  assert.equal((await adminClient.purge(app.name)).status, 409, 'purge refused while registered');
  assert.equal((await summary(app.name)).status, 'registered');

  assert.ok((await adminClient.remove(app.name)).status < 300);
  assert.equal((await fetch(appUrl(app.name))).status, 404);
  assert.ok(volumeExists(`pneuma-space-files-${app.id}`), 'files volume kept');
  assert.ok(volumeExists(`pneuma-space-db-${app.id}`), 'database kept');
  assert.ok(await bucketExists(`app-${app.id}`), 'bucket kept');

  assert.ok((await adminClient.purge(app.name)).status < 300);
  await waitFor(() => !volumeExists(`pneuma-space-files-${app.id}`) && !volumeExists(`pneuma-space-db-${app.id}`), 30_000, 'volumes deleted by purge');
  assert.equal(await bucketExists(`app-${app.id}`), false, 'bucket deleted by purge');
});

const durable = async (name: string) => {
  const { app, releases, bindings, policy } = (await adminClient.app(name)).body;
  return { app, releases, bindings, policy };
};

test('AC-P-10', { timeout: 180_000 }, async (t) => {
  const worker = await deploy(t, { image: images.echo, capabilities: { files: {}, cron: { triggers: { slow: {} } } } });
  const sleeper = await deploy(t, { image: images.echo, capabilities: { files: {} } });
  await appPut(sleeper.name, '/files/n', 'kept');
  await setIdle(sleeper.name, 2);
  await waitInstance(sleeper.name, 'asleep', 20_000);
  const before = [await durable(worker.name), await durable(sleeper.name)];

  const token = await serviceToken(uniqueName('svc'));
  const invoked = await fetch(appUrl(worker.name, '/_pneuma-space/trigger/slow'), { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(invoked.status, 202);
  const { delivery } = await invoked.json();
  const starts = async () => (await appJson(worker.name, '/deliveries')).filter((d: any) => d.delivery === delivery && d.phase === 'start').length;
  await waitFor(async () => (await starts()) >= 1, 20_000, 'the delivery to start');

  await restartGateway();
  assert.deepEqual([await durable(worker.name), await durable(sleeper.name)], before);
  assert.equal((await appJson(sleeper.name, '/files/n')).value, 'kept', 'sleeping app wakes on request');
  await waitFor(async () => (await starts()) >= 2, 60_000, 'the delivering trigger to re-run');
});

test('TH-cold-start', { timeout: 180_000 }, async (t) => {
  const app = await deploy(t, plain);
  await setIdle(app.name, 2);
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    if (i) await waitInstance(app.name, 'asleep', 30_000);
    const start = performance.now();
    await appJson(app.name, '/');
    samples.push(performance.now() - start);
  }
  t.diagnostic(`cold start: median ${median(samples).toFixed(0)} ms, all ${samples.map((v) => v.toFixed(0)).join(' ')} ms`);
  assert.ok(median(samples) < 3000, `median ${median(samples).toFixed(0)} ms, gate 3000 ms`);
});

const latencyProbe = `
const [direct, viaGateway] = process.argv.slice(2);
const time = async (url) => {
  const start = performance.now();
  const response = await fetch(url);
  await response.text();
  if (!response.ok) throw new Error(url + ' ' + response.status);
  return performance.now() - start;
};
const samples = { direct: [], gateway: [] };
for (let i = 0; i < 20; i++) { await time(direct); await time(viaGateway); }
for (let i = 0; i < 200; i++) { samples.direct.push(await time(direct)); samples.gateway.push(await time(viaGateway)); }
const median = (v) => v.sort((a, b) => a - b)[v.length >> 1];
console.log(JSON.stringify({ direct: median(samples.direct), gateway: median(samples.gateway) }));
`;

test('TH-warm-overhead', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, plain);
  await appJson(app.name, '/');
  const ip = containerIp(runningContainerFor(app.id)!);
  const { direct, gateway } = inNetwork(latencyProbe, `http://${ip}:8000/`, `http://gateway:8080/apps/${app.name}/`);
  t.diagnostic(`warm request median: direct ${direct.toFixed(2)} ms, via gateway ${gateway.toFixed(2)} ms, overhead ${(gateway - direct).toFixed(2)} ms`);
  assert.ok(gateway - direct < 5, `overhead ${(gateway - direct).toFixed(2)} ms, gate 5 ms`);
});
