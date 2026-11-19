import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilitiesFor, runtimesFor } from '../../shared/catalog.ts';
import { Conflict, InputError, ManifestError, NotFound, appName, bundleId, subject, tenantName, triggerName } from '../../shared/values.ts';
import * as gateway from './model.ts';

test('contract 1 catalogue retains its capability kinds', () => {
  assert.deepEqual(Object.keys(capabilitiesFor(1)), ['route', 'files', 'db', 'kv', 'object', 'static', 'ws', 'cron', 'identity', 'rtc']);
});

test('contract 2 catalogue accepts only its declared capabilities', () => {
  assert.deepEqual(Object.keys(capabilitiesFor(2)), ['route', 'static', 'identity', 'records']);
});

test('contract 2 records declaration accepts an empty object', () => {
  assert.deepEqual(capabilitiesFor(2).records.parse({}, 'manifest.capabilities.records'), {});
});

test('contract 2 records declaration rejects unknown options', () => {
  assert.throws(() => capabilitiesFor(2).records.parse({ database: 'other' }, 'manifest.capabilities.records'), ManifestError);
});

test('contract 1 keeps its process runtimes', () => {
  assert.deepEqual(runtimesFor(1), {
    container: { contracts: [1], family: 'process', service: null, profile: null, input: 'image' },
    isolate: { contracts: [1], family: 'process', service: 'runner', profile: 'isolate', input: 'bundle' },
  });
});

test('contract 2 uses the fetch runtime with an artifact input', () => {
  assert.deepEqual(runtimesFor(2), {
    fetch: { contracts: [2], family: 'fetch', service: null, profile: null, input: 'artifact' },
  });
});

test('gateway keeps the shared error constructors and identifier parsers', () => {
  for (const [actual, expected] of [
    [gateway.Conflict, Conflict], [gateway.InputError, InputError], [gateway.ManifestError, ManifestError],
    [gateway.NotFound, NotFound], [gateway.appName, appName], [gateway.bundleId, bundleId],
    [gateway.subject, subject], [gateway.tenantName, tenantName], [gateway.triggerName, triggerName],
  ]) {
    assert.equal(actual, expected);
  }
});
