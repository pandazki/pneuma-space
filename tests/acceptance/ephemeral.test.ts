// Ephemeral apps (ADR 0038): rows AC-EPH-1 to AC-EPH-5 of docs/acceptance.md.

import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import {
  adminClient, adminUrl, appId, appJson, appPut, appUrl, bucketExists, cleanup, compose, deliveries, deploy, images, OWNER, publish, serviceToken,
  setupSuite, sleep, summary, teardownSuite, uniqueName, volumeExists, waitFor, type Capabilities,
} from './harness.ts';
import { ADMIN_PATHS } from '../../gateway/src/model.ts';

before(setupSuite);
after(teardownSuite);

type Ephemeral = { name: string; id: string; printed: string };

/** `appctl publish --ephemeral` under a fresh name; whatever the test leaves is ended when it ends. */
async function ephemeral(t: TestContext, capabilities: Capabilities, ttl?: number, tenant?: string): Promise<Ephemeral> {
  const name = uniqueName('eph');
  t.after(() => cleanup(name));
  const flags = ['--ephemeral', ...(ttl ? ['--ttl', String(ttl)] : []), ...(tenant ? ['--tenant', tenant] : [])];
  const printed = publish(name, { image: images.echo, capabilities, flags });
  return { name, id: await appId(name), printed };
}

/** The gateway's clock runs in the Docker VM, so a host-side bound on it gets this much slack. */
const SKEW_MS = 5000;
const release = (fields: Record<string, unknown> = {}) => ({ image: images.echo, manifest: { contract: 1, capabilities: {} }, owner: OWNER, ...fields });
const audit = async (name: string) => (await adminClient.audit(name)).body.reverse().map((r: any) => [r.actor, r.action, r.result]);

test('AC-EPH-1', { timeout: 120_000 }, async (t) => {
  const before = Date.now();
  const app = await ephemeral(t, {}, 120);
  const listed = await summary(app.name);
  assert.ok(listed.expiresAt >= before + 120_000 - SKEW_MS && listed.expiresAt <= Date.now() + 120_000 + SKEW_MS, `expiresAt ${listed.expiresAt}`);
  assert.match(app.printed, new RegExp(`expires ${new Date(listed.expiresAt).toISOString()}`));
  const detail = (await adminClient.app(app.name)).body;
  assert.deepEqual([detail.app.expiresAt, detail.app.access], [listed.expiresAt, 'tenant']);

  assert.equal((await adminClient.publish(app.name, release({ image: images.echo2, ephemeral: { ttl_seconds: 600 } }))).status, 200);
  assert.deepEqual([(await summary(app.name)).release, (await summary(app.name)).expiresAt], [2, listed.expiresAt], 'a republish keeps the end');
  assert.equal((await adminClient.publish(app.name, release())).status, 409, 'an ephemeral app never becomes durable');
  for (const access of ['org', 'public']) assert.equal((await adminClient.setAccess(app.name, access)).status, 409);
  assert.equal((await summary(app.name)).access, 'tenant');

  const durable = await deploy(t, { image: images.echo, capabilities: {} });
  assert.equal((await adminClient.publish(durable.name, release({ ephemeral: {} }))).status, 409, 'a durable app never becomes ephemeral');
  assert.deepEqual([(await summary(durable.name)).release, (await summary(durable.name)).expiresAt], [1, null]);

  const tooLong = uniqueName('eph');
  assert.equal((await adminClient.publish(tooLong, release({ ephemeral: { ttl_seconds: 3601 } }))).status, 400);
  assert.equal((await adminClient.app(tooLong)).status, 404);
});

