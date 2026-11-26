import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error The installer is a plain Node script.
import { install, generateConfig, workerSecrets, statePaths, columnUpgrades, Stop } from '../scripts/install.mjs';
import { account, token, cloudflare, host, writes } from './fake-account.ts';

const cfDir = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('CF-23 without a saved token the installer prints the prefilled token link and changes nothing in the account', async () => {
  const { options, done } = await host(false), cf = cloudflare();
  try {
    await assert.rejects(install(options, cf.io), (error: Error) => {
      const link = /https:\/\/dash\.cloudflare\.com\/\S+/.exec(error.message)![0], url = new URL(link);
      assert.equal(url.searchParams.get('to'), '/:account/api-tokens');
      assert.deepEqual(JSON.parse(url.searchParams.get('permissionGroupKeys')!), [{ key: 'workers_scripts', type: 'edit' }, { key: 'workers_r2', type: 'edit' }]);
      assert.ok(error instanceof Stop && error.message.includes(statePaths(options.stateDir).token));
      return true;
    });
    assert.deepEqual(writes(cf.calls), []);
  } finally { await done(); }
});

test('CF-23 a rerun after a complete install creates no resource and only redeploys', async () => {
  const { options, done } = await host(), cf = cloudflare();
  try {
    await install(options, cf.io);
    cf.calls.length = 0;
    await install(options, cf.io);
    assert.deepEqual(writes(cf.calls).filter(call => !call.startsWith('PUT /accounts/' + account + '/r2/buckets/')), ['wrangler d1 execute', 'wrangler d1 execute', 'wrangler d1 execute', 'wrangler d1 execute', 'wrangler deploy']);
  } finally { await done(); }
});

test('CF-23 generated files live only in the private state directory', async () => {
  const { options, stateDir, done } = await host();
  try {
    await install(options, cloudflare().io);
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    for (const file of await readdir(stateDir)) assert.equal((await stat(join(stateDir, file))).mode & 0o777, 0o600, file);
    assert.deepEqual((await readdir(stateDir)).sort(), ['api-token', 'data.json', 'owner.json', 'worker-secrets.json', 'wrangler.json']);
  } finally { await done(); }
});

test('CF-23 a first install refuses names that already exist in the account', async () => {
  const { options, stateDir, done } = await host(), cf = cloudflare({ buckets: ['space-test-objects'] });
  try {
    await assert.rejects(install(options, cf.io), /Already in this account: R2 bucket space-test-objects/);
    assert.deepEqual(writes(cf.calls), []);
    await assert.rejects(readFile(statePaths(stateDir).config));
  } finally { await done(); }
});

test('CF-23 a failed deploy is retried', async () => {
  const { options, done } = await host(), cf = cloudflare({ deploys: [1, 1, 0] });
  try {
    await install(options, cf.io);
    assert.equal(cf.calls.filter(call => call === 'wrangler deploy').length, 3);
  } finally { await done(); }
});

test('CF-23 the control domain attached to another Worker is not replaced', async () => {
  const { options, done } = await host(), cf = cloudflare({ domains: [{ hostname: 'space.example.com', service: 'other' }] });
  try {
    await assert.rejects(install(options, cf.io), /attached to Worker other; refusing/);
    assert.ok(!cf.calls.includes('PUT /accounts/' + account + '/workers/domains'));
  } finally { await done(); }
});

test('CF-23 an upgrade deletes the API token secret the Worker held before path routing', async () => {
  const { options, done } = await host(), cf = cloudflare({ secrets: ['PNEUMA_SPACE_CF_API_TOKEN', 'PNEUMA_SPACE_R2_ACCESS_KEY_ID'] });
  try {
    await install(options, cf.io);
    assert.deepEqual(cf.calls.filter(call => call.startsWith('DELETE ')), ['DELETE /accounts/' + account + '/workers/scripts/space-test/secrets/PNEUMA_SPACE_CF_API_TOKEN']);
  } finally { await done(); }
});

