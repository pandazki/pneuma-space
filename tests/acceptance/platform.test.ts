import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OWNER, adminClient, adminUrl, appJson, appPut, appUrl, bucketExists, cleanup, containerIp, deploy, docker, images, inNetwork,
  median, publish, restartGateway, runningContainerFor, serviceToken, setIdle, setupSuite, stack, summary, teardownSuite,
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
  assert.ok((await appJson(app.name, '/env')).PNEUMA_KV_URL);
  await appPut(app.name, '/kv/kept', 'before-removal');
  publish(app.name, { image: images.echo, capabilities: {} });
  const without = await appJson(app.name, '/env');
  assert.equal(without.PNEUMA_KV_URL, undefined);
  assert.equal(without.PNEUMA_KV_PREFIX, undefined);
  publish(app.name, { image: images.echo, capabilities: { kv: {} } });
  assert.ok((await appJson(app.name, '/env')).PNEUMA_KV_URL);
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
  const checkout = mkdtempSync(join(tmpdir(), 'pneuma-acc-clean-'));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const env = { ...process.env, PNEUMA_NETWORK: 'pneuma-acc-clean', PNEUMA_HTTP_PORT: '18180', PNEUMA_ADMIN_PORT: '18181', PNEUMA_OBJECT_PORT: '19100' };
  const compose = (...args: string[]) => execFileSync('docker', ['compose', '-p', 'pneuma-acc-clean', ...args], { cwd: checkout, env, stdio: 'pipe' });
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
  for (const field of ['/api/apps', '/release', '/policy', '/remove', '/purge', 'releases', 'bindings', 'deliveries', 'requests', 'errors']) {
    assert.ok(page.includes(field), `console has ${field}`);
  }
  assert.doesNotMatch(page, /\/api\/tokens/, 'no token page');
  assert.doesNotMatch(page, /\/api\/policy\b/, 'no global policy page');
  assert.doesNotMatch(page, /\/owner\b/, 'no owner change');
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
  assert.ok(docker('ps', '-q', '--filter', `label=pneuma.network=${stack.network}`).split('\n').length >= 20, '20 apps running');

  const since = Date.now() / 1000;
  const timings: number[] = [];
  let listed: any[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    listed = await (await fetch(adminUrl + '/api/apps')).json();
    timings.push(performance.now() - start);
  }
  const until = Date.now() / 1000 + 1;
  const events = docker('events', '--since', since.toFixed(3), '--until', until.toFixed(3), '--filter', `label=pneuma.network=${stack.network}`, '--format', '{{.Type}} {{.Action}}');
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
  assert.ok(volumeExists(`pneuma-files-${app.id}`), 'files volume kept');
  assert.ok(volumeExists(`pneuma-db-${app.id}`), 'database kept');
  assert.ok(await bucketExists(`app-${app.id}`), 'bucket kept');

  assert.ok((await adminClient.purge(app.name)).status < 300);
  await waitFor(() => !volumeExists(`pneuma-files-${app.id}`) && !volumeExists(`pneuma-db-${app.id}`), 30_000, 'volumes deleted by purge');
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
  const invoked = await fetch(appUrl(worker.name, '/_pneuma/trigger/slow'), { method: 'POST', headers: { authorization: `Bearer ${token}` } });
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
