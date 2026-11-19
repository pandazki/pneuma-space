import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { registered, replica, tempStore, until, withheld } from './lifecycle.fakes.ts';
import { Unavailable } from './runtimes.ts';
import { changeKey, DEFAULT_QUOTA, DEFAULT_TENANT, QuotaExceeded, type AppId, type Instance, type ReleaseNumber, type ReplicaId, type Store } from './model.ts';

const instance = (app: AppId, state: Instance['state'], actor: string | null, handle: string | null = 'left', epoch = 3): Instance => ({
  app, runtime: 'container', release: 1 as ReleaseNumber, specHash: 'h', epoch, state, actor: actor as ReplicaId | null, handle,
  address: null, node: null, home: null, since: 0, awakeAt: null, cpuMillis: 0, memoryMb: 0,
});

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

/** Holds every transaction until `open` is called; `failing` makes the next one throw instead. */
function gated(store: Store) {
  const gate = Promise.withResolvers<void>();
  let begun = 0;
  let failing = false;
  const proxy = new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'transaction') {
        return async (fn: Parameters<Store['transaction']>[0]) => {
          begun++;
          await gate.promise;
          if (failing) {
            failing = false;
            throw new Error('the store is down');
          }
          return target.transaction(fn);
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: proxy, begun: () => begun, open: () => gate.resolve(), failNext: () => void (failing = true) };
}

const awake = (app: AppId): Instance => ({ ...instance(app, 'awake', null), address: 'fake:awake', awakeAt: Date.now() });

test('acquires behind an uncommitted 0 to >0 tally write get no lease until it commits, and share it (INV-3)', async () => {
  const base = tempStore();
  const { app, specFor } = await registered(base);
  await base.insertInstance(awake(app));
  const { store, begun, open } = gated(base);
  const { lifecycle } = replica(store as never, specFor);
  let resolved = 0;
  const acquires = Array.from({ length: 100 }, () => lifecycle.acquire(app, 'request').then(() => resolved++));
  await until('the first tally write is held', () => begun() === 1);
  await sleep(20);
  const early = resolved;
  open();
  await Promise.all(acquires);
  assert.deepEqual([early, resolved, begun()], [0, 100, 1]);
});

test('when the first tally write fails every acquire waiting on it fails and no lease is counted', async () => {
  const base = tempStore();
  const { app, specFor } = await registered(base);
  await base.insertInstance(awake(app));
  const { store, open, failNext } = gated(base);
  const { lifecycle } = replica(store as never, specFor);
  failNext();
  open();
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => lifecycle.acquire(app, 'request')));
  assert.deepEqual([outcomes.filter((o) => o.status === 'rejected').length, lifecycle.leases(app).request], [10, 0]);
});

test('after a failed first tally write the next acquire holds a lease its committed tally covers', async () => {
  const base = tempStore();
  const { app, specFor } = await registered(base);
  await base.insertInstance(awake(app));
  const { store, open, failNext } = gated(base);
  const { lifecycle } = replica(store as never, specFor);
  failNext();
  open();
  await assert.rejects(lifecycle.acquire(app, 'request'));
  await lifecycle.acquire(app, 'request');
  assert.equal((await base.leaseTallies(app)).find((t) => t.replica === 'replica-a')?.request, 1);
});

test('acquires behind a 0 to >0 tally write that the leader\'s reaper beats get no lease on the stopped epoch', async () => {
  const base = tempStore();
  const { app, specFor } = await registered(base, { idle_seconds: 1 });
  const a = replica(base, specFor, 'replica-a');
  await a.lifecycle.reconcile();
  a.lifecycle.release(await a.lifecycle.acquire(app, 'request'));
  const { store, open } = gated(base);
  const b = replica(store as never, specFor, 'replica-b', { leader: false });
  await b.instances.ready();
  await until('replica b sees the instance awake', () => b.lifecycle.state(app) === 'awake');
  let resolved = 0;
  const acquires = [b.lifecycle.acquire(app, 'request'), b.lifecycle.acquire(app, 'request')].map((lease) => lease.then(() => resolved++));
  await until('the reaper puts the idle instance asleep', async () => (await base.instance(app))?.state === 'asleep', 5000);
  const early = resolved;
  open();
  await Promise.all(acquires);
  assert.deepEqual([early, b.driver.starts, (await base.instance(app))?.epoch], [0, 1, 2]);
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
  await store.putReplica({ id: 'replica-b' as ReplicaId, startedAt: Date.now(), seenAt: Date.now(), leading: false });
  const { driver, lifecycle } = replica(store, specFor);
  await lifecycle.reconcile();
  assert.deepEqual([(await store.instance(app))?.state, driver.removed], ['waking', []]);
});

