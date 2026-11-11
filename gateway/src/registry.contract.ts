// What two gateway replicas may assume of each other's commands over one platform library, run against every Store (ADR 0028).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { QuotaExceeded, appName, parseManifest, subject, tenantName, type Store } from './model.ts';
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
  });
}
