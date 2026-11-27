import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
