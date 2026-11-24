import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from '../src/artifacts.ts';
import { HttpError } from '../src/model.ts';

test('CF-07 inherited JavaScript property names are not declared platform capabilities', () => {
  for (const name of ['toString', 'constructor', '__proto__']) {
    const capabilities = JSON.parse('{"' + name + '":{}}');
    assert.throws(() => parseManifest({ contract: 'pneuma-space.cf/1', runtime: 'node', entry: 'main.mjs', capabilities }), error => error instanceof HttpError && error.status === 400 && error.code === 'capability');
  }
});
