import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  appJson, appUrl, containerFor, deliveries, deploy, images, restartGateway, serviceToken, setIdle, setupSuite, startedAt, summary,
  teardownSuite, uniqueName, waitFor, waitInstance,
} from './harness.ts';

before(setupSuite);
after(teardownSuite);

const withTriggers = (triggers: Record<string, object>) => ({ image: images.echo, capabilities: { files: {}, cron: { triggers } } });

async function invoke(name: string, trigger: string, caller = uniqueName('svc')): Promise<{ delivery: string; caller: string }> {
  const response = await fetch(appUrl(name, `/_pneuma/trigger/${trigger}`), {
    method: 'POST',
    headers: { authorization: `Bearer ${await serviceToken(caller)}` },
    body: 'payload',
  });
  assert.equal(response.status, 202);
  return { delivery: (await response.json()).delivery, caller };
}

const runs = async (name: string, delivery: string, phase = 'start') =>
  (await appJson(name, '/deliveries')).filter((d: any) => d.delivery === delivery && d.phase === phase);

test('AC-WORKER-1', { timeout: 200_000 }, async (t) => {
  const app = await deploy(t, withTriggers({ minutely: { schedule: '* * * * *' } }));
  const done = await waitFor(async () => {
    const list = (await deliveries(app.name, 'minutely')).filter((d) => d.state === 'done');
    return list.length >= 2 ? list : null;
  }, 150_000, 'two scheduled deliveries done');
  assert.equal((await summary(app.name)).requests, 0, 'no HTTP traffic to the app');
  const slots = done.map((d: any) => d.scheduledFor).sort((x: number, y: number) => x - y);
  assert.equal(slots[1] - slots[0], 60_000);
  const seen = (await appJson(app.name, '/deliveries')).map((d: any) => d.delivery);
  for (const d of done) assert.ok(seen.includes(d.id), `the app ran delivery ${d.id}`);
});

test('AC-WORKER-2', { timeout: 90_000 }, async (t) => {
  const app = await deploy(t, withTriggers({ work: {} }));
  await setIdle(app.name, 2);
  await appJson(app.name, '/');
  await waitInstance(app.name, 'asleep', 20_000);
  const { delivery, caller } = await invoke(app.name, 'work');
  await waitFor(async () => (await deliveries(app.name, 'work')).some((d) => d.id === delivery && d.state === 'done'), 30_000, 'delivery done');
  const woke = startedAt(containerFor(app.id)!);
  const [run] = await runs(app.name, delivery);
  t.diagnostic(`on-demand trigger ran ${run.at - woke} ms after wake`);
  assert.equal(run.subject, `service:${caller}`);
  assert.equal(run.body, 'payload');
  assert.ok(run.at - woke <= 5000, `ran ${run.at - woke} ms after wake, gate 5000 ms`);
});

test('AC-WORKER-3', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, withTriggers({ slow: {} }));
  const { delivery } = await invoke(app.name, 'slow');
  await waitFor(async () => (await runs(app.name, delivery)).length >= 1, 20_000, 'the delivery to start');
  await restartGateway('kill');
  await waitFor(async () => (await runs(app.name, delivery)).length >= 2, 60_000, 'the same delivery again after restart');
});

test('AC-WORKER-4', { timeout: 90_000 }, async (t) => {
  const app = await deploy(t, withTriggers({ slow: {} }));
  await setIdle(app.name, 2);
  const { delivery } = await invoke(app.name, 'slow');
  const done = await waitFor(async () => (await deliveries(app.name, 'slow')).find((d) => d.id === delivery && d.state === 'done'), 40_000, 'delivery done');
  assert.equal(done.attempts, 1);
  assert.equal((await runs(app.name, delivery, 'start')).length, 1);
  assert.equal((await runs(app.name, delivery, 'done')).length, 1, 'the 8 s run finished uninterrupted');
});
