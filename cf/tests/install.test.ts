import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error The installer is a plain Node script.
import { install, generateConfig, workerSecrets, statePaths, Stop } from '../scripts/install.mjs';

const cfDir = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const account = 'account-example', token = 'example-api-token';

function cloudflare({ scripts = [] as string[], buckets = [] as string[], databases = [] as { name: string, uuid: string }[], domains = [] as { hostname: string, service: string }[], secrets = [] as string[], deploys = [0] } = {}) {
  const calls: string[] = [], logs: string[] = [];
  const reply = (result: unknown, status = 200) => Response.json({ success: status < 400, result, errors: status < 400 ? [] : [{ message: 'not found' }] }, { status });
  const fetch = async (url: string, init: RequestInit = {}) => {
    const { pathname, searchParams } = new URL(url), method = init.method ?? 'GET', path = pathname.replace('/client/v4', '');
    if (path === '/_pneuma-space/health') return Response.json({ service: 'pneuma-space-cf' });
    calls.push(method + ' ' + path);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (path === '/zones') return reply(searchParams.get('name') === 'example.com' ? [{ id: 'zone-example', name: 'example.com' }] : []);
    if (path === '/accounts/' + account + '/tokens/verify') return reply({ id: 'token-id', status: 'active', expires_on: '2027-01-01T00:00:00Z' });
    if (path === '/accounts/' + account + '/workers/scripts') return reply(scripts.map(id => ({ id })));
    if (path === '/accounts/' + account + '/d1/database' && method === 'GET') return reply(databases);
    if (path === '/accounts/' + account + '/d1/database') { databases.push({ name: body.name, uuid: 'database-' + body.name }); return reply(databases.at(-1)); }
    const bucket = /^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)(\/cors)?$/.exec(path);
    if (bucket && !bucket[2]) return buckets.includes(bucket[1]) ? reply({ name: bucket[1] }) : reply(null, 404);
    if (bucket) return reply({});
    if (path === '/accounts/' + account + '/r2/buckets') { buckets.push(body.name); return reply({}); }
    if (path === '/accounts/' + account + '/workers/scripts/space-test/secrets') return reply(secrets.map(name => ({ name, type: 'secret_text' })));
    if (path.startsWith('/accounts/' + account + '/workers/scripts/space-test/secrets/') && method === 'DELETE') return reply(null);
    if (path === '/accounts/' + account + '/workers/domains' && method === 'GET') return reply(domains);
    if (path === '/accounts/' + account + '/workers/domains') { domains.push(body); return reply(body); }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const run = (command: string, args: string[]) => {
    if (command === 'docker') return { status: 0, stdout: '' };
    const [verb, sub] = args.slice(1);
    calls.push('wrangler ' + (verb === 'd1' ? 'd1 ' + sub : verb));
    if (verb === 'whoami') return { status: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: account, name: 'Example' }] }) };
    if (verb === 'auth') return { status: 0, stdout: JSON.stringify({ type: 'oauth', token: 'session' }) };
    if (verb === 'd1' && args.includes('--json')) return { status: 0, stdout: JSON.stringify([{ results: [{ owners: 1 }] }]) };
    if (verb === 'deploy') return { status: deploys.shift() ?? 0, stdout: '' };
    return { status: 0, stdout: '' };
  };
  return { calls, logs, io: { fetch, run, sleep: async () => {}, log: (line: string) => logs.push(line) } };
}

async function host(saveToken = true) {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'pneuma-space-install-')), 'space.example.com');
  const options = { domain: 'space.example.com', prefix: 'space-test', stateDir };
  if (saveToken) { await mkdir(stateDir); await writeFile(statePaths(stateDir).token, token + '\n'); }
  return { options, stateDir, done: () => rm(join(stateDir, '..'), { recursive: true, force: true }) };
}

const writes = (calls: string[]) => calls.filter(call => /^(POST|PUT|DELETE) |^wrangler (d1|deploy)/.test(call));

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
    assert.deepEqual(writes(cf.calls).filter(call => !call.startsWith('PUT /accounts/' + account + '/r2/buckets/')), ['wrangler d1 execute', 'wrangler d1 execute', 'wrangler d1 execute', 'wrangler deploy']);
  } finally { await done(); }
});

test('CF-23 generated files live only in the private state directory', async () => {
  const { options, stateDir, done } = await host();
  try {
    await install(options, cloudflare().io);
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    for (const file of await readdir(stateDir)) assert.equal((await stat(join(stateDir, file))).mode & 0o777, 0o600, file);
    assert.deepEqual((await readdir(stateDir)).sort(), ['api-token', 'owner.json', 'worker-secrets.json', 'wrangler.json']);
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
