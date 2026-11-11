import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { changeKey, type AppName, type ImageId, type Leadership, type ReleaseNumber, type Subject } from './model.ts';
import { Session, type PgOptions } from './pg.ts';
import { replicaContract } from './registry.contract.ts';
import { app, storeContract } from './store.contract.ts';
import { PG_MIGRATIONS, PgStore, type PgStoreOptions } from './store-pg.ts';

const container = 'pneuma-space-pgstore-test';
const password = 'pgstore-secret';
const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
const removeContainer = () => spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-pgstore-'));
let port = 0;
const url = (database = 'postgres', query = 'sslmode=disable') => `postgres://postgres:${password}@127.0.0.1:${port}/${database}?${query}`;
const plain = (database = 'postgres'): PgOptions => ({ host: '127.0.0.1', port, user: 'postgres', password, database, tls: false });

const stores: PgStore[] = [];
async function open(options: PgStoreOptions = {}, database = 'postgres'): Promise<PgStore> {
  const store = await PgStore.open(url(database), options);
  stores.push(store);
  return store;
}

async function until(what: string, condition: () => boolean, ms: number): Promise<void> {
  for (const end = Date.now() + ms; !condition(); await delay(10)) if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

function selfSigned(name: string): string {
  execFileSync('openssl', ['req', '-new', '-x509', '-days', '2', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`)], { stdio: 'ignore' });
  return join(dir, `${name}.crt`);
}

const skip = !dockerUp && 'Docker is not available';

before(async () => {
  if (skip) return;
  selfSigned('server');
  selfSigned('other');
  removeContainer();
  docker('run', '-d', '--name', container, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256', '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
    '-v', `${dir}:/certs:ro`, '--entrypoint', 'bash', 'postgres:16', '-c',
    // PostgreSQL refuses a key file it does not own with mode 0600.
    'cp /certs/server.* /tmp/ && chown postgres /tmp/server.* && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key');
  port = Number(docker('port', container, '5432/tcp').trim().split(':').pop());
  for (const deadline = Date.now() + 60_000; ;) {
    if (await Session.open(plain()).then((s) => s.close().then(() => true), () => false)) break;
    if (Date.now() > deadline) throw new Error(`${container} did not accept connections within 60 s`);
    await delay(250);
  }
}, { timeout: 120_000 });

after(async () => {
  await Promise.all(stores.map((s) => s.close().catch(() => undefined)));
  removeContainer();
  rmSync(dir, { recursive: true, force: true });
});

if (!skip) storeContract('PostgreSQL', (options) => open(options));
if (!skip) replicaContract('PostgreSQL', async () => [await open(), await open()]);

describe('PgStore against a real PostgreSQL 16', { skip, timeout: 120_000 }, () => {
  test('two stores on one database see each other\'s app change within 1 s', async () => {
    const [a, b] = [await open(), await open()];
    const seen: string[] = [];
    b.onChange((change) => seen.push(changeKey(change)));
    await a.putApp(app('shared'));
    await until('app/shared on the other store', () => seen.includes('app/shared'), 1000);
  });

  test('two stores creating one new app at once both succeed with releases 1 and 2 (AC-STORE-2)', async () => {
    const [a, b] = [await open(), await open()];
    const name = 'raced' as AppName;
    const id = app(name).id;
    const publish = (store: PgStore, image: ImageId) => store.transaction(async (tx) => {
      if (!(await tx.app(name))) await tx.putApp(app(name));
      const number = ((await tx.releases(id)).length + 1) as ReleaseNumber;
      await delay(20);
      await tx.putRelease({ app: id, number, image, manifest: { contract: 1, capabilities: {} }, bundle: null, runtime: 'container', releaseKey: image, publishedAt: 0 });
    });
    await Promise.all([publish(a, 'sha256:a' as ImageId), publish(b, 'sha256:b' as ImageId)]);
    assert.deepEqual((await a.releases(id)).map((r) => r.number), [1, 2]);
    assert.ok(a.retries + b.retries >= 1);
  });

  test('in test-retry mode a transaction runs fn twice and announces its change once', async () => {
    const store = await open({ testRetry: true });
    const seen: string[] = [];
    store.onChange((change) => seen.push(changeKey(change)));
    let runs = 0;
    await store.transaction(async (tx) => {
      runs++;
      await tx.putApp(app('rerun'));
    });
    await delay(300);
    assert.deepEqual([runs, seen.filter((key) => key === 'app/rerun').length], [2, 1]);
  });

  test('exclusive on one name from two stores runs one command at a time', async () => {
    const [a, b] = [await open(), await open()];
    const order: string[] = [];
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const first = a.exclusive('locked' as AppName, async () => {
      order.push('a start');
      entered();
      await delay(300);
      order.push('a end');
    });
    await inside;
    await b.exclusive('locked' as AppName, async () => void order.push('b'));
    await first;
    assert.deepEqual(order, ['a start', 'a end', 'b']);
  });

  test('terminating the leader\'s session fires onLost within 5 s and the other store then leads', async () => {
    const [a, b] = [await open(), await open()];
    const tenure = await a.leader();
    assert.ok(tenure);
    assert.equal(await b.leader(), null);
    let lost = false;
    tenure.onLost(() => (lost = true));
    const admin = await Session.open(plain());
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND classid = 2 AND objid = 0 AND granted");
    await admin.close();
    await until('onLost', () => lost, 5000);
    let next: Leadership | null = null;
    for (const end = Date.now() + 5000; !next && Date.now() < end; await delay(100)) next = await b.leader();
    assert.equal(next?.held(), true);
    await next?.release();
  });

  test('two stores opening an empty database at once apply the schema once (AC-STORE-6)', async () => {
    const admin = await Session.open(plain());
    await admin.simple('CREATE DATABASE migrated');
    await admin.close();
    await Promise.all([open({}, 'migrated'), open({}, 'migrated')]);
    const s = await Session.open(plain('migrated'));
    const { rows } = await s.query('SELECT version FROM schema_migration ORDER BY version');
    await s.close();
    assert.deepEqual(rows.map((r) => r.version), PG_MIGRATIONS.map((_, i) => i + 1));
  });

  test('every table but lease_tally announces its change key', async () => {
    const store = await open();
    const seen: string[] = [];
    store.onChange((change) => seen.push(changeKey(change)));
    await store.putApp(app('noisy'));
    const id = app('noisy').id;
    const s = await Session.open(plain());
    const writes: [string, string][] = [
      [`INSERT INTO release (app, number, manifest, release_key, published_at) VALUES ('${id}', 9, '{}', 'k', 0)`, 'app/noisy'],
      [`INSERT INTO trigger (app, name) VALUES ('${id}', 't')`, 'app/noisy'],
      [`INSERT INTO binding (app, kind, provider, state, resource) VALUES ('${id}', 'kv', 'redis', 'active', '{}')`, 'app/noisy'],
      [`UPDATE app SET owner = 'user:zed' WHERE id = '${id}'`, 'app/noisy'],
      [`INSERT INTO policy (id, value) VALUES (1, '{}') ON CONFLICT (id) DO UPDATE SET value = '{}'`, 'policy'],
      [`INSERT INTO instance (app, runtime, release, spec_hash, epoch, state, since, cpu_millis, memory_mb) VALUES ('${id}', 'container', 1, 'h', 0, 'asleep', 0, 0, 0)`, `instance/${id}`],
      [`INSERT INTO guard (app, release, failures) VALUES ('${id}-g', 1, '[]')`, `instance/${id}-g`],
      [`INSERT INTO tenant (name, display, quota, created_at) VALUES ('loud', 'Loud', '{}', 0)`, 'tenant/loud'],
      [`INSERT INTO membership (tenant, user_id, role) VALUES ('loud-m', 'u', 'member')`, 'tenant/loud-m'],
      [`INSERT INTO token (id, tenant, subject, hash, created_at) VALUES ('tk', 'loud-t', 'service:x', 'h-tk', 0)`, 'tenant/loud-t'],
    ];
    for (const [sql, key] of writes) {
      seen.length = 0;
      await s.simple(sql);
      await until(`${key} after ${sql.slice(0, 30)}`, () => seen.includes(key), 1000);
    }
    seen.length = 0;
    await s.simple(`INSERT INTO lease_tally (app, replica, epoch, request, channel, trigger) VALUES ('${id}', 'r', 0, 1, 0, 0)`);
    await delay(200);
    await s.close();
    assert.deepEqual(seen, []);
  });

  test('the audit table refuses update and delete', async () => {
    const store = await open();
    await store.insertAudit({ at: 1, actor: 'user:ann' as Subject, actorTenant: null, tenant: null, action: 'policy.global', targetKind: 'policy', target: 'global', result: 'ok', details: {} });
    const s = await Session.open(plain());
    await assert.rejects(s.simple("UPDATE audit SET result = 'error'"), /append-only/);
    await assert.rejects(s.simple('DELETE FROM audit'), /append-only/);
    await s.close();
  });

  test('verify-full connects with the right CA and fails to open with a wrong one (AC-STORE-7)', async () => {
    const right = await PgStore.open(url('postgres', `sslmode=verify-full&sslrootcert=${join(dir, 'server.crt')}`));
    stores.push(right);
    await assert.rejects(PgStore.open(url('postgres', `sslmode=verify-full&sslrootcert=${join(dir, 'other.crt')}`)), /certificate/);
  });
});

test('package.json declares no dependencies (AC-STORE-8)', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual([manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies], [undefined, undefined, undefined]);
});
