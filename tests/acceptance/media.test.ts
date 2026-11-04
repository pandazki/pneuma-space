import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import {
  appJson, containerNetBytes, deploy, gatewayContainer, gatewayRss, images, runningContainerFor, setIdle, setupSuite, summary,
  teardownSuite, waitInstance,
} from './harness.ts';

before(setupSuite);
after(teardownSuite);

const MiB = 1024 * 1024;
const objectApp = { image: images.echo, capabilities: { object: {} } };

/** A browser-style PUT with Content-Length, streamed so the test never holds the whole body. */
function putBytes(url: string, size: number): Promise<number> {
  return new Promise((ok, fail) => {
    const chunk = Buffer.alloc(MiB, 'pneuma');
    const req = request(url, { method: 'PUT', headers: { 'content-length': size } }, (res) => {
      res.resume().on('end', () => ok(res.statusCode!));
    }).on('error', fail);
    let sent = 0;
    const pump = () => {
      while (sent < size) {
        const part = chunk.subarray(0, Math.min(MiB, size - sent));
        sent += part.length;
        if (!req.write(part)) return void req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

test('AC-MEDIA-1', { timeout: 60_000 }, async (t) => {
  const a = await deploy(t, objectApp);
  const b = await deploy(t, objectApp);
  const env = await appJson(a.name, '/env');
  for (const name of ['ENDPOINT', 'PUBLIC_ENDPOINT', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY']) assert.ok(env[`PNEUMA_SPACE_OBJECT_${name}`], name);
  assert.equal((await appJson(a.name, '/bucket-status')).status, 200, 'own bucket exists');
  const other = (await appJson(b.name, '/env')).PNEUMA_SPACE_OBJECT_BUCKET;
  assert.equal((await appJson(a.name, `/bucket-status?bucket=${other}`)).status, 403);
});

test('AC-MEDIA-2', { timeout: 300_000 }, async (t) => {
  const app = await deploy(t, objectApp);
  const { url } = await appJson(app.name, '/presign?method=PUT&key=uploads/video.bin');
  const container = runningContainerFor(app.id)!;
  const gateway = gatewayContainer();
  const before = [containerNetBytes(container), containerNetBytes(gateway)];
  assert.equal(await putBytes(url, 500 * MiB), 200);
  const [appBytes, gatewayBytes] = [containerNetBytes(container) - before[0], containerNetBytes(gateway) - before[1]];
  t.diagnostic(`500 MiB upload: app container ${appBytes} bytes, gateway ${gatewayBytes} bytes on eth0`);
  assert.ok(appBytes < MiB, `app container moved ${appBytes} bytes`);
  assert.ok(gatewayBytes < MiB, `gateway moved ${gatewayBytes} bytes`);
});

test('AC-MEDIA-3', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, objectApp);
  const { PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT: endpoint, PNEUMA_SPACE_OBJECT_BUCKET: bucket } = await appJson(app.name, '/env');
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  const { url } = await appJson(app.name, '/presign?method=PUT&key=public/clip.bin');
  assert.equal((await fetch(url, { method: 'PUT', body: bytes })).status, 200);
  const ranged = await fetch(`${endpoint}/${bucket}/public/clip.bin`, { headers: { range: 'bytes=1000-' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(1000));
});

test('AC-MEDIA-4', { timeout: 600_000 }, async (t) => {
  const app = await deploy(t, objectApp);
  await setIdle(app.name, 2);
  const { PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT: endpoint, PNEUMA_SPACE_OBJECT_BUCKET: bucket } = await appJson(app.name, '/env');
  const { url } = await appJson(app.name, '/presign?method=PUT&key=public/movie.bin');
  assert.equal(await putBytes(url, 1024 * MiB), 200);
  await waitInstance(app.name, 'asleep', 20_000);

  const rssBefore = gatewayRss();
  const response = await fetch(`${endpoint}/${bucket}/public/movie.bin`);
  assert.equal(response.status, 200);
  let read = 0;
  for await (const chunk of response.body!) read += chunk.length;
  const growth = gatewayRss() - rssBefore;
  t.diagnostic(`1 GiB read: ${read} bytes, gateway RSS ${rssBefore} -> ${rssBefore + growth} (${growth} bytes)`);
  assert.equal(read, 1024 * MiB);
  assert.equal((await summary(app.name)).instance, 'asleep');
  assert.equal(runningContainerFor(app.id), null);
  assert.ok(growth < MiB, `gateway RSS grew ${growth} bytes`);
});
