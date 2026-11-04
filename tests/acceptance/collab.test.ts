import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  appJson, appPut, connect, containerIp, deploy, images, inNetwork, publish, runningContainerFor, setIdle, setupSuite, sleep, startedAt,
  summary, teardownSuite,
} from './harness.ts';

before(setupSuite);
after(teardownSuite);

test('AC-COLLAB-1', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { kv: {}, ws: {} } });
  const [a, b] = [await connect(app.name), await connect(app.name)];
  t.after(() => (a.ws.close(), b.ws.close()));
  assert.equal(await a.next(), 'ready');
  assert.equal(await b.next(), 'ready');
  a.ws.send('card moved');
  assert.equal(await b.next(), 'card moved');
});

test('AC-COLLAB-2', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { kv: {} } });
  const env = await appJson(app.name, '/env');
  assert.ok(env.PNEUMA_SPACE_KV_URL);
  assert.ok(env.PNEUMA_SPACE_KV_PREFIX);
  assert.equal((await appJson(app.name, '/kv-pubsub')).received, true, 'PUBLISH and SUBSCRIBE within the prefix');
  assert.match((await appJson(app.name, '/kv-foreign')).error ?? '', /^NOPERM/);
});

test('AC-COLLAB-3', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { ws: {} } });
  await setIdle(app.name, 2);
  const socket = await connect(app.name, '/ws?mode=echo');
  t.after(() => socket.ws.close());
  const container = runningContainerFor(app.id)!;
  const started = startedAt(container);
  await sleep(8000);
  assert.equal((await summary(app.name)).instance, 'awake');
  assert.equal(runningContainerFor(app.id), container);
  assert.equal(startedAt(container), started, 'not restarted');
  socket.ws.send('still here');
  assert.equal(await socket.next(), 'still here');
});

test('AC-COLLAB-4', { timeout: 90_000 }, async (t) => {
  const caps = { files: {}, ws: {} };
  const app = await deploy(t, { image: images.echo, capabilities: caps });
  await appPut(app.name, '/files/doc', 'draft-1');
  const socket = await connect(app.name, '/ws?mode=echo');
  publish(app.name, { image: images.echo2, capabilities: caps });
  const code = await Promise.race([socket.closed, new Promise((ok) => setTimeout(ok, 40_000, 'still open').unref())]);
  assert.equal(code, 1001);
  const again = await connect(app.name, '/ws?mode=echo');
  t.after(() => again.ws.close());
  again.ws.send('reconnected');
  assert.equal(await again.next(), 'reconnected');
  assert.equal((await appJson(app.name, '/')).variant, '2');
  assert.equal((await appJson(app.name, '/files/doc')).value, 'draft-1');
});

const relayProbe = `
const [direct, viaGateway] = process.argv.slice(2);
const roundTrips = async (url) => {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error(url + ' did not open')); });
  const samples = [];
  for (let i = 0; i < 220; i++) {
    const start = performance.now();
    await new Promise((ok) => { ws.onmessage = ok; ws.send('x'.repeat(64)); });
    if (i >= 20) samples.push(performance.now() - start);
  }
  ws.close();
  return samples.sort((a, b) => a - b)[samples.length >> 1];
};
console.log(JSON.stringify({ direct: await roundTrips(direct), gateway: await roundTrips(viaGateway) }));
`;

test('TH-ws-relay', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { ws: {} } });
  await appJson(app.name, '/');
  const ip = containerIp(runningContainerFor(app.id)!);
  const { direct, gateway } = inNetwork(relayProbe, `ws://${ip}:8000/ws?mode=echo`, `ws://gateway:8080/apps/${app.name}/ws?mode=echo`);
  t.diagnostic(`WebSocket round trip median: direct ${direct.toFixed(2)} ms, via gateway ${gateway.toFixed(2)} ms, added ${(gateway - direct).toFixed(2)} ms`);
  assert.ok(gateway - direct < 5, `added ${(gateway - direct).toFixed(2)} ms, gate 5 ms`);
});
