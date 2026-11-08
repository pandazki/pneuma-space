import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppId, ReplicaId } from './model.ts';
import { gather, RequestLog, type NamedRecord, type Source } from './requests.ts';

const entry = { app: 'id-a' as AppId, kind: 'request', method: 'GET', status: 200, ms: 1, waitMs: 0, cold: false, subject: null, error: null } as const;

function filled(n: number): RequestLog {
  const log = new RequestLog(() => {});
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

test('a cursor beyond the newest seq, from before a restart, starts over', () => {
  assert.deepEqual(filled(3).after(500, 10).map((r) => r.seq), [1, 2, 3]);
});

test('each record is one JSON line on stdout, marked as a request', () => {
  const lines: string[] = [];
  const log = new RequestLog((line) => lines.push(line));
  log.record({ ...entry, path: '/a' });
  log.record({ ...entry, path: '/b' });
  assert.deepEqual(lines.map((line) => { const { type, seq, path } = JSON.parse(line); return [type, seq, path]; }), [['request', 1, '/a'], ['request', 2, '/b']]);
});

test('the fan-out merges replicas by t, moves each cursor entry, and names a replica that does not answer', async () => {
  const at = (seq: number, t: number) => ({ ...entry, seq, t, path: `/${t}` }) as NamedRecord;
  const asked: string[] = [];
  const peer = (replica: string, records: NamedRecord[]): Source => ({
    name: replica, page: async (cursor) => { asked.push(cursor); return { replica: replica as ReplicaId, records }; },
  });
  const down: Source = { name: 'c', page: () => Promise.reject(new Error('timeout')) };
  const feed = await gather('a:4,b:9,c:2', 500, [peer('a', [at(5, 10), at(6, 30)]), peer('b', [at(10, 20)]), down]);
  assert.deepEqual(
    [feed.records.map((r) => [r.replica, r.t]), feed.cursor, feed.missing, asked],
    [[['a', 10], ['b', 20], ['a', 30]], 'a:6,b:10,c:2', ['c'], ['a:4,b:9,c:2', 'a:4,b:9,c:2']],
  );
});
