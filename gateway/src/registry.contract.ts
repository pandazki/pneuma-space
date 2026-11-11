// What two gateway replicas may assume of each other's commands over one platform library, run against every Store (ADR 0028).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Conflict, QuotaExceeded, appName, parseManifest, subject, tenantName, type BundleId, type Store } from './model.ts';
import { world } from './registry.fakes.ts';

/** Two stores over one platform library, one per replica; a store that only one process may open is returned twice. */
export type OpenReplicas = () => Promise<readonly [Store, Store]>;

const ann = subject('user:ann');
const tag = () => randomBytes(3).toString('hex');

export function replicaContract(name: string, open: OpenReplicas): void {
  describe(`two registries over one ${name} store`, () => {
    test('50 concurrent first publishes through two replicas never take the tenant past storage_gb, and only quota refuses (#11)', async () => {
      const [one, two] = await open();
      const w = world();
      const replicas = [await w.replica(one), await w.replica(two)];
      const volume = w.providers.get('volume')!;
      const ensure = volume.ensure.bind(volume);
      // Provisioning takes time, as a real backend's does.
      volume.ensure = async (app, current) => (await sleep(10), ensure(app, current));
      const run = tag();
      const tenant = tenantName(`t-${run}`);
      const limit = 3;
      await replicas[0].createTenant(tenant, 'T', ['ann']);
      await replicas[0].setQuota(tenant, { storage_gb: limit });
      const manifest = parseManifest({ contract: 1, capabilities: { files: {} } });
      const samples: number[] = [];
      let running = true;
      const sampler = (async () => {
        while (running) {
          samples.push((await one.quotaUsed(tenant)).storage_gb);
          await sleep(1);
        }
      })();
      const outcomes = await Promise.allSettled(Array.from({ length: 50 }, (_, i) =>
        replicas[i % 2].publish({ name: appName(`q-${run}-${i}`), image: 'example:1', manifest, bundle: null, owner: ann, tenant })));
      running = false;
      await sampler;
      samples.push((await one.quotaUsed(tenant)).storage_gb);      const refused = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason as Error] : []));
      assert.deepEqual(refused.filter((e) => !(e instanceof QuotaExceeded)).map(String), []);
      assert.equal(outcomes.length - refused.length, limit);
      assert.ok(Math.max(...samples) <= limit, `used peaked at ${Math.max(...samples)} GiB over ${samples.length} samples; limit ${limit}`);
    });

    test('a publish racing the purge that deletes its bundle commits with the bundle kept or is refused, in 100 rounds (#13)', async () => {
      const [one, two] = await open();
      const w = world();
      w.services.add('runner');
      let arrived = () => {};
      const watched = new Proxy(two, {
        get(target, key) {
          if (key === 'exclusiveBundle') return (bundle: BundleId, fn: () => Promise<unknown>) => (arrived(), target.exclusiveBundle(bundle, fn));
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const [purger, publisher] = [await w.replica(one), await w.replica(watched)];
      const run = tag();
      const site = parseManifest({ contract: 1, capabilities: { static: { dir: 'dist' } } });
      const code = parseManifest({ contract: 1, runtime: 'isolate', capabilities: {} });
      const remove = w.bundles.delete.bind(w.bundles);
      for (let round = 0; round < 100; round++) {
        const bundle: BundleId = await w.bundles.put(Readable.from([Buffer.from(`${run} ${round}`)]));
        const [owner, racer] = [appName(`a-${run}-${round}`), appName(`b-${run}-${round}`)];
        await purger.publish({ name: owner, image: null, manifest: site, bundle, owner: ann });
        await purger.remove(owner);
        let reached!: () => void;
        let proceed!: () => void;
        const atDelete = new Promise<void>((resolve) => (reached = resolve));
        const held = new Promise<void>((resolve) => (proceed = resolve));
        w.bundles.delete = async (id) => {
          reached();
          await held;
          await remove(id);
        };
        const purge = purger.purge(owner);
        await atDelete;
        const isolate = round % 2 === 1;
        const atExclusion = new Promise<void>((resolve) => (arrived = resolve));
        const racing = publisher.publish({ name: racer, image: null, manifest: isolate ? code : site, bundle, owner: ann });
        const settled = racing.catch(() => {});
        // Time for the commit to land if nothing holds it back.
        await Promise.race([atExclusion.then(() => Promise.race([settled, sleep(50)])), settled]);
        proceed();
        await purge;
        const outcome = await racing.then(() => 'committed' as const, (error: unknown) => error);
        if (outcome === 'committed') {
          assert.ok(w.bundles.stored.has(bundle), `round ${round}: a committed release lost its bundle`);
          assert.equal((await w.bundles.index(bundle)).id, bundle);
          if (isolate) assert.deepEqual(publisher.runSpec((await one.app(racer))!.id)?.runtime, { kind: 'isolate', bundle, entry: 'src/server.ts' });
          else assert.equal(publisher.view(racer)?.bundle?.id, bundle);
        } else {
          assert.ok(outcome instanceof Conflict && /upload/.test(outcome.message), `round ${round}: ${String(outcome)}`);
          const id = (await one.app(racer))?.id;
          assert.deepEqual(id ? (await one.releases(id)).filter((r) => r.bundle === bundle) : [], []);
        }
      }
      w.bundles.delete = remove;
    });
  });
}
