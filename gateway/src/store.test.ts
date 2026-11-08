import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { DEFAULT_TENANT, IDEMPOTENCY_WINDOW_MS, type App, type AppId, type AppName, type Delivery, type DeliveryId, type Subject, type TriggerName } from './model.ts';
import { SqliteStore } from './store.ts';

const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'pneuma-space-store-')), 'pneuma-space.sqlite3'));

function delivery(id: string, fields: Partial<Delivery>): Delivery {
  return {
    id: id as DeliveryId, app: 'a1' as AppId, trigger: 'reindex' as TriggerName, scheduledFor: null, caller: null,
    idempotencyKey: null, body: new Uint8Array(), state: 'due', attempts: 0, nextAttemptAt: 0, createdAt: 0, ...fields,
  };
}

function app(name: string): App {
  return {
    name: name as AppName, id: `id-${name}` as AppId, tenant: DEFAULT_TENANT, access: 'org', owner: 'user:ann' as Subject, status: 'registered', current: null, policyOverride: {}, registeredAt: 0,
  };
}

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

test('two concurrent transactions serialize: the second sees the first one commit', async () => {
  const first = store.transaction(async (tx) => {
    const seen = await tx.app(app('one').name);
    await sleep(20);
    await tx.putApp(app('one'));
    return seen;
  });
  const second = store.transaction(async (tx) => tx.app(app('one').name));
  assert.deepEqual(await Promise.all([first, second]), [null, app('one')]);
});

test('a call issued while a transaction is open runs after it commits', async () => {
  const order: string[] = [];
  const open = store.transaction(async (tx) => {
    order.push('begin');
    await sleep(20);
    await tx.putApp(app('two'));
    order.push('commit');
  });
  const read = store.app(app('two').name).then((row) => order.push(`read ${row?.name}`));
  await Promise.all([open, read]);
  assert.deepEqual(order, ['begin', 'commit', 'read two']);
});
