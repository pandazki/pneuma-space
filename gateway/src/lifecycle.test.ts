import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { registered, replica, tempStore, until } from './lifecycle.fakes.ts';
import { Unavailable } from './runtimes.ts';
import { changeKey, DEFAULT_QUOTA, DEFAULT_TENANT, QuotaExceeded, type AppId, type Instance, type ReleaseNumber, type ReplicaId, type Store } from './model.ts';

const instance = (app: AppId, state: Instance['state'], actor: string | null, handle: string | null = 'left', epoch = 3): Instance => ({
  app, runtime: 'container', release: 1 as ReleaseNumber, specHash: 'h', epoch, state, actor: actor as ReplicaId | null, handle,
  address: null, node: null, home: null, since: 0, awakeAt: null, cpuMillis: 0, memoryMb: 0,
});

/** Grants the lead only once `grant` is called. */
function withheld(store: Store): { store: Store; grant: () => void } {
  let granted = false;
  const proxy = new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'leader') return async () => (granted ? target.leader() : null);
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: proxy, grant: () => void (granted = true) };
}

const orphan = (app: AppId) => ({ app, handle: 'orphan', release: '1', spec: 'h', address: 'fake:9' });

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

test('the awake row carries the node the driver started the instance on', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  const { lifecycle, driver } = replica(store, specFor);
  driver.node = 'n3';
  await lifecycle.acquire(app, 'request');
  assert.equal((await store.instance(app))?.node, 'n3');
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
  await store.insertInstance(instance(app, 'waking', 'dead'));
  const { driver, lifecycle } = replica(store, specFor);
  await lifecycle.reconcile();
  assert.deepEqual([(await store.instance(app))?.state, driver.removed], ['asleep', ['left']]);
});

for (const state of ['waking', 'stopping'] as const) {
  test(`a follower restarting under the id a ${state} row names takes the row back to asleep and removes its handle`, async () => {
    const store = tempStore();
    const { app, specFor } = await registered(store);
    await store.insertInstance(instance(app, state, 'replica-b'));
    const { driver, lifecycle } = replica(store, specFor, 'replica-b', { leader: false });
    await lifecycle.reconcile();
    assert.deepEqual([(await store.instance(app))?.state, driver.removed], ['asleep', ['left']]);
  });
}

test('a follower restarting under the id a draining row names drains it', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  await store.insertInstance(instance(app, 'draining', 'replica-b'));
  const { driver, lifecycle } = replica(store, specFor, 'replica-b', { leader: false });
  await lifecycle.reconcile();
  await until('the drained row is asleep', async () => (await store.instance(app))?.state === 'asleep');
  assert.deepEqual(driver.removed, ['left']);
});

test('a replica restarting under its id drops the lease tally its earlier process left, so no replica counts that lease', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  await store.insertInstance({ ...instance(app, 'awake', null), address: 'fake:1', awakeAt: Date.now() });
  await store.putLeaseTally({ app, replica: 'replica-a' as ReplicaId, epoch: 3, request: 0, channel: 1, trigger: 0, releasedAt: null });
  const a = replica(store, specFor, 'replica-a');
  await a.instances.start();
  const b = replica(store, specFor, 'replica-b', { leader: false });
  await b.instances.ready();
  await a.instances.close();
  assert.notEqual(b.lifecycle.sleepsAt(app), null);
});

test('a row whose actor is another live replica is left alone at startup', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  await store.insertInstance(instance(app, 'waking', 'replica-b'));
  await store.putReplica({ id: 'replica-b' as ReplicaId, startedAt: Date.now(), seenAt: Date.now() });
  const { driver, lifecycle } = replica(store, specFor);
  await lifecycle.reconcile();
  assert.deepEqual([(await store.instance(app))?.state, driver.removed], ['waking', []]);
});

test('a replica that gains the lead after it started discards an instance no row names', async () => {
  const { store, grant } = withheld(tempStore());
  const { app, specFor } = await registered(store as never);
  const { driver, instances, lifecycle } = replica(store as never, specFor);
  await lifecycle.reconcile();
  driver.adopted = [orphan(app)];
  grant();
  await instances.start();
  await until('the orphan is discarded', () => driver.discarded.includes('orphan'));
  await instances.close();
});

test('the leader discards every 60 s an instance that appeared after the last sweep and no row names', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = tempStore();
  const { app, specFor } = await registered(store);
  const { driver, lifecycle } = replica(store, specFor);
  await lifecycle.reconcile();
  // Lets the sweep on gaining the lead finish, so the tick does not fold into it.
  await sleep(10);
  driver.adopted = [orphan(app)];
  t.mock.timers.tick(60_000);
  await until('the orphan is discarded', () => driver.discarded.includes('orphan'));
});

test('the sweep keeps an instance whose row is waking, as its waker may still be creating it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = tempStore();
  const [waking, gone] = [await registered(store), await registered(store)];
  const specFor = (app: AppId) => waking.specFor(app) ?? gone.specFor(app);
  const { driver, lifecycle } = replica(store, specFor);
  await lifecycle.reconcile();
  await store.insertInstance(instance(waking.app, 'waking', 'replica-b', null));
  await store.putReplica({ id: 'replica-b' as ReplicaId, startedAt: Date.now(), seenAt: Date.now() });
  driver.adopted = [{ ...orphan(waking.app), handle: 'creating' }, orphan(gone.app)];
  t.mock.timers.tick(60_000);
  await until('the orphan is discarded', () => driver.discarded.includes('orphan'));
  assert.deepEqual(driver.discarded, ['orphan']);
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
  await store.insertInstance(instance(app, 'asleep', null, null, 1));
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
