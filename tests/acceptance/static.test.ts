import assert from 'node:assert/strict';
import { get } from 'node:http';
import { after, before, test } from 'node:test';
import { appUrl, containerFor, deploy, fixtureDir, images, median, runningContainerFor, setupSuite, summary, teardownSuite } from './harness.ts';

before(setupSuite);
after(teardownSuite);

const site = { image: null, capabilities: {}, staticDir: fixtureDir('static-site') };

function firstByteMs(url: string): Promise<number> {
  return new Promise((ok, fail) => {
    const start = performance.now();
    get(url, (response) => {
      const elapsed = performance.now() - start;
      response.resume().on('end', () => (response.statusCode === 200 ? ok(elapsed) : fail(new Error(`${url}: ${response.statusCode}`))));
    }).on('error', fail);
  });
}

test('AC-STATIC-1', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, site);
  const response = await fetch(appUrl(app.name));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /static-site-index/);
  assert.equal(containerFor(app.id), null, 'no container for a static-only app');
});

test('AC-STATIC-2', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, site);
  const first = await firstByteMs(appUrl(app.name));
  const warm: number[] = [];
  for (let i = 0; i < 5; i++) warm.push(await firstByteMs(appUrl(app.name)));
  t.diagnostic(`static first byte: first ${first.toFixed(1)} ms, median of next 5 ${median(warm).toFixed(1)} ms`);
  assert.ok(first < 50, `first byte ${first.toFixed(1)} ms, gate 50 ms`);
  assert.equal(containerFor(app.id), null, 'no container start');
});

test('AC-STATIC-3', { timeout: 60_000 }, async (t) => {
  const app = await deploy(t, { ...site, image: images.echo });
  const asset = await fetch(appUrl(app.name, '/app.js'));
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /static-site-app-js/);
  assert.equal(runningContainerFor(app.id), null, 'app.js served without waking the app');
  assert.notEqual((await summary(app.name)).instance, 'awake');
  const api = await fetch(appUrl(app.name, '/api/x'));
  assert.equal(api.status, 200);
  assert.equal((await api.json()).path, '/api/x');
  assert.ok(runningContainerFor(app.id), '/api/x woke the app');
});
