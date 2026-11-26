import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
// @ts-expect-error The installer is a plain Node script.
import { install, statePaths, signV4 } from '../scripts/install.mjs';
import { cloudflare, host, writes } from './fake-account.ts';

const cfDir = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const tables = [...readFileSync(join(cfDir, 'schema.sql'), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+) /g)].map(match => match[1]);
const bytes = (text: string) => new TextEncoder().encode(text);
const HOUR = 3600000;

/** An installed deployment in apac whose requests enter at SJC, holding rows in most tables and objects in both buckets. */
async function deployment(fake: Parameters<typeof cloudflare>[0] = {}) {
  const site = await host(true, { location: 'apac' }), cf = cloudflare({ colo: 'SJC', page: 1, ...fake });
  await install(site.options, cf.io);
  const db = cf.sql('space-test'), owner = String(db.prepare('SELECT id FROM users').get()!.id), tenant = String(db.prepare('SELECT id FROM tenants').get()!.id);
  db.exec(`INSERT INTO apps(id,name,tenant_id,owner_id,origin,created_at,create_key) VALUES('a_1','notes','${tenant}','${owner}','a_1',1,'k1');
    INSERT INTO sessions(hash,user_id,csrf,created_at,expires_at) VALUES('s1','${owner}','c',1,9999999999999);
    INSERT INTO uploads(id,app_id,actor_hash,digest,bytes,manifest_json,generation,object_key,created_at,expires_at,ticket_expires_at) VALUES('up_1','a_1','h','d1',12,'{"name":"notes"}',1,'apps/a_1/uploads/up_1.json',1,2,3);
    INSERT INTO daily_usage(tenant_id,day,requests) VALUES('${tenant}','2026-11-26',7);`);
  for (let index = 0; index < 3; index++) db.exec(`INSERT INTO audit(id,at,user_id,tenant_id,app_id,action,result,detail) VALUES('au_${index}',${cf.io.now()},'${owner}','${tenant}','a_1','app.publish','ok','{"note":"it''s ${index}"}')`);
  cf.put('space-test-artifacts', 'apps/a_1/artifacts/d1/package.json', bytes('{"files":[]}'), 'application/json');
  cf.put('space-test-artifacts', 'apps/a_1/artifacts/d1/static/a b&c.css', bytes('body{}'), 'text/css');
  cf.put('space-test-objects', 'apps/a_1/objects/up_2', bytes('photo'), 'image/png');
  cf.calls.length = 0;
  cf.logs.length = 0;
  return { ...site, cf, options: { ...site.options, location: undefined, relocate: 'wnam', yes: true } };
}

const rows = (db: DatabaseSync, table: string) => db.prepare('SELECT * FROM ' + table).all().map(row => JSON.stringify(row)).sort();
const objects = (cf: ReturnType<typeof cloudflare>, bucket: string) => [...cf.r2.get(bucket)!.objects].map(([key, object]) => [key, object.type, Buffer.from(object.body).toString()]).sort();
const config = async (stateDir: string) => JSON.parse(await readFile(statePaths(stateDir).config, 'utf8'));

test('CF-31 relocate without --yes states the plan and what it cannot make safe, and changes nothing', async () => {
  const { options, cf, done } = await deployment();
  try {
    await assert.rejects(install({ ...options, yes: false }, cf.io), /Nothing was changed\. Rerun with --yes to start\./);
    assert.deepEqual(writes(cf.calls), []);
    assert.ok(cf.logs.includes('Not made safe automatically:'), cf.logs.join('\n'));
    assert.ok(cf.logs.some(line => line.includes('Publish nothing')) && cf.logs.some(line => line.includes('stays in its Durable Object')));
  } finally { await done(); }
});

