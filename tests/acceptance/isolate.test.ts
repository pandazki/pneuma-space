import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import {
  adminClient, adminUrl, appctl, appId, appJson, appUrl, cleanup, compose, containerFor, deploy, deployIsolate, docker, fixtureDir, images, OWNER, publishIsolate,
  scratch, setIdle, setupSuite, sleep, summary, teardownSuite, uniqueName, waitFor, waitInstance,
} from './harness.ts';

before(setupSuite);
after(teardownSuite);

const fixture = fixtureDir('isolate');
// The runner sits behind a profile, so compose names it only with that profile active.
const runner = (...args: string[]) => compose('--profile', 'isolate', ...args);
const manifest = JSON.parse(readFileSync(`${fixture}/pneuma-space.json`, 'utf8'));

/** Probes an app through the ingress every 100 ms; resolves with the failed probes when stopped. */
function witness(name: string): () => Promise<string[]> {
  const failures: string[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const status = await fetch(appUrl(name), { signal: AbortSignal.timeout(2000) }).then((r) => r.status, (e: Error) => e.message);
      if (status !== 200) failures.push(String(status));
      await sleep(100);
    }
  })();
  return async () => {
    running = false;
    await loop;
    return failures;
  };
}

const status = async (name: string) => (await fetch(appUrl(name), { signal: AbortSignal.timeout(10_000) })).status;
const fire = (name: string, path: string) => void fetch(appUrl(name, path), { signal: AbortSignal.timeout(20_000) }).catch(() => {});

async function policy(name: string, fields: Record<string, unknown>): Promise<void> {
  const reply = await adminClient.setAppPolicy(name, fields);
  assert.ok(reply.status < 300, `PUT policy ${name}: ${reply.status} ${JSON.stringify(reply.body)}`);
}

async function awakeWitness(t: TestContext): Promise<() => Promise<string[]>> {
  const other = await deployIsolate(t);
  assert.equal(await status(other.name), 200);
  const stop = witness(other.name);
  t.after(stop);
  return stop;
}

test('AC-ISO-1', { timeout: 120_000 }, async (t) => {
  const name = uniqueName('acc');
  const dir = join(mkdtempSync(join(scratch, 'pneuma-space-acc-')), 'app');
  t.after(() => rmSync(join(dir, '..'), { recursive: true, force: true }));
  t.after(() => cleanup(name));
  appctl('init', dir);
  assert.match(appctl('publish', name, dir, '--owner', OWNER), /release 1$/m);
  assert.equal(docker('images', '-q', `pneuma-space-app/${name}`), '', 'no image was built');
  const listed = await summary(name);
  assert.deepEqual([listed.status, listed.release, listed.runtime], ['registered', 1, 'isolate']);
  const started = performance.now();
  const response = await fetch(appUrl(name));
  const body = await response.text();
  const ms = performance.now() - started;
  t.diagnostic(`isolate cold start, first request: ${ms.toFixed(0)} ms`);
  assert.equal(response.status, 200);
  assert.match(body, /src\/server\.ts/, 'the scaffold page answers');
  assert.ok(ms < 1000, `first request ${ms.toFixed(0)} ms, gate 1000 ms`);
  assert.equal(containerFor(await appId(name)), null, 'docker ps -a shows no container for an isolate app');
});

test('AC-ISO-2', { timeout: 120_000 }, async (t) => {
  const stop = await awakeWitness(t);
  const app = await deployIsolate(t);
  await policy(app.name, { max_failures: 2, failure_window_seconds: 120, restart_backoff_seconds: 1 });
  assert.equal(await status(app.name), 200);
  fire(app.name, '/hang');
  const stuckAt = performance.now();
  await waitInstance(app.name, 'asleep', 5000);
  t.diagnostic(`busy loop stopped ${(performance.now() - stuckAt).toFixed(0)} ms after the stuck request`);
  await sleep(1100);
  assert.equal(await status(app.name), 200, 'the next request after restart_backoff_seconds wakes it');
  fire(app.name, '/hang');
  const quarantine = await waitFor(async () => (await summary(app.name)).quarantine, 10_000, 'quarantine');
  assert.equal(quarantine.failures, 2);
  assert.equal(await status(app.name), 503);
  const quarantined = async () => (await (await fetch(`${adminUrl}/api/metrics`)).json()).events.some((e: { ev: string }) => e.ev === 'quarantined');
  await waitFor(quarantined, 5000, 'the quarantine as a lifecycle event');
  assert.match(await (await fetch(`${adminUrl}/`)).text(), /if \(a\.quarantine\) items\.push/, 'the attention inbox lists quarantined apps');
  assert.ok((await fetch(`${adminUrl}/api/apps/${app.name}/unquarantine`, { method: 'POST' })).ok);
  assert.equal((await summary(app.name)).quarantine, null);
  assert.equal(await status(app.name), 200, 'unquarantine lifts it');
  fire(app.name, '/hang');
  await waitInstance(app.name, 'asleep', 5000);
  await sleep(1100);
  assert.equal(await status(app.name), 200);
  fire(app.name, '/hang');
  await waitFor(async () => (await summary(app.name)).quarantine, 10_000, 'second quarantine');
  await publishIsolate(app.name, fixture, { ...manifest, capabilities: { ...manifest.capabilities, ws: {} } });
  assert.equal(await status(app.name), 200, 'a new release lifts it');
  assert.deepEqual(await stop(), [], 'the other isolate app answered throughout');
});

