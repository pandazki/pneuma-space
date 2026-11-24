import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conflict, InputError, ManifestError, NotFound, appName, bundleId, subject, tenantName, triggerName } from '../../shared/values.ts';
import * as gateway from './model.ts';

test('gateway keeps the shared error constructors and identifier parsers', () => {
  for (const [actual, expected] of [
    [gateway.Conflict, Conflict], [gateway.InputError, InputError], [gateway.ManifestError, ManifestError],
    [gateway.NotFound, NotFound], [gateway.appName, appName], [gateway.bundleId, bundleId],
    [gateway.subject, subject], [gateway.tenantName, tenantName], [gateway.triggerName, triggerName],
  ]) {
    assert.equal(actual, expected);
  }
});
