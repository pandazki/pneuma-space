import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderName, Resource } from './model.ts';
import { createProviders, providerConfig } from './providers.ts';

const providers = createProviders({ destroyStorage: async () => {} }, providerConfig({}), async () => true);

// Each resource is what the provider's ensure stores, credentials included (AC-OPS-9).
const cases: readonly [ProviderName, Resource, Record<string, string>][] = [
  ['volume', { id: 'pneuma-space-files-a1', target: '/data' }, { volume: 'pneuma-space-files-a1' }],
  ['sqlite', { id: 'pneuma-space-db-a1', target: '/pneuma/db' }, { volume: 'pneuma-space-db-a1' }],
  ['postgres', { role: 'app_a1', database: 'app_a1', password: 'pg-secret' }, { service: 'postgres:5432', database: 'app_a1' }],
  ['redis', { user: 'app_a1', password: 'kv-secret', prefix: 'a1:' }, { service: 'redis:6379', prefix: 'a1:' }],
  ['s3', { bucket: 'app-a1', accessKey: 'app-a1-key', secretKey: 's3-secret' }, { endpoint: 'http://rustfs:9000', bucket: 'app-a1' }],
];

for (const [name, resource, location] of cases) {
  test(`${name} location names where the data lives and no credential`, () => {
    assert.deepEqual(providers[name].location(resource), location);
  });
}