test('AC-ISO-3', { timeout: 60_000 }, async (t) => {
  const stop = await awakeWitness(t);
  const app = await deployIsolate(t);
  await policy(app.name, { max_failures: 1, restart_backoff_seconds: 1 });
  assert.equal(await status(app.name), 200);
  fire(app.name, '/bloat');
  const quarantine = await waitFor(async () => (await summary(app.name)).quarantine, 20_000, 'the heap overrun counted as a failure');
  assert.match(quarantine.reason, /memory/);
  assert.deepEqual(await stop(), [], 'the other isolate app answered throughout');
});

test('AC-ISO-4', { timeout: 120_000 }, async (t) => {
  const app = await deployIsolate(t);
  const storage = `/data/apps/${app.id}/storage`;
  assert.equal(await (await fetch(appUrl(app.name, '/note'), { method: 'PUT', body: 'kept' })).text(), 'saved');
  const kept = { file: 'kept', rows: ['kept'] };
  await setIdle(app.name, 1);
  await waitInstance(app.name, 'asleep', 15_000);
  assert.deepEqual(await appJson(app.name, '/note'), kept, 'after sleep');
  await publishIsolate(app.name, fixture, { ...manifest, capabilities: { ...manifest.capabilities, ws: {} } });
  assert.deepEqual(await appJson(app.name, '/note'), kept, 'after a new release');
  runner('restart', 'runner');
  await waitFor(async () => (await fetch(appUrl(app.name, '/note'), { signal: AbortSignal.timeout(5000) }).catch(() => null))?.ok, 30_000, 'answer after runner restart');
  assert.deepEqual(await appJson(app.name, '/note'), kept, 'after docker compose restart runner');
  assert.match(runner('exec', '-T', 'runner', 'ls', storage), /pneuma-space-files-/);
  await cleanup(app.name);
  assert.equal(runner('exec', '-T', 'runner', 'sh', '-c', `ls ${storage} 2>/dev/null || true`).trim(), '', 'purge deletes the file and the database');
});

test('AC-ISO-5', { timeout: 90_000 }, async (t) => {
  const runnerProbe = async () => (await (await fetch(`${adminUrl}/api/metrics`)).json()).services.runner?.status;
  runner('stop', 'runner');
  t.after(async () => {
    runner('up', '-d', '--wait', 'runner');
    await waitFor(async () => (await runnerProbe()) === 'up', 30_000, 'runner up again');
  });
  const name = uniqueName('acc');
  t.after(() => cleanup(name));
  await assert.rejects(publishIsolate(name, fixture), /409/);
  await waitFor(async () => (await runnerProbe()) === 'off', 30_000, 'service strip shows the runner off');
  assert.match(await (await fetch(`${adminUrl}/`)).text(), /'postgres', 'coturn', 'runner'\]\.map\(item\)/, 'the overview strip renders the runner');
});

test('AC-ISO-6', { timeout: 120_000 }, async (t) => {
  const apps = [
    { ...(await deploy(t, { image: images.echo, capabilities: {} })), runtime: 'container' },
    { ...(await deploy(t, { image: images.echo, capabilities: {} })), runtime: 'container' },
    { ...(await deployIsolate(t)), runtime: 'isolate' },
    { ...(await deployIsolate(t)), runtime: 'isolate' },
    { ...(await deploy(t, { image: null, capabilities: {}, staticDir: new URL('../../examples/site-docs/site', import.meta.url).pathname })), runtime: null },
  ];
  const statuses = await Promise.all(apps.map((app) => status(app.name)));
  assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
  const listed = await Promise.all(apps.map((app) => summary(app.name)));
  assert.deepEqual(listed.map((a) => a.runtime), apps.map((a) => a.runtime));
});
