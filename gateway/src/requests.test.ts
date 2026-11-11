import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppId, ReplicaId } from './model.ts';
import { gather, RequestLog, RING, type NamedRecord, type Source } from './requests.ts';

const entry = { app: 'id-a' as AppId, kind: 'request', method: 'GET', status: 200, ms: 1, waitMs: 0, cold: false, subject: null, error: null } as const;

function filled(n: number, generation?: number): RequestLog {
  const log = new RequestLog(() => {}, generation);
  for (let i = 0; i < n; i++) {
    log.record({ app: 'id-a' as AppId, kind: 'request', method: 'GET', path: `/${i}`, status: 200, ms: 1, waitMs: 0, cold: false, subject: null, error: null });
  }
  return log;
}

/** A replica answering from its own ring, as admin.ts's `?local=1` does. */
const local = (replica: string, log: RequestLog): Source => ({ name: replica, page: async (cursor, limit) => log.page(cursor, replica as ReplicaId, limit) });

test('the ring keeps the newest 1000 records (AC-P-15)', () => {
  const all = filled(1005).after(0, 2000);
  assert.deepEqual([all.length, all[0].seq, all.at(-1)!.seq], [1000, 6, 1005]);
});

test('after() answers only records with a greater seq, at most limit (AC-P-15)', () => {
  const log = filled(10);
  assert.deepEqual(log.after(5, 3).map((r) => r.seq), [6, 7, 8]);
  assert.deepEqual(log.after(10, 10), []);
});

test('a cursor older than the ring, in the same generation, reads from the oldest record kept without a reset (AC-P-15)', () => {
  const page = filled(1005, 1).page('r1:2@1', 'r1' as ReplicaId, 2000);
  assert.deepEqual([page.reset, page.records.length, page.records[0].seq], [false, 1000, 6]);
});

test('a cursor beyond the newest seq of this generation starts over as a reset (ADR 0031)', () => {
  const page = filled(3, 1).page('r1:500@1', 'r1' as ReplicaId, 10);
  assert.deepEqual([page.reset, page.records.map((r) => r.seq)], [true, [1, 2, 3]]);
});

test('a restarted replica pages out every record its new process keeps exactly once, whatever seq the old cursor held (#18)', async () => {
  const seen = new Map<string, number[]>();
  const kept = new Map<string, number[]>();
  for (const old of [0, 1, 5, 1000]) {
    for (const held of new Set([Math.max(0, old - 1), old, old + 7])) {
      const { cursor } = await gather('', RING, [local('r1', filled(old, 1))]);
      const after = filled(held, 2);
      const pages: number[] = [];
      for (let at = cursor, polls = 0; polls < 10; polls++) {
        const page = await gather(at, 300, [local('r1', after)]);
        if (page.records.length === 0) break;
        pages.push(...page.records.map((r) => r.seq));
        at = page.cursor;
      }
      seen.set(`${old}/${held}`, pages);
      kept.set(`${old}/${held}`, after.after(0, RING).map((r) => r.seq));
    }
  }
  assert.deepEqual(seen, kept);
});

test('a restart is reported once, on the first poll after it (#18)', async () => {
  const { cursor } = await gather('', RING, [local('r1', filled(5, 1))]);
  const restarted = [local('r1', filled(8, 2))];
  const first = await gather(cursor, RING, restarted);
  const second = await gather(first.cursor, RING, restarted);
  assert.deepEqual([first.reset, first.records.length, second.reset, second.records.length], [['r1'], 8, [], 0]);
});

test('a cursor entry without a generation, from before ADR 0031 or written by hand, resets its replica (#18)', async () => {
  const feed = await gather('r1:5', RING, [local('r1', filled(8, 2))]);
  assert.deepEqual([feed.reset, feed.records.length], [['r1'], 8]);
});

test('a first poll without a cursor resets no replica (#18)', async () => {
  assert.deepEqual((await gather('', RING, [local('r1', filled(3, 1))])).reset, []);
});

test('through the fan-out a restart resets only the replica that restarted, and a missing one keeps its entry (#18)', async () => {
  const b = filled(4, 1);
  const down: Source = { name: 'c', page: () => Promise.reject(new Error('timeout')) };
  const { cursor } = await gather('c:2@1', RING, [local('a', filled(2, 1)), local('b', b), down]);
  b.record({ ...entry, path: '/b5' });
  const feed = await gather(cursor, RING, [local('a', filled(3, 2)), local('b', b), down]);
  assert.deepEqual(
    [feed.reset, feed.records.map((r) => [r.replica, r.seq]).sort(), feed.cursor.split(',').sort(), feed.missing],
    [['a'], [['a', 1], ['a', 2], ['a', 3], ['b', 5]], ['a:3@2', 'b:5@1', 'c:2@1'], ['c']],
  );
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
    name: replica, page: async (cursor) => { asked.push(cursor); return { replica: replica as ReplicaId, generation: 1, reset: false, records }; },
  });
  const down: Source = { name: 'c', page: () => Promise.reject(new Error('timeout')) };
  const feed = await gather('a:4@1,b:9@1,c:2@1', 500, [peer('a', [at(5, 10), at(6, 30)]), peer('b', [at(10, 20)]), down]);
  assert.deepEqual(
    [feed.records.map((r) => [r.replica, r.t]), feed.cursor, feed.missing, asked],
    [[['a', 10], ['b', 20], ['a', 30]], 'a:6@1,b:10@1,c:2@1', ['c'], ['a:4@1,b:9@1,c:2@1', 'a:4@1,b:9@1,c:2@1']],
  );
});