test('CF-31 relocate copies every row and object into resources created at the new location and rebinds the Worker to them', async () => {
  const { options, stateDir, cf, done } = await deployment();
  try {
    await install(options, cf.io);
    for (const table of tables) assert.deepEqual(rows(cf.sql('space-test-wnam'), table), rows(cf.sql('space-test'), table), table);
    for (const kind of ['artifacts', 'objects']) assert.deepEqual(objects(cf, 'space-test-wnam-' + kind), objects(cf, 'space-test-' + kind), kind);
    assert.deepEqual([cf.d1.get('space-test-wnam')!.location, cf.r2.get('space-test-wnam-artifacts')!.location, cf.r2.get('space-test-wnam-objects')!.location], ['wnam', 'wnam', 'wnam']);
    const generated = await config(stateDir);
    assert.deepEqual([generated.d1_databases[0].database_id, ...generated.r2_buckets.map((bucket: { bucket_name: string }) => bucket.bucket_name), generated.vars.PNEUMA_SPACE_ARTIFACT_BUCKET, generated.vars.PNEUMA_SPACE_OBJECT_BUCKET], ['database-space-test-wnam', 'space-test-wnam-artifacts', 'space-test-wnam-objects', 'space-test-wnam-artifacts', 'space-test-wnam-objects']);
    assert.ok(cf.bindings().some(binding => binding.database_id === 'database-space-test-wnam'));
    assert.ok(cf.d1.has('space-test') && cf.r2.get('space-test-artifacts')!.objects.size === 2 && cf.r2.get('space-test-objects')!.objects.size === 1);
  } finally { await done(); }
});

test('CF-31 the audit table arrives whole and still refuses updates and deletes', async () => {
  const { options, cf, done } = await deployment();
  try {
    await install(options, cf.io);
    const db = cf.sql('space-test-wnam');
    assert.deepEqual(rows(db, 'audit'), rows(cf.sql('space-test'), 'audit'));
    assert.throws(() => db.exec('DELETE FROM audit'), /append-only/);
    assert.throws(() => db.exec("UPDATE audit SET result='x'"), /append-only/);
  } finally { await done(); }
});

test('CF-31 a difference found in verification stops the move before the Worker is rebound', async () => {
  const { options, stateDir, cf, done } = await deployment({ corrupt: 'apps/a_1/artifacts/d1/static/a b&c.css' });
  try {
    await assert.rejects(install(options, cf.io), /R2 bucket space-test-wnam-artifacts differs from space-test-artifacts at apps\/a_1\/artifacts\/d1\/static\/a b&c\.css\. The Worker still uses the old data/);
    assert.ok(!cf.calls.includes('wrangler deploy'));
    assert.equal((await config(stateDir)).d1_databases[0].database_name, 'space-test');
  } finally { await done(); }
});

// A sessions table whose trigger loses one copied row.
const lossy = `CREATE TABLE sessions (
  hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TRIGGER lose AFTER INSERT ON sessions WHEN NEW.hash='s1' BEGIN DELETE FROM sessions WHERE hash='s1'; END;`;

test('CF-31 a table that differs after the copy stops the move before the Worker is rebound', async () => {
  const { options, stateDir, cf, done } = await deployment({ seed: { 'space-test-wnam': lossy } });
  try {
    await assert.rejects(install(options, cf.io), /D1 database space-test-wnam does not match space-test in sessions\. The Worker still uses the old data/);
    assert.ok(!cf.calls.includes('wrangler deploy'));
    assert.equal((await config(stateDir)).d1_databases[0].database_name, 'space-test');
  } finally { await done(); }
});

test('CF-31 the move stops before copying when Cloudflare puts a new resource elsewhere than the hint', async () => {
  const { options, stateDir, cf, done } = await deployment({ placed: { 'space-test-wnam-objects': 'enam' } });
  try {
    await assert.rejects(install(options, cf.io), /put space-test-wnam-objects in enam, not wnam; location hints are best effort\. Nothing was copied/);
    assert.equal(cf.r2.get('space-test-wnam-artifacts')!.objects.size, 0);
    assert.equal((await config(stateDir)).d1_databases[0].database_name, 'space-test');
  } finally { await done(); }
});

test('CF-31 a copy interrupted part way resumes on rerun without duplicating or losing rows', async () => {
  let interrupted = false;
  const { options, cf, done } = await deployment({
    failFile: (sql, db) => {
      if (interrupted || !sql.includes('INSERT OR IGNORE INTO audit')) return false;
      interrupted = true;
      const lines = sql.split('\n');
      for (const line of lines.slice(0, lines.length - 1)) db.exec(line);
      return true;
    },
  });
  try {
    await assert.rejects(install(options, cf.io), /Copying rows into D1 database space-test-wnam failed/);
    await install(options, cf.io);
    for (const table of tables) assert.deepEqual(rows(cf.sql('space-test-wnam'), table), rows(cf.sql('space-test'), table), table);
  } finally { await done(); }
});

