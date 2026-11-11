// The Store contract, run against every Store (ADR 0025 item 2).

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, test, type TestContext } from 'node:test';
import { Instances } from './instances.ts';
import {
  DEFAULT_POLICY, DEFAULT_QUOTA, DEFAULT_TENANT, IDEMPOTENCY_WINDOW_MS, USAGE_COUNTERS, changeKey,
  type App, type AppId, type AppName, type Binding, type BundleId, type Delivery, type DeliveryId, type ImageId, type Instance, type ReleaseNumber, type ReplicaId, type Store,
  type Subject, type TenantName, type TriggerName, type Usage,
} from './model.ts';

export type OpenStore = (options: { readonly volumeGb: number }) => Promise<Store & { close(): Promise<void> }>;

const appId = (name: string) => `id-${name}` as AppId;
const replica = 'replica-a' as ReplicaId;

export function app(name: string, fields: Partial<App> = {}): App {
  return {
    name: name as AppName, id: appId(name), tenant: DEFAULT_TENANT, access: 'org', owner: 'user:ann' as Subject, status: 'registered',
    current: null, policyOverride: {}, registeredAt: 0, version: 1, ...fields,
  };
}

function delivery(id: string, fields: Partial<Delivery>): Delivery {
  return {
    id: id as DeliveryId, app: appId('a1'), trigger: 'reindex' as TriggerName, scheduledFor: null, caller: null,
    idempotencyKey: null, body: new Uint8Array(), state: 'due', attempts: 0, nextAttemptAt: 0, createdAt: 0, replica: null, ...fields,
  };
}

function instance(name: string, fields: Partial<Instance> = {}): Instance {
  return {
    app: appId(name), runtime: 'container', release: 1 as ReleaseNumber, specHash: 'h1', epoch: 0, state: 'asleep', actor: null, handle: null,
    address: null, node: null, home: null, since: 1, awakeAt: null, cpuMillis: 0, memoryMb: 0, ...fields,
  };
}

/** An app with an instance row, two replicas' lease tallies, a guard row and a full log row. */
async function seeded(store: Store, name: string): Promise<AppId> {
  const id = appId(name);
  await store.putApp(app(name));
  await store.insertInstance(instance(name));
  for (const r of [replica, 'replica-b' as ReplicaId]) await store.putLeaseTally({ app: id, replica: r, epoch: 0, request: 1, channel: 0, trigger: 0, releasedAt: null });
  await store.putGuard({ app: id, release: 1 as ReleaseNumber, failures: [1], quarantineReason: null, quarantinedAt: null });
  await store.putInstanceLog({ app: id, release: 1 as ReleaseNumber, endedAt: 1, reason: 'crashed', tail: 'x'.repeat(65_536) });
  return id;
}

const held = (store: Store, app: AppId) => Promise.all([store.instance(app), store.leaseTallies(app), store.guard(app), store.instanceLog(app)]);

/** Waits until every expected key was announced, then a little longer so an extra one would show. */
async function announced(seen: readonly string[], expected: readonly string[]): Promise<void> {
  for (let waited = 0; waited < 2000 && !expected.every((key) => seen.includes(key)); waited += 10) await sleep(10);
  await sleep(100);
}

