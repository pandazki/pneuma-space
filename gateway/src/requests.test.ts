import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppId } from './model.ts';
import { RequestLog } from './requests.ts';

test('the ring keeps the newest 1000 records and after() answers only greater seqs (AC-P-15)', () => {
  const log = new RequestLog();
  for (let i = 0; i < 1005; i++) {
    log.record({ app: 'id-a' as AppId, kind: 'request', method: 'GET', path: `/${i}`, status: 200, ms: 1, waitMs: 0, cold: false, subject: null, error: null });
  }
  const all = log.after(0, 2000);
  assert.deepEqual([all.length, all[0].seq, all.at(-1)!.seq], [1000, 6, 1005]);
  assert.deepEqual(log.after(1000, 3).map((r) => r.seq), [1001, 1002, 1003]);
  assert.deepEqual(log.after(1005, 10), []);
});
