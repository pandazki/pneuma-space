import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error The runner is executed directly by Node in its image.
import { extractPackage } from '../runner/package.mjs';
const manifest = { contract: 'pneuma-space.cf/1', runtime: 'node', entry: 'main.mjs', capabilities: {} };
function encode(files: { path: string; body: string }[]) { const bytes = Buffer.from(JSON.stringify({ manifest, files })); return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }; }

test('CF-06 runner reconstructs the immutable package bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-cf-test-'));
  try {
    const source = 'console.log("hello")';
    const { bytes, digest } = encode([{ path: 'main.mjs', body: Buffer.from(source).toString('base64') }]);
    await extractPackage(bytes, digest, directory);
    assert.equal(await readFile(join(directory, 'main.mjs'), 'utf8'), source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('CF-07 runner rejects digest mismatch before extraction', async () => {
  const { bytes } = encode([{ path: 'main.mjs', body: '' }]);
  await assert.rejects(extractPackage(bytes, '0'.repeat(64), '/not-created'), /digest/);
});
test('CF-07 runner rejects traversal and duplicate paths before extraction', async () => {
  for (const paths of [['main.mjs', '../outside'], ['main.mjs', '/outside'], ['main.mjs', 'dir/../outside'], ['main.mjs', 'main.mjs']]) {
    const { bytes, digest } = encode(paths.map(path => ({ path, body: '' })));
    await assert.rejects(extractPackage(bytes, digest, '/not-created'), /path/);
  }
});
test('CF-39 runner keeps answering after the app exits during startup and reports the exit', async () => {
  const { bytes, digest } = encode([{ path: 'main.mjs', body: Buffer.from('process.exit(1)').toString('base64') }]);
  const broker = http.createServer((request, response) => { if (request.url === '/boot') response.end(bytes); else { request.resume(); response.end('{}'); } });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const probe = http.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port; await new Promise(resolve => probe.close(resolve));
  const runner = spawn(process.execPath, [new URL('../runner/boot.mjs', import.meta.url).pathname], { stdio: 'ignore', env: { ...process.env, PNEUMA_SPACE_BROKER: 'http://127.0.0.1:' + (broker.address() as AddressInfo).port, PNEUMA_SPACE_SUPERVISOR_PORT: String(port), PNEUMA_SPACE_BOOT_ID: 'exit-boot', PNEUMA_SPACE_DIGEST: digest } });
  try {
    let report: { bootId?: string; ready?: boolean; exited?: boolean; phases?: { unpack: number | null } } = {};
    for (let i = 0; i < 100 && report.exited !== true; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { report = await (await fetch('http://127.0.0.1:' + port + '/_pneuma-space/ready')).json(); } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    const later = await (await fetch('http://127.0.0.1:' + port + '/_pneuma-space/ready')).json() as typeof report;
    assert.deepEqual([later.bootId, later.ready, later.exited, typeof later.phases?.unpack], ['exit-boot', false, true, 'number']);
  } finally { runner.kill('SIGKILL'); broker.close(); }
});
