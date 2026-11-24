import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentBuild, DEAD_MS } from './instances.ts';

const NOW = 100_000;
const row = (build: string | null, startedAt: number, seenAt = NOW) => ({ build, startedAt, seenAt });

test('ADR 0040 item 2: the build whose first replica started last is current, though an older build has a later replica', () => {
  assert.equal(currentBuild([row('old', 1), row('new', 5), row('old', 9)], NOW), 'new');
});

test('ADR 0040 item 2: a rollback is current: an older build started again after a newer one', () => {
  assert.equal(currentBuild([row('new', 5), row('old', 9)], NOW), 'old');
});

test('ADR 0040 item 2: a replica not seen for 10 s counts for no build', () => {
  assert.equal(currentBuild([row('old', 1), row('new', 5, NOW - DEAD_MS - 1)], NOW), 'old');
});

test('ADR 0040 item 2: rows with no build are one build, which can be current', () => {
  assert.equal(currentBuild([row('new', 5), row(null, 9), row(null, 12)], NOW), null);
});
