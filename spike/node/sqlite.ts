import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pneuma-s3-'));
const db = new DatabaseSync(join(dir, 'pneuma.sqlite3'));
try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  const sync = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
  assert.equal(mode.journal_mode, 'wal');
  assert.equal(sync.synchronous, 2);
  console.log(`journal_mode ${mode.journal_mode}, synchronous ${sync.synchronous} (FULL)`);

  db.exec(`
    CREATE TABLE release (id INTEGER PRIMARY KEY, app TEXT NOT NULL, image TEXT NOT NULL);
    CREATE TABLE trigger (app TEXT NOT NULL, name TEXT NOT NULL, cron TEXT, release INTEGER NOT NULL REFERENCES release(id), PRIMARY KEY (app, name));
    CREATE TABLE binding (app TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (app, kind));
  `);

  function tx<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const insRelease = db.prepare('INSERT INTO release (app, image) VALUES (?, ?)');
  const insTrigger = db.prepare('INSERT INTO trigger (app, name, cron, release) VALUES (?, ?, ?, ?)');
  const insBinding = db.prepare('INSERT INTO binding (app, kind, state) VALUES (?, ?, ?)');
  const count = () => ['release', 'trigger', 'binding'].map((t) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);

  assert.throws(() => tx(() => {
    const { lastInsertRowid } = insRelease.run('survey', 'sha256:abc');
    insTrigger.run('survey', 'daily', '0 9 * * *', lastInsertRowid);
    insBinding.run('survey', 'sql', 'ready');
    throw new Error('publish failed after three inserts');
  }), /publish failed/);
  assert.deepEqual(count(), [0, 0, 0]);
  assert.equal(db.isTransaction, false);
  console.log('rollback: error thrown after inserts into release, trigger, binding left all three tables empty');

  const t0 = performance.now();
  tx(() => {
    for (let i = 0; i < 500; i++) {
      const app = `app-${i}`;
      const { lastInsertRowid } = insRelease.run(app, `sha256:${i}`);
      insTrigger.run(app, 'daily', '0 9 * * *', lastInsertRowid);
      insBinding.run(app, 'sql', 'ready');
    }
  });
  const one = performance.now() - t0;
  assert.deepEqual(count(), [500, 500, 500]);
  console.log(`500 iterations x 3 inserts in one transaction: ${one.toFixed(1)} ms`);

  const t1 = performance.now();
  for (let i = 0; i < 500; i++) tx(() => insBinding.run(`solo-${i}`, 'kv', 'ready'));
  const each = performance.now() - t1;
  console.log(`500 single-insert transactions (one fsync each): ${each.toFixed(1)} ms, ${(each / 500).toFixed(2)} ms per commit`);

  const t2 = performance.now();
  const listed = db.prepare('SELECT r.app, r.image, b.state FROM release r JOIN binding b ON b.app = r.app AND b.kind = ?').all('sql');
  console.log(`list 500 apps joined with bindings in one query: ${listed.length} rows, ${(performance.now() - t2).toFixed(1)} ms`);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
