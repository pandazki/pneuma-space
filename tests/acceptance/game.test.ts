import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import {
  OWNER, adminClient, appJson, appPut, appUrl, cleanup, compose, deploy, images, setupSuite, teardownSuite, uniqueName, waitFor,
} from './harness.ts';

before(setupSuite);
after(teardownSuite);

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('AC-GAME-1', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { rtc: {} } });
  const env = await appJson(app.name, '/env');
  for (const name of ['PNEUMA_SPACE_RTC_STUN_URLS', 'PNEUMA_SPACE_RTC_TURN_URLS', 'PNEUMA_SPACE_RTC_TURN_SECRET']) assert.ok(env[name], name);

  const refused = uniqueName('acc');
  t.after(() => cleanup(refused));
  compose('stop', 'coturn');
  try {
    const reply = await adminClient.publish(refused, { image: images.echo, manifest: { contract: 1, capabilities: { rtc: {} } }, owner: OWNER });
    assert.equal(reply.status, 409);
  } finally {
    compose('--profile', 'rtc', 'up', '-d', 'coturn');
  }
});

type Page = { evaluate(expression: string): Promise<unknown> };

async function chrome(t: TestContext): Promise<(url: string) => Promise<Page>> {
  const profile = mkdtempSync(join(tmpdir(), 'pneuma-space-acc-chrome-'));
  const browser = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-features=WebRtcHideLocalIpsWithMdns', 'about:blank',
  ], { stdio: 'ignore' });
  t.after(async () => {
    const exited = new Promise((ok) => browser.once('exit', ok));
    browser.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });
  const port = await waitFor(() => {
    try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { return null; }
  }, 15_000, 'Chrome DevTools port');
  return async (url) => {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok) => ws.addEventListener('open', ok));
    t.after(() => ws.close());
    let id = 0;
    const pending = new Map<number, (m: any) => void>();
    ws.addEventListener('message', (e) => {
      const message = JSON.parse(String(e.data));
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    return {
      evaluate: (expression) => new Promise((ok) => {
        pending.set(++id, (m) => ok(m.result?.result?.value));
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      }),
    };
  };
}

test('AC-GAME-2', { timeout: 120_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { kv: {}, ws: {}, rtc: {} } });
  const { PNEUMA_SPACE_RTC_TURN_SECRET: secret } = await appJson(app.name, '/env');
  const username = `${Math.floor(Date.now() / 1000) + 600}:acc`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  compose('exec', '-T', 'coturn', 'sh', '-c', `turnutils_uclient -y -n 5 -m 1 -u '${username}' -w '${credential}' $(hostname -i)`);

  const open = await chrome(t);
  const answerer = await open(appUrl(app.name, '/rtc.html?role=b'));
  await waitFor(() => answerer.evaluate('window.ready === true'), 15_000, 'page b ready');
  const offerer = await open(appUrl(app.name, '/rtc.html?role=a'));
  await waitFor(() => offerer.evaluate('window.ready === true'), 15_000, 'page a ready');
  const result = await Promise.race([
    Promise.all([offerer.evaluate('window.result'), answerer.evaluate('window.result')]),
    new Promise((ok) => setTimeout(ok, 20_000, 'datachannel did not open within 20 s').unref()),
  ]);
  assert.deepEqual(result, ['pong', 'ping']);
});

test('AC-GAME-3', { timeout: 90_000 }, async (t) => {
  const app = await deploy(t, { image: images.echo, capabilities: { kv: {} } });
  await appPut(app.name, '/kv/room-7', 'alice-vs-bob');
  compose('restart', 'redis');
  await waitFor(async () => (await appJson(app.name, '/kv/room-7').catch(() => null))?.value === 'alice-vs-bob', 30_000, 'room-7 readable after redis restart');
});
