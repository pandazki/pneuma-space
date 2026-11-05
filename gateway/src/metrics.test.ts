import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventLog } from './events.ts';
import { Metrics } from './metrics.ts';
import type { AppId, Stats } from './model.ts';

function fixture() {
  const clock = { now: 1_800_000_000_000 };
  const events = new EventLog(() => {});
  const stats: Stats[] = [];
  const metrics = new Metrics({
    events,
    stats: () => stats,
    apps: async () => [],
    deliveries: { counts: async () => ({ due: 0, delivering: 0, done: 0, failed: 0, cancelled: 0 }), failed: async () => [] },
    nameOf: () => null,
    probes: { redis: async () => 'up' },
    host: async () => ({ cpus: 1, load: [0, 0, 0], memory: { totalBytes: 1, freeBytes: 1 }, data: null }),
    now: () => clock.now,
  });
  const last = (series: number[]) => series.at(-1);
  return { clock, events, stats, metrics, last };
}

const app = 'a1b2c3d4e5f6' as AppId;

test('a wake with its latency lands in the current minute and in the last hour with p50', () => {
  const { events, metrics, last } = fixture();
  events.emit('waking', app);
  events.emit('awake', app, { ms: 840 });
  const snapshot = metrics.snapshot();
  assert.equal(last(snapshot.series.wakes), 1);
  assert.deepEqual(snapshot.wakes.last1h, { count: 1, failures: 0, p50Ms: 840, p95Ms: 840 });
});

test('the growth of the ingress counters between two reads becomes requests and errors in the current minute', async () => {
  const { stats, metrics, last } = fixture();
  stats.push({ app, requests: 10, errors: 1, lastAccessAt: null });
  await metrics.sample();
  stats[0] = { app, requests: 13, errors: 2, lastAccessAt: null };
  const snapshot = metrics.snapshot();
  assert.deepEqual([last(snapshot.series.requests), last(snapshot.series.errors)], [3, 1]);
});

test('a failed delivery lands in the deliveries series', () => {
  const { events, metrics, last } = fixture();
  events.emit('delivery.failed', app, { trigger: 'nightly', delivery: 'd1', attempt: 5, reason: 'HTTP 500' });
  assert.equal(last(metrics.snapshot().series.deliveriesFailed), 1);
});

test('the events ring keeps the last 100, newest last', () => {
  const { events, metrics } = fixture();
  for (let i = 0; i < 120; i++) events.emit('delivery.due', app, { attempt: 0, n: i });
  const { events: ring } = metrics.snapshot();
  assert.equal(ring.length, 100);
  assert.equal(ring.at(-1)!.n, 119);
});