test('CF-23 the generated config names resources by prefix and reaches the repository by absolute path', async () => {
  const template = JSON.parse(await readFile(join(cfDir, 'wrangler.jsonc'), 'utf8'));
  const config = generateConfig(template, { cfDir, prefix: 'space-test', domain: 'space.example.com', accountId: account, databaseId: 'database-id' });
  assert.equal(config.main, join(cfDir, 'src/worker.ts'));
  assert.equal(config.build.cwd, cfDir);
  assert.equal(config.assets.directory, join(cfDir, 'public'));
  assert.equal(config.containers[0].images.base.dockerfile, join(cfDir, 'runner/Dockerfile'));
  assert.deepEqual([config.name, config.containers[0].name, config.d1_databases[0].database_name, config.d1_databases[0].database_id, ...config.r2_buckets.map((bucket: { bucket_name: string }) => bucket.bucket_name)], ['space-test', 'space-test', 'space-test', 'database-id', 'space-test-artifacts', 'space-test-objects']);
  assert.deepEqual(config.vars, { ...template.vars, PNEUMA_SPACE_CONTROL_ORIGIN: 'https://space.example.com', PNEUMA_SPACE_ACCOUNT_ID: account, PNEUMA_SPACE_ARTIFACT_BUCKET: 'space-test-artifacts', PNEUMA_SPACE_OBJECT_BUCKET: 'space-test-objects' });
});

test('CF-23 worker secrets carry no API token, derive the R2 key from the token and keep operator TURN secrets', () => {
  const secrets = workerSecrets(token, 'token-id', { PNEUMA_SPACE_TURN_KEY_ID: 'turn-key', PNEUMA_SPACE_R2_ACCESS_KEY_ID: 'stale', PNEUMA_SPACE_CF_API_TOKEN: 'old-token' });
  assert.deepEqual(secrets, {
    PNEUMA_SPACE_TURN_KEY_ID: 'turn-key', PNEUMA_SPACE_R2_ACCESS_KEY_ID: 'token-id',
    PNEUMA_SPACE_R2_SECRET_ACCESS_KEY: createHash('sha256').update(token).digest('hex'),
  });
});

const schema = readFileSync(join(cfDir, 'schema.sql'), 'utf8');
// The two tables as databases installed before ADR 0046 hold them.
const before = `CREATE TABLE tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, apps_limit INTEGER NOT NULL DEFAULT 5,
  awake_limit INTEGER NOT NULL DEFAULT 2, requests_limit INTEGER NOT NULL DEFAULT 10000,
  storage_limit INTEGER NOT NULL DEFAULT 52428800, created_at INTEGER NOT NULL
);
CREATE TABLE apps (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_id TEXT NOT NULL REFERENCES users(id), origin TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, create_key TEXT NOT NULL, storage_bytes INTEGER NOT NULL DEFAULT 10485760,
  observed_status TEXT NOT NULL DEFAULT 'draft', observed_runtime TEXT NOT NULL DEFAULT 'asleep',
  observed_release INTEGER, observed_at INTEGER, purged_at INTEGER,
  UNIQUE(tenant_id,create_key)
);`;
const fresh = () => { const db = new DatabaseSync(':memory:'); db.exec(schema); return db; };
const columnsOf = (db: DatabaseSync) => Object.fromEntries([...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) /g)].map(([, table]) => [table, db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => String(row.name))]));

test('CF-23 a rerun adds to an existing database the columns schema.sql gained since it was installed', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(before);
  db.exec("INSERT INTO tenants(id,name,created_at) VALUES('t','T',1)");
  for (const statement of columnUpgrades(schema, columnsOf(db))) db.exec(statement);
  db.exec(schema);
  assert.deepEqual(columnsOf(db), columnsOf(fresh()));
  assert.equal(db.prepare("SELECT ephemeral_limit FROM tenants WHERE id='t'").get()?.ephemeral_limit, 3);
});

test('CF-23 the installer runs the column upgrade for the columns the deployed database lacks', async () => {
  const { options, done } = await host(), db = new DatabaseSync(':memory:');
  db.exec(before);
  const cf = cloudflare({ seed: { 'space-test': before } });
  try {
    await install(options, cf.io);
    assert.deepEqual(cf.upgrades, [columnUpgrades(schema, columnsOf(db)).join('\n')]);
    assert.match(cf.upgrades[0], /ALTER TABLE apps ADD COLUMN expires_at INTEGER;/);
  } finally { await done(); }
});

test('CF-23 a first install upgrades no column', async () => {
  const { options, done } = await host(), cf = cloudflare();
  try {
    await install(options, cf.io);
    assert.deepEqual(cf.upgrades, []);
  } finally { await done(); }
});

const dataOf = async (stateDir: string) => JSON.parse(await readFile(statePaths(stateDir).data, 'utf8'));
const locations = (cf: ReturnType<typeof cloudflare>) => [cf.d1.get('space-test')!.location, cf.r2.get('space-test-artifacts')!.location, cf.r2.get('space-test-objects')!.location];

