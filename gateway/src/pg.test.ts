import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PgError, Pool, Session, type Notification, type PgOptions } from './pg.ts';

const container = 'pneuma-space-pgtest';
const password = 'pgtest-secret';
const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
const removeContainer = () => spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });

function selfSigned(dir: string, name: string): string {
  execFileSync('openssl', ['req', '-new', '-x509', '-days', '2', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`)], { stdio: 'ignore' });
  return join(dir, `${name}.crt`);
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<PgError> {
  const error = await promise.then(() => assert.fail(`expected PgError ${code}`), (e: unknown) => e);
  assert.ok(error instanceof PgError, `expected PgError ${code}, got ${String(error)}`);
  assert.equal(error.code, code);
  return error;
}

describe('pg against a real PostgreSQL 16', { skip: !dockerUp && 'Docker is not available', timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-pgtest-'));
  let plain: PgOptions;
  let ca: string;
  let otherCa: string;
  const opened: Session[] = [];
  const open = async (options: Partial<PgOptions> = {}) => {
    const s = await Session.open({ ...plain, ...options });
    opened.push(s);
    return s;
  };

  before(async () => {
    ca = selfSigned(dir, 'server');
    otherCa = selfSigned(dir, 'other');
    removeContainer();
    docker('run', '-d', '--name', container, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256', '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      '-v', `${dir}:/certs:ro`, '--entrypoint', 'bash', 'postgres:16', '-c',
      // PostgreSQL refuses a key file it does not own with mode 0600.
      'cp /certs/server.* /tmp/ && chown postgres /tmp/server.* && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key');
    const port = Number(docker('port', container, '5432/tcp').trim().split(':').pop());
    plain = { host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', tls: false };
    for (const deadline = Date.now() + 60_000; ;) {
      const ready = await Session.open(plain).then((s) => s.close().then(() => true), () => false);
      if (ready) break;
      if (Date.now() > deadline) throw new Error(`${container} did not accept connections within 60 s`);
      await delay(250);
    }
  });

  after(async () => {
    await Promise.all(opened.map((s) => s.close()));
    removeContainer();
    rmSync(dir, { recursive: true, force: true });
  });

  test('SCRAM-SHA-256 authenticates', async () => {
    const s = await open();
    const { rows } = await s.query('SELECT current_user AS u');
    assert.equal(rows[0].u, 'postgres');
  });

  test('a wrong password is 28P01', async () => {
    await rejectsWithCode(Session.open({ ...plain, password: 'wrong' }), '28P01');
  });

  test('verify-full with the right CA runs over TLS', async () => {
    const s = await open({ tls: { caFile: ca } });
    const { rows } = await s.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    assert.equal(rows[0].ssl, true);
  });

  test('verify-full with a wrong CA is refused', async () => {
    const error = await Session.open({ ...plain, tls: { caFile: otherCa } }).then((s) => s.close(), (e: unknown) => e);
    assert.ok(error instanceof Error && !(error instanceof PgError), `expected a TLS error, got ${String(error)}`);
  });

  test('parameters and results round-trip unicode, NULL, int8 above 2^31 and bytea', async () => {
    const s = await open();
    const bytes = Buffer.from([0, 1, 254, 255]);
    const { rows } = await s.query('SELECT $1::text AS t, $2::text AS n, $3::int8 AS big, $4::bytea AS b', ['你好, ✓ é', null, 2 ** 40 + 1, bytes]);
    assert.deepEqual(rows, [{ t: '你好, ✓ é', n: null, big: 2 ** 40 + 1, b: bytes }]);
  });

  test('a constraint violation is a PgError with code and constraint', async () => {
    const s = await open();
    await s.simple('CREATE TABLE uniq (k text CONSTRAINT uniq_k UNIQUE)');
    await s.query('INSERT INTO uniq VALUES ($1)', ['a']);
    const error = await rejectsWithCode(s.query('INSERT INTO uniq VALUES ($1)', ['a']), '23505');
    assert.equal(error.constraint, 'uniq_k');
  });

  test('a transaction whose function throws leaves no row', async () => {
    const pool = new Pool(plain, 1);
    await pool.simple('CREATE TABLE rolled (k text)');
    await assert.rejects(pool.transaction(async (s) => {
      await s.query('INSERT INTO rolled VALUES ($1)', ['x']);
      throw new Error('abort');
    }), /abort/);
    assert.deepEqual((await pool.query('SELECT * FROM rolled')).rows, []);
    await pool.close();
  });

  test('a session-level advisory lock is released when its session closes', async () => {
    const holder = await open();
    const other = await open({ statementTimeoutMs: 10_000 });
    await holder.query('SELECT pg_advisory_lock(1, 42)');
    assert.equal((await other.query('SELECT pg_try_advisory_lock(1, 42) AS got')).rows[0].got, false);
    await holder.close();
    await other.query('SELECT pg_advisory_lock(1, 42)');
  });

  test('LISTEN receives a NOTIFY payload sent from another session', async () => {
    const listener = await open();
    const sender = await open();
    const received = new Promise<Notification>((resolve) => listener.onNotification(resolve));
    await listener.simple('LISTEN pgtest');
    await sender.query("SELECT pg_notify('pgtest', $1)", ['hello ✓']);
    const { channel, payload } = await received;
    assert.deepEqual({ channel, payload }, { channel: 'pgtest', payload: 'hello ✓' });
  });

  test('two serializable transactions updating one row end with one 40001', async () => {
    const pool = new Pool(plain, 2);
    await pool.simple('CREATE TABLE counter (id int PRIMARY KEY, v int); INSERT INTO counter VALUES (1, 0)');
    let arrive!: () => void;
    let reads = 0;
    const bothRead = new Promise<void>((resolve) => (arrive = resolve));
    const bump = () => pool.transaction(async (s) => {
      const { rows } = await s.query('SELECT v FROM counter WHERE id = 1');
      if (++reads === 2) arrive();
      await bothRead;
      await s.query('UPDATE counter SET v = $1 WHERE id = 1', [Number(rows[0].v) + 1]);
    }, 'serializable');
    const outcomes = await Promise.allSettled([bump(), bump()]);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    const failed = outcomes.find((o) => o.status === 'rejected');
    assert.equal((failed?.reason as PgError).code, '40001');
    await pool.close();
  });

  test('the pool serves concurrent queries on at most size sessions', async () => {
    const pool = new Pool(plain, 3);
    const results = await Promise.all(Array.from({ length: 30 }, () => pool.query('SELECT pg_backend_pid() AS pid')));
    assert.equal(new Set(results.map((r) => r.rows[0].pid)).size, 3);
    await pool.close();
  });

  test('a session terminated server-side is replaced and the next query succeeds', async () => {
    const pool = new Pool(plain, 1);
    const victim = await pool.with(async (s) => s);
    const admin = await open();
    await admin.query('SELECT pg_terminate_backend($1, 10000)', [victim.pid]);
    await victim.closed;
    const { rows } = await pool.query('SELECT pg_backend_pid() AS pid');
    assert.notEqual(rows[0].pid, victim.pid);
    await pool.close();
  });

  test('cancel() ends a running pg_sleep with 57014', async () => {
    const s = await open();
    const watcher = await open();
    const sleeping = s.query('SELECT pg_sleep(30)');
    const running = () => watcher.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active'", [s.pid]);
    while ((await running()).rows.length === 0) await delay(20);
    await s.cancel();
    await rejectsWithCode(sleeping, '57014');
  });

  test('0A000 after ALTER TABLE is retried with a fresh statement', async () => {
    const s = await open();
    await s.simple('CREATE TABLE widened (a int); INSERT INTO widened VALUES (1)');
    await s.query('SELECT * FROM widened');
    await s.simple('ALTER TABLE widened ADD COLUMN b int DEFAULT 2');
    assert.deepEqual((await s.query('SELECT * FROM widened')).rows, [{ a: 1, b: 2 }]);
  });

  test('a server that accepts and never answers rejects open within the connect timeout', async () => {
    const silent = createServer(() => {}).listen(0, '127.0.0.1');
    await once(silent, 'listening');
    try {
      const port = (silent.address() as AddressInfo).port;
      await assert.rejects(Session.open({ ...plain, port, connectTimeoutMs: 200 }), /did not finish the handshake within 200 ms/);
    } finally {
      silent.close();
    }
  });

  test('statement_timeout from the options ends a long query with 57014', async () => {
    const s = await open({ statementTimeoutMs: 200 });
    await rejectsWithCode(s.query('SELECT pg_sleep(30)'), '57014');
  });
});