test('kill puts a waking row whose actor is live asleep, kills the instance and clears every replica\'s tally (AC-OPS-15)', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  await store.insertInstance(instance(app, 'waking', 'replica-b'));
  await store.putReplica({ id: 'replica-b' as ReplicaId, startedAt: Date.now(), seenAt: Date.now(), leading: false });
  for (const id of ['replica-a', 'replica-b']) await store.putLeaseTally({ app, replica: id as ReplicaId, epoch: 3, request: 0, channel: 1, trigger: 0, releasedAt: null });
  const { driver, lifecycle, events } = replica(store, specFor);
  await lifecycle.kill(app);
  const row = await store.instance(app);
  assert.deepEqual([row?.state, row?.actor, driver.killed, await store.leaseTallies(app)], ['asleep', null, [app], []]);
  assert.deepEqual(events.at(-1), { ev: 'asleep', reason: 'kill', runtime: 'container' });
});

test('after kill the next acquire wakes the app normally', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  await store.insertInstance(instance(app, 'waking', 'replica-b'));
  const { driver, lifecycle } = replica(store, specFor);
  await lifecycle.kill(app);
  await lifecycle.acquire(app, 'request');
  assert.deepEqual([(await store.instance(app))?.state, driver.starts], ['awake', 1]);
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
  await store.putReplica({ id: 'replica-b' as ReplicaId, startedAt: Date.now(), seenAt: Date.now(), leading: false });
  driver.adopted = [{ ...orphan(waking.app), handle: 'creating' }, orphan(gone.app)];
  t.mock.timers.tick(60_000);
  await until('the orphan is discarded', () => driver.discarded.includes('orphan'));
  assert.deepEqual(driver.discarded, ['orphan']);
});

test('a leader starting while another live replica wakes an app keeps the instance being created, and the wake ends awake with a lease (#8)', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  const [waker, leader] = [replica(store, specFor, 'replica-a', { leader: false }), replica(store, specFor, 'replica-b')];
  await store.putReplica({ id: 'replica-a' as ReplicaId, startedAt: Date.now(), seenAt: Date.now(), leading: false });
  let created!: () => void;
  let finish!: () => void;
  const creating = new Promise<void>((resolve) => (created = resolve));
  const finished = new Promise<void>((resolve) => (finish = resolve));
  waker.driver.start = async (slot) => {
    slot.handle = 'creating';
    leader.driver.adopted = [{ app, handle: 'creating', release: '1', spec: 'h', address: null }];
    created();
    await finished;
    if (leader.driver.discarded.includes('creating')) throw new Error('the instance was removed while it started');
    return 'fake:1';
  };
  const lease = waker.lifecycle.acquire(app, 'request');
  await creating;
  await leader.lifecycle.reconcile();
  finish();
  assert.equal((await lease).address, 'fake:1');
  assert.deepEqual([(await store.instance(app))?.state, leader.driver.discarded], ['awake', []]);
});

test('a leader starting over a waking row whose actor is dead takes it asleep and discards the instance the waker left (#8)', async () => {
  const store = tempStore();
  const { app, specFor } = await registered(store);
  await store.insertInstance(instance(app, 'waking', 'dead', null));
  const { driver, lifecycle } = replica(store, specFor);
  driver.adopted = [orphan(app)];
  await lifecycle.reconcile();
  await until('the leftover instance is discarded', () => driver.discarded.includes('orphan'));
  assert.equal((await store.instance(app))?.state, 'asleep');
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
