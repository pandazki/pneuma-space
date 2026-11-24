import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { currentBuild, DEAD_MS, Instances } from './instances.ts';
import { tempStore, until } from './lifecycle.fakes.ts';
import type { ReplicaId } from './model.ts';

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

/** A replica of build `old` that leads alone, and a heartbeat that resolves once its row shows the beat ran. */
async function oldLeader(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = tempStore();
  const instances = new Instances(store, { replica: 'gw-old' as ReplicaId, build: 'old' });
  t.after(() => instances.close());
  const told: boolean[] = [];
  await instances.start();
  await instances.onLeader((leading) => void told.push(leading));
  const seen = async () => (await store.replicas()).find((r) => r.id === 'gw-old')!.seenAt;
  const beat = async () => {
    const before = await seen();
    await sleep(2);
    t.mock.timers.tick(2000);
    await until('a heartbeat', async () => (await seen()) > before);
  };
  const newer = () => store.putReplica({ id: 'gw-new' as ReplicaId, startedAt: Date.now() + 1000, seenAt: Date.now(), leading: false, build: 'new' });
  return { store, instances, told, beat, newer };
}

test('ADR 0040 item 4: a leader not on the current build gives up the lead at its next heartbeat and keeps off it while that build lives', async (t) => {
  const { instances, told, beat, newer } = await oldLeader(t);
  await newer();
  await beat();
  await newer();
  await beat();
  assert.deepEqual([instances.leading, told], [false, [true, false]]);
});

test('ADR 0040 item 4: a replica that gave up the lead leads again once the newer build\'s rows are gone', async (t) => {
  const { store, instances, beat, newer } = await oldLeader(t);
  await newer();
  await beat();
  await store.deleteReplica('gw-new' as ReplicaId);
  await beat();
  assert.equal(instances.leading, true);
});
