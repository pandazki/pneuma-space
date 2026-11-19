import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareArtifact, createArchive, parseArchive } from '../core/artifacts.ts';
import { DEFAULT_LIMITS } from '../core/model.ts';
import { LocalArtifacts } from '../adapters/local/artifacts.ts';
import type { AppId } from '../../shared/values.ts';

const source = 'export default { fetch() { return new Response("hello"); } };';
const manifest = { contract: 2, runtime: 'fetch', abi: 'pneuma-space.fetch/1', entry: 'app.mjs', capabilities: { records: {}, static: { dir: 'public' } } };
const artifact = { manifest, source, assets: [{ path: 'index.html', contentType: 'text/html', body: btoa('hello') }] };

test('AC-C-23 rejects unsupported runtime before an artifact is prepared', async () => {
  await assert.rejects(prepareArtifact({ ...artifact, manifest: { ...manifest, runtime: 'container' } }, DEFAULT_LIMITS));
});

test('AC-C-23 rejects an unsupported capability', async () => {
  await assert.rejects(prepareArtifact({ ...artifact, manifest: { ...manifest, capabilities: { db: {} } } }, DEFAULT_LIMITS));
});

test('AC-C-23 rejects a different ABI', async () => {
  await assert.rejects(prepareArtifact({ ...artifact, manifest: { ...manifest, abi: 'other/1' } }, DEFAULT_LIMITS));
});

for (const path of ['../secret', '/index.html', 'a\\b', 'a%2fb', '_pneuma-space/auth', 'a//b']) {
  test(`AC-C-23 rejects asset path ${JSON.stringify(path)}`, async () => {
    await assert.rejects(prepareArtifact({ ...artifact, assets: [{ ...artifact.assets[0], path }] }, DEFAULT_LIMITS));
  });
}

test('AC-C-9 canonical artifact identity ignores input key and asset ordering', async () => {
  const assets = [...artifact.assets, { path: 'style.css', contentType: 'text/css', body: btoa('body{}') }];
  const first = await prepareArtifact({ ...artifact, assets }, DEFAULT_LIMITS);
  const second = await prepareArtifact({ assets: assets.toReversed(), source, manifest: { ...manifest, capabilities: { static: { dir: 'public' }, records: {} } } }, DEFAULT_LIMITS);
  assert.equal(first.digest, second.digest);
});

test('AC-C-16 a filesystem artifact survives reopening its adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-artifact-'));
  const first = new LocalArtifacts(directory);
  const second = new LocalArtifacts(directory);
  try {
    const prepared = await prepareArtifact(artifact, DEFAULT_LIMITS);
    const appId = crypto.randomUUID() as AppId;
    await first.put(appId, prepared);
    assert.deepEqual(await second.get(appId, prepared.digest), prepared.artifact);
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); }
});

test('AC-C-15 a purged artifact rejects a writer resumed after cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pneuma-space-artifact-'));
  const store = new LocalArtifacts(directory);
  try {
    const prepared = await prepareArtifact(artifact, DEFAULT_LIMITS);
    const appId = crypto.randomUUID() as AppId;
    await store.destroy(appId);
    await assert.rejects(store.put(appId, prepared), { status: 409 });
    await assert.rejects(store.get(appId, prepared.digest));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('AC-C-17 export checksum rejects altered record content', async () => {
  const prepared = await prepareArtifact(artifact, DEFAULT_LIMITS);
  const archive = await createArchive(prepared.artifact, { format: 1, revision: 2, records: [{ key: 'x', value: 1, revision: '2' }] });
  archive.records.records[0].value = 2;
  await assert.rejects(parseArchive(archive, DEFAULT_LIMITS), /checksum/);
});

test('AC-C-17 malformed records are rejected before restoration', async () => {
  const prepared = await prepareArtifact(artifact, DEFAULT_LIMITS);
  const archive = await createArchive(prepared.artifact, { format: 1, revision: 2, records: [{ key: 'x', value: 1, revision: '3' }] });
  await assert.rejects(parseArchive(archive, DEFAULT_LIMITS), /watermark/);
});

test('AC-C-17 oversized archives are rejected before restoration', async () => {
  const prepared = await prepareArtifact(artifact, DEFAULT_LIMITS);
  const archive = await createArchive(prepared.artifact, { format: 1, revision: 1, records: [{ key: 'x', value: 'large', revision: '1' }] });
  await assert.rejects(parseArchive(archive, { ...DEFAULT_LIMITS, records: { ...DEFAULT_LIMITS.records, totalBytes: 1 } }), /bytes/);
});

test('AC-C-16 archives preserve live revisions and their watermark', async () => {
  const prepared = await prepareArtifact(artifact, DEFAULT_LIMITS);
  const records = { format: 1 as const, revision: 12, records: [{ key: 'x', value: { text: 'saved' }, revision: '9' }] };
  const parsed = await parseArchive(await createArchive(prepared.artifact, records), DEFAULT_LIMITS);
  assert.deepEqual(parsed, { prepared, records });
});