test('CF-23 a first install learns where requests for the control domain enter before it creates data, and creates D1 and R2 there', async () => {
  const { options, done } = await host(), cf = cloudflare({ colo: 'SJC' });
  try {
    await install(options, cf.io);
    const [probe, attach, create] = ['wrangler deploy probe', 'PUT /accounts/' + account + '/workers/domains', 'POST /accounts/' + account + '/d1/database'].map(call => cf.calls.indexOf(call));
    assert.ok(probe >= 0 && probe < attach && attach < create, cf.calls.join('\n'));
    assert.deepEqual(locations(cf), ['wnam', 'wnam', 'wnam']);
  } finally { await done(); }
});

test('CF-23 an explicit --location places the data without a placeholder Worker', async () => {
  const { options, done } = await host(true, { location: 'weur' }), cf = cloudflare({ colo: 'SJC' });
  try {
    await install(options, cf.io);
    assert.ok(!cf.calls.includes('wrangler deploy probe'));
    assert.deepEqual(locations(cf), ['weur', 'weur', 'weur']);
  } finally { await done(); }
});

test('CF-23 a first install that cannot learn where requests enter asks for --location and creates no data', async () => {
  const { options, done } = await host(), cf = cloudflare({ colo: null });
  try {
    await assert.rejects(install(options, cf.io), /No database or bucket was created\. Rerun with --location wnam\|enam\|weur\|eeur\|apac\|oc/);
    assert.equal(cf.d1.size + cf.r2.size, 0);
  } finally { await done(); }
});

test('CF-23 the install records and prints where the data is and where requests enter', async () => {
  const { options, stateDir, done } = await host(), cf = cloudflare({ colo: 'NRT' });
  try {
    await install(options, cf.io);
    const data = await dataOf(stateDir);
    assert.deepEqual([data.location, data.placed, data.entry], ['apac', { database: 'apac', artifacts: 'apac', objects: 'apac' }, { colo: 'NRT', location: 'apac' }]);
    assert.ok(cf.logs.includes('Data: apac. Requests from this machine enter Cloudflare at NRT (apac), where the Worker runs.'), cf.logs.join('\n'));
  } finally { await done(); }
});

test('CF-23 a rerun over data that is not where requests enter says so in one line naming --relocate and moves nothing', async () => {
  const { options, done } = await host(true, { location: 'apac' }), cf = cloudflare({ colo: 'SJC' });
  try {
    await install(options, cf.io);
    cf.calls.length = 0;
    cf.logs.length = 0;
    await install({ ...options, location: undefined }, cf.io);
    assert.deepEqual(cf.logs.filter(line => line.includes('--relocate')), ['The data is not where requests enter, so each request crosses to it and back; to move it, run node cf/scripts/install.mjs space.example.com --prefix space-test --relocate wnam.']);
    assert.deepEqual(writes(cf.calls).filter(call => !call.startsWith('PUT /accounts/' + account + '/r2/buckets/')), ['wrangler d1 execute', 'wrangler d1 execute', 'wrangler d1 execute', 'wrangler d1 execute', 'wrangler deploy']);
  } finally { await done(); }
});

test('CF-23 a rerun refuses a --location other than where the data is', async () => {
  const { options, done } = await host(true, { location: 'apac' }), cf = cloudflare();
  try {
    await install(options, cf.io);
    cf.calls.length = 0;
    await assert.rejects(install({ ...options, location: 'wnam' }, cf.io), /is in apac; --location only places new data\. To move it, run .* --relocate wnam/);
    assert.deepEqual(writes(cf.calls), []);
  } finally { await done(); }
});

test('CF-23 a rerun on a deployment installed before data locations were recorded records where Cloudflare put its data', async () => {
  const { options, stateDir, done } = await host(true, { location: 'apac' }), cf = cloudflare({ colo: 'SJC' });
  try {
    await install(options, cf.io);
    await rm(statePaths(stateDir).data);
    cf.calls.length = 0;
    await install({ ...options, location: undefined }, cf.io);
    assert.equal((await dataOf(stateDir)).location, 'apac');
    assert.ok(!cf.calls.some(call => call.startsWith('POST ') || call === 'wrangler deploy probe'), cf.calls.join('\n'));
  } finally { await done(); }
});