test('AC-EPH-2', { timeout: 120_000 }, async (t) => {
  const app = await ephemeral(t, { files: {}, db: {}, object: {} });
  await appPut(app.name, '/files/a', 'kept');
  await appPut(app.name, '/db/a', 'kept');
  assert.ok(await bucketExists(`app-${app.id}`));

  const durable = await deploy(t, { image: images.echo, capabilities: { files: {} } });
  assert.equal((await adminClient.discard(durable.name)).status, 409);
  assert.equal((await summary(durable.name)).status, 'registered');

  assert.ok((await adminClient.discard(app.name)).status < 300);
  assert.equal((await fetch(appUrl(app.name))).status, 404);
  assert.equal(await summary(app.name), null);
  await waitFor(() => !volumeExists(`pneuma-space-files-${app.id}`) && !volumeExists(`pneuma-space-db-${app.id}`), 30_000, 'volumes deleted by discard');
  assert.equal(await bucketExists(`app-${app.id}`), false, 'bucket deleted by discard');
  assert.deepEqual((await audit(app.name)).filter(([, action]: string[]) => action !== 'app.publish'), [['local', 'app.discard', 'started'], ['local', 'app.discard', 'ok']]);
  assert.deepEqual((await adminClient.audit(app.name)).body.find((r: any) => r.action === 'app.publish' && r.result === 'ok').details.ephemeral, {});
});

test('AC-EPH-3', { timeout: 180_000 }, async (t) => {
  const short = await ephemeral(t, { files: {} }, 10);
  await waitFor(async () => (await summary(short.name)) === null, 30_000, 'the app to expire');
  await waitFor(() => !volumeExists(`pneuma-space-files-${short.id}`), 30_000, 'volume deleted by expiry');
  assert.deepEqual(await audit(short.name).then((rows) => rows.filter(([, action]: string[]) => action === 'app.expire')), [['platform', 'app.expire', 'started'], ['platform', 'app.expire', 'ok']]);

  const down = await ephemeral(t, { files: {} }, 20);
  const { expiresAt } = await summary(down.name);
  compose('stop', 'gateway');
  try {
    await sleep(Math.max(0, expiresAt - Date.now()) + SKEW_MS);
  } finally {
    compose('up', '-d', 'gateway');
    await waitFor(async () => (await fetch(adminUrl + ADMIN_PATHS.health).catch(() => null))?.ok, 30_000, 'admin health after gateway start');
  }
  await waitFor(async () => (await summary(down.name)) === null, 30_000, 'the app whose end passed while the gateway was down to expire');
  assert.equal(volumeExists(`pneuma-space-files-${down.id}`), false);
});

test('AC-EPH-4', { timeout: 120_000 }, async (t) => {
  assert.equal((await adminClient.quota('default')).body.quota.ephemeral, null, 'the default tenant stays unlimited');
  const tenant = uniqueName('eph');
  assert.equal((await adminClient.createTenant(tenant, OWNER.slice('user:'.length))).status, 200);
  assert.equal((await adminClient.setQuota(tenant, { ephemeral: 1 })).status, 200);
  const first = await ephemeral(t, {}, undefined, tenant);
  const { used } = (await adminClient.quota(tenant)).body;
  assert.deepEqual([used.apps, used.ephemeral], [0, 1]);

  const second = uniqueName('eph');
  t.after(() => cleanup(second));
  const refused = await adminClient.publish(second, { ...release({ ephemeral: {} }), tenant } as never);
  assert.deepEqual([refused.status, refused.body.quota?.resource], [409, 'ephemeral']);
  assert.ok((await adminClient.discard(first.name)).status < 300);
  assert.equal((await adminClient.publish(second, { ...release({ ephemeral: {} }), tenant } as never)).status, 200, 'a discarded app frees its slot');
});

test('AC-EPH-5', { timeout: 150_000 }, async (t) => {
  const app = await ephemeral(t, { files: {}, cron: { triggers: { minutely: { schedule: '* * * * *' } } } });
  await sleep(60_000 - (Date.now() % 60_000) + 10_000);
  assert.deepEqual(await deliveries(app.name, 'minutely'), [], 'no scheduled delivery');

  const response = await fetch(appUrl(app.name, '/_pneuma-space/trigger/minutely'), {
    method: 'POST', headers: { authorization: `Bearer ${await serviceToken(uniqueName('svc'))}` }, body: 'payload',
  });
  assert.equal(response.status, 202);
  const { delivery } = await response.json();
  await waitFor(async () => (await appJson(app.name, '/deliveries')).some((d: any) => d.delivery === delivery && d.phase === 'start'), 30_000, 'the invoked delivery to run');
});
