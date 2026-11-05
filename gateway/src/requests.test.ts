import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppId } from './model.ts';
import { RequestLog } from './requests.ts';

function filled(n: number): RequestLog {
  const log = new RequestLog();
  for (let i = 0; i < n; i++) {
    log.record({ app: 'id-a' as AppId, kind: 'request', method: 'GET', path: `/${i}`, status: 200, ms: 1, waitMs: 0, cold: false, subject: null, error: null });
  }
  return log;
}

test('the ring keeps the newest 1000 records (AC-P-15)', () => {
  const all = filled(1005).after(0, 2000);
  assert.deepEqual([all.length, all[0].seq, all.at(-1)!.seq], [1000, 6, 1005]);
});

test('after() answers only records with a greater seq, at most limit (AC-P-15)', () => {
  const log = filled(10);
  assert.deepEqual(log.after(5, 3).map((r) => r.seq), [6, 7, 8]);
  assert.deepEqual(log.after(10, 10), []);
});
