import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { registered, replica, tempStore, until } from './lifecycle.fakes.ts';
import { Unavailable } from './runtimes.ts';
import { changeKey, DEFAULT_QUOTA, DEFAULT_TENANT, QuotaExceeded, type ReleaseNumber, type ReplicaId, type Store } from './model.ts';

/** Counts the calls made through it. */
function counting(store: Store): { store: Store; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return value.apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

test('two replicas acquiring an asleep app at once start one instance: one waking CAS wins', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  const [a, b] = [replica(store, specFor, 'replica-a'), replica(store, specFor, 'replica-b', { leader: false })];
  const [one, two] = await Promise.all([a.lifecycle.acquire(app, 'request'), b.lifecycle.acquire(app, 'request')]);
  assert.equal(a.driver.starts + b.driver.starts, 1);
  assert.equal(one.address, two.address);
});

test('an acquire on an awake app whose tally this replica holds makes no store call', async () => {
  const { store, calls } = counting(tempStore());
  const { app, specFor } = await registered(store as never);
  const { lifecycle } = replica(store as never, specFor);
  await lifecycle.acquire(app, 'request');
  calls.length = 0;
  await lifecycle.acquire(app, 'request');
  assert.deepEqual(calls, []);
});

test('releasing every lease writes this replica\'s tally once, on the 0 edge', async () => {
  const { store, calls } = counting(tempStore());
  const { app, specFor } = await registered(store as never);
  const { lifecycle } = replica(store as never, specFor);
  const leases = [await lifecycle.acquire(app, 'request'), await lifecycle.acquire(app, 'request'), await lifecycle.acquire(app, 'request')];
  calls.length = 0;
  for (const lease of leases) lifecycle.release(lease);
  await sleep(1300);
  assert.equal(calls.filter((call) => call === 'putLeaseTally').length, 1);
});

test('the leader takes a waking row whose actor is a dead replica back to asleep and removes its handle', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  await store.insertInstance({
    app, runtime: 'container', release: 1 as ReleaseNumber, specHash: 'h', epoch: 3, state: 'waking', actor: 'dead' as ReplicaId, handle: 'left',
    address: null, node: null, home: null, since: 0, awakeAt: null, cpuMillis: 0, memoryMb: 0,
  });
  const { driver, lifecycle } = replica(store, specFor);
  await lifecycle.reconcile();
  assert.deepEqual([(await store.instance(app))?.state, driver.removed], ['asleep', ['left']]);
});

test('an instance end that two replicas both report records one Guard failure', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store, { max_failures: 5 });
  const [a, b] = [replica(store, specFor, 'replica-a'), replica(store, specFor, 'replica-b', { leader: false })];
  await Promise.all([a.lifecycle.reconcile(), b.lifecycle.reconcile()]);
  a.lifecycle.release(await a.lifecycle.acquire(app, 'request'));
  await until('replica b sees the instance awake', () => b.lifecycle.state(app) === 'awake');
  const { handle } = (await store.instance(app))!;
  a.driver.end(app, handle!, { ev: 'crashed', reason: 'exit 1' });
  b.driver.end(app, handle!, { ev: 'crashed', reason: 'exit 1' });
  await until('both replicas see it asleep', () => a.lifecycle.state(app) === 'asleep' && b.lifecycle.state(app) === 'asleep');
  await sleep(50);
  assert.equal((await store.guard(app))?.failures.length, 1);
});

test('a wake over the tenant\'s quota throws QuotaExceeded and leaves the row asleep with no Guard failure', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  await store.putTenant({ name: DEFAULT_TENANT, display: DEFAULT_TENANT, quota: { ...DEFAULT_QUOTA, awake: 0 }, createdAt: 0 });
  await store.insertInstance({
    app, runtime: 'container', release: 1 as ReleaseNumber, specHash: 'h', epoch: 1, state: 'asleep', actor: null, handle: null,
    address: null, node: null, home: null, since: 0, awakeAt: null, cpuMillis: 0, memoryMb: 0,
  });
  const { lifecycle } = replica(store, specFor);
  await assert.rejects(lifecycle.acquire(app, 'request'), QuotaExceeded);
  assert.deepEqual([(await store.instance(app))?.state, await store.guard(app)], ['asleep', null]);
});

test('unquarantine deletes the guard row and a change notice for the app follows', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  await store.putGuard({ app, release: 1 as ReleaseNumber, failures: [1, 2, 3], quarantineReason: 'exit 1', quarantinedAt: 3 });
  const { guard, instances } = replica(store, specFor);
  await instances.ready();
  const seen: string[] = [];
  store.onChange((change) => seen.push(changeKey(change)));
  await guard.unquarantine(app);
  assert.deepEqual([await store.guard(app), seen], [null, [`instance/${app}`]]);
});

test('an acquire on an awake app whose address the driver no longer maps to its handle answers Unavailable', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  const { driver, lifecycle } = replica(store, specFor);
  await lifecycle.acquire(app, 'request');
  driver.serving = false;
  await assert.rejects(lifecycle.acquire(app, 'request'), Unavailable);
});
