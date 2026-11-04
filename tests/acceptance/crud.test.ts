import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  appJson, appPut, browser, containerFor, deliveries, deploy, docker, images, login, runningContainerFor, serviceToken, setIdle,
  setupSuite, startedAt, teardownSuite, uniqueName, waitFor, waitInstance,
} from './harness.ts';

before(setupSuite);
after(teardownSuite);

test('AC-CRUD-1', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { files: {} } });
  await appPut(app.name, '/files/card', 'column-2');
  docker('stop', runningContainerFor(app.id)!);
  assert.equal((await appJson(app.name, '/files/card')).value, 'column-2');
});

test('AC-CRUD-2', { timeout: 150_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { files: {}, cron: { triggers: { remind: { schedule: '* * * * *' } } } } });
  await setIdle(app.name, 2);
  await appJson(app.name, '/');
  await waitInstance(app.name, 'asleep', 20_000);
  await waitFor(async () => (await deliveries(app.name, 'remind')).some((d) => d.state === 'done'), 90_000, 'a scheduled delivery done');
  const woke = startedAt(containerFor(app.id)!);
  const [run] = (await appJson(app.name, '/deliveries')).filter((d: any) => d.trigger === 'remind');
  t.diagnostic(`scheduled ${run.scheduledFor}, container started ${new Date(woke).toISOString()}, endpoint ran ${run.at - woke} ms after wake`);
  assert.ok(woke >= Date.parse(run.scheduledFor) - 1000, 'the app was asleep when the slot came');
  assert.ok(run.at - woke <= 5000, `ran ${run.at - woke} ms after wake, gate 5000 ms`);
});

test('AC-CRUD-3', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { identity: {} } });
  const service = uniqueName('bot');
  const fromService = await appJson(app.name, '/headers', { headers: { authorization: `Bearer ${await serviceToken(service)}` } });
  assert.equal(fromService['x-pneuma-subject'], `service:${service}`);
  const fromBrowser = await appJson(app.name, '/headers', { headers: browser(await login('carol')) });
  assert.equal(fromBrowser['x-pneuma-subject'], 'user:carol');
});
