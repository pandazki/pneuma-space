import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  DEFAULT_POLICY, DEFAULT_QUOTA, ManifestError, InputError, QUOTA_RESOURCES, admits, appName, effectivePolicy, parseManifest, releaseKey,
  type BundleId, type ImageId,
} from './model.ts';

const contractExample = {
  contract: 1,
  capabilities: {
    files: {},
    db: {},
    kv: {},
    object: {},
    static: { dir: 'dist' },
    ws: {},
    cron: { triggers: { 'daily-report': { schedule: '0 8 * * *' }, reindex: {} } },
    identity: {},
    rtc: {},
  },
};

test('parseManifest accepts the app-contract example unchanged', () => {
  assert.deepEqual(parseManifest(contractExample), contractExample);
});

test('parseManifest rejects an unknown capability and names it', () => {
  assert.throws(() => parseManifest({ contract: 1, capabilities: { kafka: {} } }), (e) => e instanceof ManifestError && /"kafka"/.test(e.message));
});

test('parseManifest rejects an unknown top-level field', () => {
  assert.throws(() => parseManifest({ contract: 1, capabilities: {}, name: 'x' }), (e) => e instanceof ManifestError && /"name"/.test(e.message));
});

test('parseManifest rejects an unknown field inside a declaration', () => {
  const manifest = { contract: 1, capabilities: { static: { dir: 'dist', spa: true } } };
  assert.throws(() => parseManifest(manifest), (e) => e instanceof ManifestError && /static.*"spa"/.test(e.message));
});

test('parseManifest rejects an explicit route', () => {
  assert.throws(() => parseManifest({ contract: 1, capabilities: { route: {} } }), (e) => e instanceof ManifestError && /implicit/.test(e.message));
});

test('parseManifest rejects a contract other than 1', () => {
  assert.throws(() => parseManifest({ contract: 2, capabilities: {} }), (e) => e instanceof ManifestError && /contract must be 1/.test(e.message));
});

test('releaseKey does not depend on key order', () => {
  const image = 'sha256:abc' as ImageId;
  const bundle = 'f'.repeat(64) as BundleId;
  const a = parseManifest({ contract: 1, capabilities: { kv: {}, static: { dir: 'dist' } } });
  const b = parseManifest({ capabilities: { static: { dir: 'dist' }, kv: {} }, contract: 1 });
  assert.equal(releaseKey(image, a, bundle), releaseKey(image, b, bundle));
});

test('effectivePolicy takes override fields over global ones and keeps the rest', () => {
  const policy = effectivePolicy(DEFAULT_POLICY, { idle_seconds: 5, drain_timeout_seconds: undefined });
  assert.deepEqual(policy, { ...DEFAULT_POLICY, idle_seconds: 5 });
});

test('admits refuses a resource whose used plus ask passes its limit, and never an unlimited one', () => {
  const none = { apps: 0, awake: 0, cpu_millis: 0, memory_mb: 0, storage_gb: 0 };
  for (const resource of QUOTA_RESOURCES) {
    const limit = DEFAULT_QUOTA[resource]!;
    assert.equal(admits(DEFAULT_QUOTA, { ...none, [resource]: limit - 1 }, { [resource]: 1 }), null);
    assert.deepEqual(admits(DEFAULT_QUOTA, { ...none, [resource]: limit }, { [resource]: 1 }), { resource, used: limit, limit, ask: 1 });
    assert.equal(admits({ ...DEFAULT_QUOTA, [resource]: null }, { ...none, [resource]: limit }, { [resource]: 1 }), null);
  }
});

test('appName accepts 40 lowercase characters and rejects uppercase or 41', () => {
  assert.equal(appName('a'.repeat(40)), 'a'.repeat(40));
  assert.throws(() => appName('Survey'), InputError);
  assert.throws(() => appName('a'.repeat(41)), InputError);
});

test('model.ts refuses to load when CAPABILITIES lacks a kind', async () => {
  const source = readFileSync(new URL('./model.ts', import.meta.url), 'utf8');
  const mutated = source.replace(/^ {2}rtc: .*\n/m, '');
  assert.notEqual(mutated, source);
  const path = join(mkdtempSync(join(tmpdir(), 'pneuma-space-model-')), 'model.ts');
  writeFileSync(path, mutated);
  await assert.rejects(import(pathToFileURL(path).href), /CAPABILITIES must cover exactly.*rtc/);
});
