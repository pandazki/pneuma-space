import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaRefusals } from './events.ts';
import { QuotaExceeded, type TenantName } from './model.ts';

test('quota-refused is emitted at most once a minute per tenant and resource', () => {
  const emitted: unknown[] = [];
  const clock = { now: 0 };
  const refused = quotaRefusals((ev, app, extra) => emitted.push([ev, app, extra]), () => clock.now);
  const apps = new QuotaExceeded('blue' as TenantName, { resource: 'apps', used: 1, limit: 1, ask: 1 });
  const awake = new QuotaExceeded('blue' as TenantName, { resource: 'awake', used: 1, limit: 1, ask: 1 });
  refused(apps, 'two', 'publish');
  clock.now = 59_999;
  refused(apps, 'three', 'publish');
  refused(awake, 'one', 'wake');
  clock.now = 60_000;
  refused(apps, 'four', 'publish');
  assert.deepEqual(emitted, [
    ['quota-refused', 'two', { tenant: 'blue', resource: 'apps', used: 1, limit: 1, action: 'publish' }],
    ['quota-refused', 'one', { tenant: 'blue', resource: 'awake', used: 1, limit: 1, action: 'wake' }],
    ['quota-refused', 'four', { tenant: 'blue', resource: 'apps', used: 1, limit: 1, action: 'publish' }],
  ]);
});