test('CF-31 a move interrupted after the copy finishes the switch on a plain rerun without copying again', async () => {
  let copies = 0;
  const { options, stateDir, cf, done } = await deployment({ deploys: [0, 1, 1, 1], failFile: sql => { if (sql.startsWith('PRAGMA defer_foreign_keys')) copies++; return false; } });
  try {
    await assert.rejects(install(options, cf.io), /Deployment failed 3 times/);
    await install({ ...options, relocate: undefined, yes: false }, cf.io);
    assert.equal(copies, 1);
    assert.ok(cf.bindings().some(binding => binding.database_id === 'database-space-test-wnam'));
    assert.ok(JSON.parse(await readFile(statePaths(stateDir).data, 'utf8')).previous.switchedAt);
  } finally { await done(); }
});

test('CF-31 audit rows and objects that reach the old data after the copy are appended after the switch', async () => {
  let late = false;
  const site = await deployment({ onDeploy: () => {
    if (!late) return;
    site.cf.sql('space-test').exec(`INSERT INTO audit(id,at,user_id,action,result,detail) VALUES('au_late',${site.cf.io.now()},'u','token.create','ok','{}')`);
    site.cf.put('space-test-objects', 'apps/a_1/objects/up_late', bytes('late'), 'text/plain');
  } });
  const { options, cf, done } = site;
  try {
    late = true;
    await install(options, cf.io);
    assert.equal(cf.sql('space-test-wnam').prepare("SELECT count(*) AS n FROM audit WHERE id='au_late'").get()!.n, 1);
    assert.deepEqual(objects(cf, 'space-test-wnam-objects'), objects(cf, 'space-test-objects'));
  } finally { await done(); }
});

test('CF-31 --remove-previous removes nothing within an hour of the switch', async () => {
  const { options, cf, done } = await deployment();
  try {
    await install(options, cf.io);
    cf.advance(HOUR - 60000);
    await assert.rejects(install({ ...options, relocate: undefined, yes: false, removePrevious: true }, cf.io), /URLs signed before the switch stay valid until .*Nothing was removed/);
    assert.ok(cf.d1.has('space-test') && cf.r2.has('space-test-artifacts') && cf.r2.has('space-test-objects'));
  } finally { await done(); }
});

test('CF-31 --remove-previous removes nothing while the deployed Worker binds the previous data', async () => {
  const { options, cf, done } = await deployment();
  try {
    await install(options, cf.io);
    cf.bindings().push({ type: 'r2_bucket', name: 'OLD', bucket_name: 'space-test-objects' });
    cf.advance(2 * HOUR);
    await assert.rejects(install({ ...options, relocate: undefined, yes: false, removePrevious: true }, cf.io), /does not bind the data in wnam alone.*Nothing was removed/);
    assert.ok(cf.d1.has('space-test') && cf.r2.get('space-test-objects')!.objects.size === 1);
  } finally { await done(); }
});

test('CF-31 --remove-previous empties and deletes the previous buckets and database and keeps the new ones', async () => {
  const { options, stateDir, cf, done } = await deployment();
  try {
    await install(options, cf.io);
    cf.advance(2 * HOUR);
    await install({ ...options, relocate: undefined, yes: false, removePrevious: true }, cf.io);
    assert.deepEqual([[...cf.d1.keys()], [...cf.r2.keys()]], [['space-test-wnam'], ['space-test-wnam-artifacts', 'space-test-wnam-objects']]);
    assert.equal(JSON.parse(await readFile(statePaths(stateDir).data, 'utf8')).previous, undefined);
    await assert.rejects(install({ ...options, relocate: undefined, yes: false, removePrevious: true }, cf.io), /No previous data/);
  } finally { await done(); }
});

test('CF-31 an interrupted --remove-previous finishes on rerun', async () => {
  const { options, cf, done } = await deployment({ refuseOnce: ['DELETE /accounts/account-example/d1/database/database-space-test'] });
  try {
    await install(options, cf.io);
    cf.advance(2 * HOUR);
    const remove = { ...options, relocate: undefined, yes: false, removePrevious: true };
    await assert.rejects(install(remove, cf.io), /D1 removal failed/);
    await install(remove, cf.io);
    assert.deepEqual([[...cf.d1.keys()], [...cf.r2.keys()]], [['space-test-wnam'], ['space-test-wnam-artifacts', 'space-test-wnam-objects']]);
  } finally { await done(); }
});

test('CF-31 R2 requests are signed as AWS Signature Version 4 specifies', () => {
  const hash = createHash('sha256').update('').digest('hex');
  assert.equal(signV4({ keyId: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', method: 'GET', host: 'example.amazonaws.com', path: '/', headers: { 'X-Amz-Date': '20150830T123600Z' }, payloadHash: hash, timestamp: '20150830T123600Z' }),
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});