export function storeContract(name: string, open: OpenStore): void {
  describe(`${name} store contract`, () => {
    let store: Awaited<ReturnType<OpenStore>>;
    before(async () => {
      store = await open({ volumeGb: 2 });
    });
    after(() => store.close());

    test('a scheduled slot is stored once', async () => {
      const first = await store.insertDelivery(delivery('s1', { scheduledFor: 60_000 }));
      assert.equal((await store.insertDelivery(delivery('s2', { scheduledFor: 60_000 }))).id, first.id);
    });

    test('the same idempotency key returns the same delivery within 24 h and a new one after', async () => {
      const t0 = 1_000_000_000;
      await store.insertDelivery(delivery('k1', { idempotencyKey: 'job-7', createdAt: t0 }));
      assert.equal((await store.insertDelivery(delivery('k2', { idempotencyKey: 'job-7', createdAt: t0 + IDEMPOTENCY_WINDOW_MS - 1 }))).id, 'k1');
      assert.equal((await store.insertDelivery(delivery('k3', { idempotencyKey: 'job-7', createdAt: t0 + IDEMPOTENCY_WINDOW_MS + 1 }))).id, 'k3');
    });

    test('two concurrent read-modify-write transactions on one row both take effect', async () => {
      await store.putApp(app('one'));
      const bump = () => store.transaction(async (tx) => {
        const row = (await tx.app(app('one').name))!;
        await sleep(20);
        await tx.putApp({ ...row, registeredAt: row.registeredAt + 1 });
      });
      await Promise.all([bump(), bump()]);
      assert.equal((await store.app(app('one').name))?.registeredAt, 2);
    });

    test('exclusive runs commands on one name one at a time and on another name meanwhile', async () => {
      const order: string[] = [];
      let started!: () => void;
      let finish!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      const gate = new Promise<void>((resolve) => (finish = resolve));
      const first = store.exclusive('x' as AppName, async () => {
        order.push('x1 start');
        started();
        await gate;
        order.push('x1 end');
      });
      const second = store.exclusive('x' as AppName, async () => order.push('x2'));
      await running;
      await store.exclusive('y' as AppName, async () => order.push('y'));
      finish();
      await Promise.all([first, second]);
      assert.deepEqual(order, ['x1 start', 'y', 'x1 end', 'x2']);
    });

    test('exclusiveBundle inside commands on two names runs work on one bundle one at a time and on another bundle meanwhile', async () => {
      const order: string[] = [];
      let started!: () => void;
      let finish!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      const gate = new Promise<void>((resolve) => (finish = resolve));
      const first = store.exclusive('p' as AppName, () => store.exclusiveBundle('b1' as BundleId, async () => {
        order.push('p start');
        started();
        await gate;
        order.push('p end');
      }));
      await running;
      const second = store.exclusive('q' as AppName, () => store.exclusiveBundle('b1' as BundleId, async () => order.push('q')));
      await store.exclusive('r' as AppName, () => store.exclusiveBundle('b2' as BundleId, async () => order.push('r')));
      finish();
      await Promise.all([first, second]);
      assert.deepEqual(order, ['p start', 'r', 'p end', 'q']);
    });

    test('bundleReferenced answers for releases of apps other than the one named', async () => {
      const release = (name: string, bundle: string) => store.putRelease({
        app: appId(name), number: 1 as ReleaseNumber, image: null, manifest: { contract: 1, capabilities: {} }, bundle: bundle as BundleId, runtime: null, releaseKey: bundle, publishedAt: 0,
      });
      await release('ref-own', 'only-own');
      await release('ref-own-2', 'shared');
      await release('ref-other', 'shared');
      const asked = [['only-own', 'ref-own'], ['shared', 'ref-own-2'], ['absent', 'ref-own']] as const;
      assert.deepEqual(await Promise.all(asked.map(([bundle, app]) => store.bundleReferenced(bundle as BundleId, appId(app)))), [false, true, false]);
    });

    test('a transaction announces each key it wrote once, after commit, and nothing when it rolls back', async () => {
      const seen: string[] = [];
      store.onChange((change) => seen.push(changeKey(change)));
      let during: string[] = [];
      await store.transaction(async (tx) => {
        await tx.putApp(app('told'));
        await tx.putApp(app('told', { owner: 'user:bob' as Subject }));
        await tx.putPolicy(DEFAULT_POLICY);
        during = [...seen];
      });
      await assert.rejects(store.transaction(async (tx) => {
        await tx.putApp(app('untold'));
        throw new Error('roll back');
      }), /roll back/);
      await announced(seen, ['app/told', 'policy']);
      assert.deepEqual(during, []);
      assert.deepEqual(seen.filter((key) => ['app/told', 'app/untold', 'policy'].includes(key)).sort(), ['app/told', 'policy']);
    });

    test('tenant round-trips with its quota', async () => {
      const tenant = { name: 'blue' as TenantName, display: 'Blue team', quota: { ...DEFAULT_QUOTA, apps: null }, createdAt: 5 };
      await store.putTenant(tenant);
      assert.deepEqual(await store.tenant(tenant.name), tenant);
    });

    test('user round-trips, keeping its first sighting', async () => {
      await store.putUser({ id: 'ann+ops@example.com', name: 'Ann', groups: ['ops'], firstSeen: 1, lastSeen: 1 });
      await store.putUser({ id: 'ann+ops@example.com', name: 'Ann B', groups: [], firstSeen: 9, lastSeen: 9 });
      assert.deepEqual(await store.user('ann+ops@example.com'), { id: 'ann+ops@example.com', name: 'Ann B', groups: [], firstSeen: 1, lastSeen: 9 });
    });

    test('membership round-trips by tenant and by user and is deleted', async () => {
      const member = { tenant: 'green' as TenantName, user: 'cid', role: 'admin' } as const;
      await store.putMembership(member);
      assert.deepEqual([await store.memberships({ tenant: member.tenant }), await store.memberships({ user: 'cid' })], [[member], [member]]);
      await store.deleteMembership(member.tenant, 'cid');
      assert.deepEqual(await store.memberships({ tenant: member.tenant }), []);
    });

    test('token round-trips by hash and by tenant, and revokes once', async () => {
      const token = {
        id: 't1', tenant: 'red' as TenantName, subject: 'service:red.ci' as Subject, label: 'ci', hash: 'h-t1', createdBy: 'user:ann' as Subject,
        createdAt: 3, revokedAt: null,
      };
      await store.putToken(token);
      assert.deepEqual([await store.token('h-t1'), await store.tokens(token.tenant)], [token, [token]]);
      assert.deepEqual([await store.revokeToken('t1', 7), await store.revokeToken('t1', 8)], [true, false]);
      assert.equal((await store.token('h-t1'))?.revokedAt, 7);
    });

    test('replica round-trips and a sweep removes it with its lease tallies', async () => {
      await store.putReplica({ id: 'old' as ReplicaId, startedAt: 1, seenAt: 2, leading: true });
      await store.putLeaseTally({ app: appId('swept'), replica: 'old' as ReplicaId, epoch: 1, request: 1, channel: 0, trigger: 0, releasedAt: null });
      assert.deepEqual((await store.replicas()).find((r) => r.id === 'old'), { id: 'old', startedAt: 1, seenAt: 2, leading: true });
      assert.deepEqual(await store.sweepReplicas(3), ['old']);
      assert.deepEqual([await store.replicas(), await store.leaseTallies(appId('swept'))], [[], []]);
    });

    test('instance inserts once and writes only when state and epoch still match', async () => {
      const asleep = instance('cas');
      const waking = { ...asleep, state: 'waking', epoch: 1, actor: replica } as const;
      assert.deepEqual([await store.insertInstance(asleep), await store.insertInstance(asleep)], [true, false]);
      assert.equal(await store.casInstance({ runtime: 'container', state: 'asleep', epoch: 0 }, waking), true);
      assert.equal(await store.casInstance({ runtime: 'container', state: 'asleep', epoch: 0 }, { ...waking, epoch: 2 }), false);
      assert.deepEqual(await store.instance(asleep.app), waking);
    });

    test('an instance CAS that names another runtime writes nothing', async () => {
      const asleep = instance('other-runtime');
      await store.insertInstance(asleep);
      assert.equal(await store.casInstance({ runtime: 'isolate', state: 'asleep', epoch: 0 }, { ...asleep, runtime: 'isolate', state: 'waking', epoch: 1 }), false);
      assert.deepEqual(await store.instance(asleep.app), asleep);
    });

    test('deleteInstance removes the instance and its lease tallies', async () => {
      const row = instance('purged');
      await store.insertInstance(row);
      await store.putLeaseTally({ app: row.app, replica, epoch: 0, request: 1, channel: 0, trigger: 0, releasedAt: null });
      await store.deleteInstance(row.app);
      assert.deepEqual([await store.instance(row.app), await store.leaseTallies(row.app)], [null, []]);
    });

    test('a lease tally write announces no change', async () => {
      const seen: string[] = [];
      store.onChange((change) => seen.push(changeKey(change)));
      await store.putLeaseTally({ app: appId('quiet'), replica, epoch: 1, request: 1, channel: 0, trigger: 0, releasedAt: null });
      await announced(seen, []);
      assert.deepEqual(seen.filter((key) => key === `instance/${appId('quiet')}`), []);
    });

    test('a write to a release raises the app version', async () => {
      await store.putApp(app('versioned'));
      await store.putRelease({
        app: appId('versioned'), number: 1 as ReleaseNumber, image: null, manifest: { contract: 1, capabilities: {} }, bundle: null, runtime: null, releaseKey: 'k', publishedAt: 0,
      });
      assert.equal((await store.app('versioned' as AppName))?.version, 2);
    });

    test('appsWithCurrent pairs every app with its current release or null', async () => {
      const release = {
        app: appId('paired'), number: 2 as ReleaseNumber, image: 'sha256:2' as ImageId, manifest: { contract: 1, capabilities: {} }, bundle: null, runtime: 'container', releaseKey: 'k2', publishedAt: 7,
      } as const;
      await store.putApp(app('paired'));
      await store.putRelease({ ...release, number: 1 as ReleaseNumber, image: 'sha256:1' as ImageId });
      await store.putRelease(release);
      await store.putApp(app('paired', { current: 2 as ReleaseNumber, version: 4 }));
      await store.putApp(app('unpaired'));
      const pairs = (await store.appsWithCurrent()).filter((p) => ['paired', 'unpaired'].includes(p.app.name));
      assert.deepEqual(pairs.map((p) => [p.app.name, p.release]), [['paired', release], ['unpaired', null]]);
    });

    test('rewriting a binding unchanged leaves the app version as it was', async () => {
      await store.putApp(app('steady'));
      const binding = { app: appId('steady'), kind: 'kv', provider: 'redis', state: 'active', resource: { user: 'u' } } as const;
      await store.putBinding(binding);
      const before = (await store.app('steady' as AppName))?.version;
      await store.putBinding(binding);
      assert.equal((await store.app('steady' as AppName))?.version, before);
    });

    test('a due delivery is claimed once', async () => {
      await store.insertDelivery(delivery('claimed', {}));
      assert.deepEqual([await store.claimDelivery('claimed' as DeliveryId, replica, 1), await store.claimDelivery('claimed' as DeliveryId, replica, 1)], [true, false]);
      assert.deepEqual((await store.deliveries({ state: 'delivering' })).find((d) => d.id === 'claimed')?.replica, replica);
    });

    test('lease tally round-trips per replica', async () => {
      const tally = { app: appId('leased'), replica, epoch: 4, request: 2, channel: 1, trigger: 0, releasedAt: 9 };
      await store.putLeaseTally(tally);
      assert.deepEqual(await store.leaseTallies(tally.app), [tally]);
    });

    test('guard round-trips and is deleted', async () => {
      const guard = { app: appId('guarded'), release: 2 as ReleaseNumber, failures: [1, 2, 3], quarantineReason: 'crashed', quarantinedAt: 3 };
      await store.putGuard(guard);
      assert.deepEqual(await store.guard(guard.app), guard);
      await store.deleteGuard(guard.app);
      assert.equal(await store.guard(guard.app), null);
    });

    test('usage rows hold absolute counts per replica and read back summed', async () => {
      const zero = Object.fromEntries(USAGE_COUNTERS.map((c) => [c, 0])) as Record<(typeof USAGE_COUNTERS)[number], number>;
      const row = (r: string, requests: number): Usage => ({ ...zero, app: appId('used'), tenant: DEFAULT_TENANT, step: 3600, start: 0, replica: r as ReplicaId, requests });
      await store.putUsage([row('a', 1), row('b', 5)]);
      await store.putUsage([row('a', 2)]);
      assert.deepEqual(await store.usage({ step: 3600, app: appId('used'), from: 0, to: 1 }), [
        { ...zero, app: appId('used'), tenant: DEFAULT_TENANT, step: 3600, start: 0, requests: 7 },
      ]);
    });

    test('usage with an owner reads only the apps that subject owns', async () => {
      const zero = Object.fromEntries(USAGE_COUNTERS.map((c) => [c, 0])) as Record<(typeof USAGE_COUNTERS)[number], number>;
      const tenant = 'umber' as TenantName;
      await store.putApp(app('u-bob', { tenant, owner: 'user:bob' as Subject }));
      await store.putApp(app('u-dee', { tenant, owner: 'user:dee' as Subject }));
      await store.putUsage(['u-bob', 'u-dee'].map((name) => ({ ...zero, app: appId(name), tenant, step: 3600, start: 0, replica, requests: 1 })));
      assert.deepEqual((await store.usage({ step: 3600, tenant, owner: 'user:bob' as Subject, from: 0, to: 1 })).map((b) => b.app), [appId('u-bob')]);
    });

    test('events get increasing ids and the library clock', async () => {
      const before = Date.now() - 1000;
      await store.insertEvents([1, 2].map((n) => ({ replica, ev: 'round-trip', app: null, tenant: null, body: { n } })));
      const rows = await store.events({ ev: 'round-trip' });
      assert.deepEqual(rows.map((e) => e.body), [{ n: 1 }, { n: 2 }]);
      assert.ok(rows[0].id < rows[1].id && rows.every((e) => e.at >= before));
    });

    test('events with newest read the last matching rows, oldest first', async () => {
      await store.insertEvents([1, 2, 3].map((n) => ({ replica, ev: 'tail', app: null, tenant: null, body: { n } })));
      assert.deepEqual((await store.events({ ev: 'tail', newest: 2 })).map((e) => e.body.n), [2, 3]);
    });

    test('audit rows read back newest first', async () => {
      const row = {
        at: 1, actor: 'user:ann' as Subject, actorTenant: DEFAULT_TENANT, tenant: DEFAULT_TENANT, action: 'app.publish', targetKind: 'app',
        target: 'audited', result: 'ok', details: { release: 1 },
      } as const;
      const first = await store.insertAudit(row);
      const second = await store.insertAudit({ ...row, at: 2, action: 'app.remove' });
      assert.deepEqual(await store.audit({ target: 'audited' }), [{ ...row, id: second, at: 2, action: 'app.remove' }, { ...row, id: first }]);
    });

    test('audit with an owner reads only rows whose target is an app that subject owns', async () => {
      const tenant = 'amber' as TenantName;
      await store.putApp(app('a-bob', { tenant, owner: 'user:bob' as Subject }));
      await store.putApp(app('a-dee', { tenant, owner: 'user:dee' as Subject }));
      const row = { at: 1, actor: 'user:ann' as Subject, actorTenant: tenant, tenant, action: 'app.publish', targetKind: 'app', result: 'ok', details: {} } as const;
      for (const target of ['a-bob', 'a-dee']) await store.insertAudit({ ...row, target });
      await store.insertAudit({ ...row, action: 'member.add', targetKind: 'member', target: 'a-bob' });
      assert.deepEqual((await store.audit({ tenant, owner: 'user:bob' as Subject })).map((a) => a.target), ['a-bob']);
    });

    test('quotaUsed counts each files and SQLite binding of the tenant at the provisioned volume size', async () => {
      const tenant = 'violet' as TenantName;
      await store.putApp(app('v1', { tenant }));
      await store.putApp(app('v2'));
      const bind = (name: string, kind: Binding['kind'], provider: Binding['provider']) =>
        store.putBinding({ app: appId(name), kind, provider, state: 'suspended', resource: {} });
      await bind('v1', 'files', 'volume');
      await bind('v1', 'db', 'sqlite');
      await bind('v1', 'db', 'postgres');
      await bind('v1', 'object', 's3');
      await bind('v2', 'files', 'volume');
      assert.equal((await store.quotaUsed(tenant)).storage_gb, 4);
    });

    test('instance log keeps one row per app', async () => {
      const log = { app: appId('logged'), release: 1 as ReleaseNumber, endedAt: 1, reason: 'crashed', tail: 'boom\n' };
      await store.putInstanceLog(log);
      await store.putInstanceLog({ ...log, endedAt: 2, reason: 'retired' });
      assert.deepEqual(await store.instanceLog(log.app), { ...log, endedAt: 2, reason: 'retired' });
    });

    /** A store of its own: on SQLite its replicas meet no other test's rows, and they stop listening when the test ends. */
    async function own(t: TestContext) {
      const store = await open({ volumeGb: 2 });
      const replicas: Instances[] = [];
      t.after(async () => {
        for (const instances of replicas) await instances.close();
        await store.close();
      });
      const start = (id: string) => {
        const instances = new Instances(store, { replica: id as ReplicaId, leader: false });
        replicas.push(instances);
        return instances.ready();
      };
      return { store, start };
    }

    test('a purge deletes the app\'s instance, lease tally, guard and log rows and leaves another app\'s (ADR 0020 item 8)', async (t) => {
      const { store, start } = await own(t);
      const [gone, kept] = [await seeded(store, 'purge-gone'), await seeded(store, 'purge-kept')];
      await start('replica-a');
      const before = await held(store, kept);
      await store.deleteApp(gone);
      for (let waited = 0; waited < 3000 && (await store.instanceLog(gone)) !== null; waited += 10) await sleep(10);
      assert.deepEqual([await held(store, gone), await held(store, kept)], [[null, [], null, null], before]);
    });

    test('a replica that starts deletes the rows of apps the library no longer has, a lone log row included (ADR 0020 item 8)', async (t) => {
      const { store, start } = await own(t);
      const [gone, kept] = [await seeded(store, 'start-gone'), await seeded(store, 'start-kept')];
      await store.deleteApp(gone);
      await store.putInstanceLog({ app: appId('start-never'), release: 1 as ReleaseNumber, endedAt: 1, reason: 'retired', tail: 'x'.repeat(65_536) });
      const before = await held(store, kept);
      await start('replica-a');
      assert.deepEqual([await held(store, gone), await held(store, appId('start-never')), await held(store, kept)], [[null, [], null, null], [null, [], null, null], before]);
    });

    test('two replicas that clean up the same purged app at once both succeed (ADR 0020 item 8)', async (t) => {
      const { store, start } = await own(t);
      const [gone, kept] = [await seeded(store, 'twice-gone'), await seeded(store, 'twice-kept')];
      await store.deleteApp(gone);
      const before = await held(store, kept);
      await Promise.all([start('replica-a'), start('replica-b')]);
      assert.deepEqual([await held(store, gone), await held(store, kept)], [[null, [], null, null], before]);
    });
  });
}
