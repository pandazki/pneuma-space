import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IDEMPOTENCY_WINDOW_MS, type AppId, type Delivery, type DeliveryId, type TriggerName } from './model.ts';
import { SqliteStore } from './store.ts';

const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'pneuma-space-store-')), 'pneuma-space.sqlite3'));

function delivery(id: string, fields: Partial<Delivery>): Delivery {
  return {
    id: id as DeliveryId, app: 'a1' as AppId, trigger: 'reindex' as TriggerName, scheduledFor: null, caller: null,
    idempotencyKey: null, body: new Uint8Array(), state: 'due', attempts: 0, nextAttemptAt: 0, createdAt: 0, ...fields,
  };
}

test('a scheduled slot is stored once', () => {
  const first = store.insertDelivery(delivery('s1', { scheduledFor: 60_000 }));
  assert.equal(store.insertDelivery(delivery('s2', { scheduledFor: 60_000 })).id, first.id);
});

test('the same idempotency key returns the same delivery within 24 h and a new one after', () => {
  const t0 = 1_000_000_000;
  store.insertDelivery(delivery('k1', { idempotencyKey: 'job-7', createdAt: t0 }));
  assert.equal(store.insertDelivery(delivery('k2', { idempotencyKey: 'job-7', createdAt: t0 + IDEMPOTENCY_WINDOW_MS - 1 })).id, 'k1');
  assert.equal(store.insertDelivery(delivery('k3', { idempotencyKey: 'job-7', createdAt: t0 + IDEMPOTENCY_WINDOW_MS + 1 })).id, 'k3');
});
