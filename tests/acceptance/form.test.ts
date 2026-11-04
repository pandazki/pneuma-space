import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient, appJson, appPut, browser, deploy, images, login, publish, restartGateway, serviceToken, setupSuite, teardownSuite, uniqueName,
} from './harness.ts';

before(setupSuite);
after(teardownSuite);

const forged = { 'x-pneuma-space-subject': 'user:mallory', 'x-pneuma-space-name': 'mallory', 'x-pneuma-space-owner': '1' };

test('AC-FORM-1', { timeout: 120_000 }, async (t) => {
  const options = { image: images.echo, capabilities: { db: {} } };
  const app = await deploy(t, options);
  assert.match((await appJson(app.name, '/env')).PNEUMA_SPACE_DB_URL, /^sqlite:/);
  await appPut(app.name, '/db/answer', 'from-sqlite');
  assert.equal((await appJson(app.name, '/db/answer')).value, 'from-sqlite');

  const switched = await adminClient.setAppPolicy(app.name, { db_backend: 'postgres' });
  assert.ok(switched.status < 300, `db_backend=postgres: ${switched.status} ${JSON.stringify(switched.body)}`);
  publish(app.name, options);
  assert.match((await appJson(app.name, '/env')).PNEUMA_SPACE_DB_URL, /^postgresql:/);
  assert.equal((await appJson(app.name, '/db/answer')).value, null, 'the other engine starts empty');
  await appPut(app.name, '/db/answer', 'from-postgres');
  assert.equal((await appJson(app.name, '/db/answer')).value, 'from-postgres');
});

test('AC-FORM-2', { timeout: 60_000 }, async (t) => {
  const open = await deploy(t, { image: images.echo, capabilities: {} });
  const seen = await appJson(open.name, '/headers', { headers: forged });
  for (const header of Object.keys(forged)) assert.equal(seen[header], undefined, `${header} dropped`);

  const app = await deploy(t, { image: images.echo, capabilities: { identity: {} } });
  const headers = await appJson(app.name, '/headers', { headers: { ...forged, ...browser(await login('alice')) } });
  assert.equal(headers['x-pneuma-space-subject'], 'user:alice');
});

test('AC-FORM-3', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { identity: {} }, owner: 'user:alice' });
  const as = async (headers: Record<string, string>) => (await appJson(app.name, '/headers', { headers }))['x-pneuma-space-owner'];
  assert.equal(await as(browser(await login('alice'))), '1');
  assert.equal(await as(browser(await login('bob'))), undefined);
  assert.equal(await as({ authorization: `Bearer ${await serviceToken(uniqueName('svc'))}` }), undefined);
});

test('AC-FORM-5', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { files: {} } });
  await appPut(app.name, '/files/attachment', 'uploaded-bytes');
  publish(app.name, { image: images.echo2, capabilities: { files: {} } });
  await restartGateway();
  const after = await appJson(app.name, '/');
  assert.equal(after.variant, '2');
  assert.equal((await appJson(app.name, '/files/attachment')).value, 'uploaded-bytes');
});
