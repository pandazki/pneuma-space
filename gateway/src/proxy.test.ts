import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_POLICY, type AppId, type AppName, type ImageId, type ReleaseNumber, type Subject } from './model.ts';
import { Ingress } from './ingress.ts';

const MiB = 2 ** 20;
const GiB = 2 ** 30;

// Child role: a gateway process holding only the Ingress, so its RSS is measured on its own.
async function serveIngress(upstreamPort: number): Promise<void> {
  const app = 'id-big' as AppId;
  const ingress = new Ingress({
    registry: {
      view: (name) => ({
        app, name, status: 'registered', owner: 'user:o' as Subject, release: 1 as ReleaseNumber, image: 'sha256:x' as ImageId,
        kinds: new Set(['route']), bundle: null, policyOverride: {},
      }),
      policy: () => DEFAULT_POLICY,
    },
    runtime: { acquire: async () => ({ app, address: `127.0.0.1:${upstreamPort}` }), release() {}, channel() {} },
    identity: { authenticate: async () => ({ status: 401 }), serve: async () => {} },
    bundles: { open: async () => { throw new Error('unused'); } },
    scheduler: { invoke: () => { throw new Error('unused'); } },
    stats: [],
    flushStats() {},
  });
  const port = await ingress.listen(0, '127.0.0.1');
  process.send!({ port });
  process.on('message', () => process.send!({ rss: process.memoryUsage().rss }));
  process.on('disconnect', () => process.exit(0));
}

if (process.argv[2] === 'ingress') {
  await serveIngress(Number(process.argv[3]));
} else {
  test('a 1 GiB response streams through the ingress with bounded RSS', async (t) => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const upstream = http.createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let sent = 0; sent < GiB; sent += chunk.length) if (!res.write(chunk)) await once(res, 'drain');
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const child: ChildProcess = fork(import.meta.filename, ['ingress', String((upstream.address() as AddressInfo).port)], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    t.after(() => {
      child.kill();
      upstream.close();
    });
    const [{ port }] = await once(child, 'message') as [{ port: number }];
    const rss = async () => {
      child.send({});
      return ((await once(child, 'message'))[0] as { rss: number }).rss;
    };

    const baseline = await rss();
    let peak = baseline;
    let received = 0;
    const done = new Promise<void>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/apps/big/' }, (res) => {
        res.on('data', (c: Buffer) => (received += c.length)).on('end', resolve);
      }).on('error', reject);
    });
    let finished = false;
    void done.then(() => (finished = true));
    while (!finished) {
      peak = Math.max(peak, await rss());
      await sleep(50);
    }
    await done;
    await sleep(3000);
    const settled = await rss();
    const report = `baseline ${(baseline / MiB).toFixed(1)} MiB, peak growth ${((peak - baseline) / MiB).toFixed(1)} MiB, ` +
      `3 s after ${((settled - baseline) / MiB).toFixed(1)} MiB over baseline`;
    t.diagnostic(report);
    assert.equal(received, GiB);
    // macOS malloc keeps freed Buffer pages resident even after a full GC, so RSS there measures the allocator, not the relay.
    if (process.platform === 'darwin') return void t.skip(`RSS bound is asserted on Linux only; ${report}`);
    assert.ok(peak - baseline < 160 * MiB, report);
    assert.ok(settled - baseline < 20 * MiB, report);
  });
}
