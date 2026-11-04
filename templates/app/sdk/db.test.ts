import test from 'node:test';
import assert from 'node:assert/strict';
import { toPg } from './db.ts';

test('? placeholders become $n for PostgreSQL, except inside quotes and comments', () => {
  assert.equal(
    toPg(`SELECT '?', "a?" FROM t WHERE a = ? AND b = 'it''s ?' AND c = ? -- why?\nAND d = ?`),
    `SELECT '?', "a?" FROM t WHERE a = $1 AND b = 'it''s ?' AND c = $2 -- why?\nAND d = $3`,
  );
});
