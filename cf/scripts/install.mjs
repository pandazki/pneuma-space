import { readFile, writeFile, mkdir, chmod, rm, access } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const CF_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const API = 'https://api.cloudflare.com/client/v4';
const DEPLOY_ATTEMPTS = 3;
const HEALTH_WAIT_MS = 20 * 60000;
const USAGE = 'Usage: node cf/scripts/install.mjs CONTROL_DOMAIN --prefix PREFIX [--owner USERNAME] [--account ACCOUNT_ID] [--apps-domain DOMAIN]';

export class Stop extends Error {}

function parseInstallArgs(argv, home = homedir()) {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: { prefix: { type: 'string' }, owner: { type: 'string' }, account: { type: 'string' }, 'apps-domain': { type: 'string' } } }); }
  catch (error) { throw new Stop(error.message + '\n' + USAGE); }
  const domain = parsed.positionals[0]?.toLowerCase(), prefix = parsed.values.prefix;
  const appsDomain = (parsed.values['apps-domain'] ?? domain)?.toLowerCase();
  if (parsed.positionals.length !== 1 || !prefix) throw new Stop(USAGE);
  for (const name of [domain, appsDomain]) if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw new Stop('Give a domain name such as space.example.com, not ' + JSON.stringify(name) + '.');
  if (!/^[a-z](?:[a-z0-9-]{0,51}[a-z0-9])$/.test(prefix)) throw new Stop('Use a prefix of 2 to 53 lowercase letters, digits or hyphens that starts with a letter; it names the Worker, D1 database and R2 buckets.');
  if (parsed.values.owner !== undefined && !/^[a-z][a-z0-9_-]{2,31}$/.test(parsed.values.owner)) throw new Stop('Use an owner username of 3 to 32 lowercase letters, digits, hyphens or underscores that starts with a letter.');
  return { domain, prefix, appsDomain, owner: parsed.values.owner, account: parsed.values.account, stateDir: join(home, '.pneuma-space', 'hosts', domain) };
}

export const statePaths = stateDir => ({ config: join(stateDir, 'wrangler.json'), token: join(stateDir, 'api-token'), secrets: join(stateDir, 'worker-secrets.json'), owner: join(stateDir, 'owner.json') });

const resourceNames = prefix => ({ worker: prefix, database: prefix, artifacts: prefix + '-artifacts', objects: prefix + '-objects' });

function tokenLink(prefix) {
  const keys = [{ key: 'workers_scripts', type: 'edit' }, { key: 'workers_r2', type: 'edit' }];
  return 'https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=' + encodeURIComponent(JSON.stringify(keys)) + '&name=' + encodeURIComponent(prefix);
}

export function generateConfig(template, { cfDir, prefix, domain, appsDomain, accountId, zoneId, databaseId }) {
  const names = resourceNames(prefix), config = structuredClone(template);
  delete config.$schema;
  Object.assign(config, { name: names.worker, account_id: accountId, main: join(cfDir, config.main), build: { ...config.build, cwd: cfDir } });
  Object.assign(config.vars, {
    PNEUMA_SPACE_CONTROL_ORIGIN: 'https://' + domain, PNEUMA_SPACE_APPS_DOMAIN: appsDomain, PNEUMA_SPACE_ACCOUNT_ID: accountId, PNEUMA_SPACE_ZONE_ID: zoneId,
    PNEUMA_SPACE_WORKER_NAME: names.worker, PNEUMA_SPACE_ARTIFACT_BUCKET: names.artifacts, PNEUMA_SPACE_OBJECT_BUCKET: names.objects,
  });
  config.d1_databases[0] = { ...config.d1_databases[0], database_name: names.database, database_id: databaseId };
  config.r2_buckets = config.r2_buckets.map(bucket => ({ ...bucket, bucket_name: bucket.binding === 'PNEUMA_SPACE_ARTIFACTS' ? names.artifacts : names.objects }));
  config.containers = config.containers.map(container => ({ ...container, name: names.worker, images: Object.fromEntries(Object.entries(container.images).map(([key, image]) => [key, { ...image, dockerfile: join(cfDir, image.dockerfile) }])) }));
  config.assets = { ...config.assets, directory: join(cfDir, config.assets.directory) };
  return config;
}

function artifactCors(template, origin) {
  return { rules: template.rules.map(rule => ({ ...rule, allowed: { ...rule.allowed, origins: [origin] } })) };
}

export function workerSecrets(token, tokenId, existing = {}) {
  return { ...existing, PNEUMA_SPACE_CF_API_TOKEN: token, PNEUMA_SPACE_R2_ACCESS_KEY_ID: tokenId, PNEUMA_SPACE_R2_SECRET_ACCESS_KEY: createHash('sha256').update(token).digest('hex') };
}

const nodeIo = {
  run: (command, args, { capture = false, cwd } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    return { status: result.error ? 127 : result.status ?? 1, stdout: result.stdout ?? '' };
  },
  fetch: (url, init) => fetch(url, init),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  log: line => console.log(line),
};

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function writePrivate(path, text) {
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function api(io, token, method, path, body) {
  const response = await io.fetch(API + path, {
    method, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  }).catch(error => { throw new Stop('The Cloudflare API did not answer (' + error.message + '); run the same command again.'); });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok && json.success !== false, result: json.result, errors: (json.errors ?? []).map(error => error.message).join('; ') };
}

function must(response, action) {
  if (!response.ok) throw new Stop(action + ' failed (' + response.status + (response.errors ? ': ' + response.errors : '') + ').');
  return response.result;
}

function wranglerRunner(io, cfDir, stateDir) {
  return (args, capture) => io.run(process.execPath, [join(cfDir, 'node_modules/wrangler/bin/wrangler.js'), ...args], { capture, cwd: stateDir });
}

async function preflight(io, options, cfDir) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Stop('Install Node.js 24 or later; this is ' + process.version + '.');
  if (io.run('docker', ['info'], { capture: true }).status !== 0) throw new Stop('Start Docker; the deployment builds a linux/amd64 runner image.');
  try { await access(join(cfDir, 'node_modules/wrangler/bin/wrangler.js')); }
  catch { if (io.run('npm', ['ci'], { cwd: cfDir }).status !== 0) throw new Stop('Run npm ci in ' + cfDir + ' and fix what it reports.'); }
  const wrangler = wranglerRunner(io, cfDir, options.stateDir);
  const who = wrangler(['whoami', '--json'], true);
  let identity;
  try { identity = JSON.parse(who.stdout); } catch { identity = {}; }
  if (who.status !== 0 || !identity.loggedIn) throw new Stop('Log in with npx wrangler login, run from ' + cfDir + '.');
  const accounts = identity.accounts ?? [];
  const account = options.account ? accounts.find(candidate => candidate.id === options.account) : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) throw new Stop(options.account ? 'The Wrangler login cannot see account ' + options.account + '.' : 'Choose an account with --account: ' + accounts.map(candidate => candidate.id + ' (' + candidate.name + ')').join(', ') + '.');
  const auth = wrangler(['auth', 'token', '--json'], true);
  let session;
  try { session = JSON.parse(auth.stdout).token; } catch {}
  if (auth.status !== 0 || !session) throw new Stop('Log in again with npx wrangler login; Wrangler returned no session token.');
  const labels = options.domain.split('.');
  let zone;
  for (let index = 0; index < labels.length - 1 && !zone; index++) {
    zone = must(await api(io, session, 'GET', '/zones?name=' + labels.slice(index).join('.') + '&account.id=' + account.id), 'Zone lookup')[0];
  }
  if (!zone) throw new Stop('Add the zone of ' + options.domain + ' to account ' + account.id + ' in Cloudflare first.');
  if (options.appsDomain !== zone.name && !options.appsDomain.endsWith('.' + zone.name)) throw new Stop('Use an apps domain inside zone ' + zone.name + ', the zone of the control domain.');
  return { accountId: account.id, zoneId: zone.id, session, wrangler };
}

async function readToken(io, options, paths, accountId) {
  const token = (await readOptional(paths.token))?.trim();
  const ask = 'Create an account API token here (Workers Scripts edit, Workers R2 Storage edit):\n  ' + tokenLink(options.prefix) + '\nSave the token alone in ' + paths.token + ' and run the same command again.';
  if (!token) throw new Stop('No API token is saved for ' + options.domain + '.\n' + ask);
  await chmod(paths.token, 0o600);
  let verified = await api(io, token, 'GET', '/accounts/' + accountId + '/tokens/verify');
  if (!verified.ok) verified = await api(io, token, 'GET', '/user/tokens/verify');
  if (!verified.ok || verified.result?.status !== 'active') throw new Stop('The token in ' + paths.token + ' is not an active API token.\n' + ask);
  const expiry = verified.result.expires_on;
  io.log(expiry
    ? 'API token expires ' + expiry.slice(0, 10) + '. After that, new app domains cannot attach and publishes cannot sign upload URLs; save a new token in ' + paths.token + ' and rerun this command.'
    : 'API token has no expiry.');
  return { token, tokenId: verified.result.id };
}

async function claimNames(io, options, paths, accountId, session, token) {
  const previous = await readOptional(paths.config);
  if (previous) {
    const config = JSON.parse(previous);
    if (config.name !== options.prefix || config.vars.PNEUMA_SPACE_ACCOUNT_ID !== accountId) throw new Stop(options.domain + ' was installed as ' + config.name + ' in account ' + config.vars.PNEUMA_SPACE_ACCOUNT_ID + '; rerun with that prefix and account.');
    return true;
  }
  const names = resourceNames(options.prefix), taken = [];
  const scripts = must(await api(io, token, 'GET', '/accounts/' + accountId + '/workers/scripts'), 'Worker listing');
  if (scripts.some(script => script.id === names.worker)) taken.push('Worker ' + names.worker);
  if (await findDatabase(io, session, accountId, names.database)) taken.push('D1 database ' + names.database);
  for (const bucket of [names.artifacts, names.objects]) if (await bucketExists(io, token, accountId, bucket)) taken.push('R2 bucket ' + bucket);
  if (taken.length) throw new Stop('Already in this account: ' + taken.join(', ') + '. Choose another --prefix.');
  return false;
}

async function findDatabase(io, session, accountId, name) {
  const listed = must(await api(io, session, 'GET', '/accounts/' + accountId + '/d1/database?per_page=100&name=' + encodeURIComponent(name)), 'D1 listing');
  return listed.find(database => database.name === name)?.uuid;
}

async function bucketExists(io, token, accountId, name) {
  const response = await api(io, token, 'GET', '/accounts/' + accountId + '/r2/buckets/' + name);
  if (response.status === 404) return false;
  must(response, 'R2 bucket lookup');
  return true;
}

async function ensureDatabase(io, session, accountId, name) {
  const existing = await findDatabase(io, session, accountId, name);
  if (existing) return existing;
  io.log('Creating D1 database ' + name + '.');
  return must(await api(io, session, 'POST', '/accounts/' + accountId + '/d1/database', { name }), 'D1 creation').uuid;
}

async function ensureBucket(io, token, accountId, name, cors) {
  if (!await bucketExists(io, token, accountId, name)) {
    io.log('Creating R2 bucket ' + name + '.');
    must(await api(io, token, 'POST', '/accounts/' + accountId + '/r2/buckets', { name }), 'R2 bucket creation');
  }
  must(await api(io, token, 'PUT', '/accounts/' + accountId + '/r2/buckets/' + name + '/cors', cors), 'R2 CORS update');
}

const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

async function provisionOwner(wrangler, { configPath, database, origin, username, credentialsPath }) {
  let credential = JSON.parse(await readOptional(credentialsPath) ?? 'null');
  if (credential && (credential.origin !== origin || (username && credential.account !== username))) throw new Stop(credentialsPath + ' belongs to account ' + credential.account + ' at ' + credential.origin + '; it is kept as it is.');
  if (!credential) {
    credential = { origin, account: username ?? 'owner', key: randomBytes(32).toString('hex'), userId: 'u_' + randomBytes(16).toString('hex'), tenantId: 't_' + randomBytes(16).toString('hex') };
    await writeFile(credentialsPath, JSON.stringify(credential, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  await chmod(credentialsPath, 0o600);
  const keyHash = createHash('sha256').update(credential.key).digest('hex'), now = Date.now();
  const sql = [
    'INSERT OR IGNORE INTO users(id,username,name,key_hash,platform_admin,created_at) VALUES(' + [credential.userId, credential.account, credential.account, keyHash, 1, now].map(quote).join(',') + ');',
    'INSERT OR IGNORE INTO tenants(id,name,created_at) VALUES(' + [credential.tenantId, credential.account + "'s space", now].map(quote).join(',') + ');',
    'INSERT OR IGNORE INTO memberships(tenant_id,user_id,role) SELECT ' + quote(credential.tenantId) + ',' + quote(credential.userId) + ",'admin' WHERE EXISTS(SELECT 1 FROM users WHERE id=" + quote(credential.userId) + ' AND key_hash=' + quote(keyHash) + ');',
  ].join('\n');
  const sqlPath = credentialsPath + '.sql';
  await writePrivate(sqlPath, sql);
  try { if (wrangler(['d1', 'execute', database, '--remote', '--file', sqlPath, '--yes', '--config', configPath]).status !== 0) throw new Stop('Owner provisioning failed; rerun this command.'); }
  finally { await rm(sqlPath, { force: true }); }
  const query = 'SELECT count(*) AS owners FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=' + quote(credential.userId) + ' AND u.username=' + quote(credential.account) + ' AND u.key_hash=' + quote(keyHash) + ' AND u.platform_admin=1 AND u.disabled=0 AND m.tenant_id=' + quote(credential.tenantId) + " AND m.role='admin';";
  const verified = wrangler(['d1', 'execute', database, '--remote', '--command', query, '--yes', '--json', '--config', configPath], true);
  let rows = [];
  try { rows = JSON.parse(verified.stdout).flatMap(result => result.results ?? []); } catch {}
  if (verified.status !== 0) throw new Stop('Owner verification failed; rerun this command.');
  if (!rows.some(row => row.owners === 1)) throw new Stop('Owner ' + credential.account + ' exists with a different key; no existing key was replaced.');
  return credential;
}

async function attachDomain(io, token, { accountId, zoneId, hostname, service }) {
  const endpoint = '/accounts/' + accountId + '/workers/domains';
  const existing = must(await api(io, token, 'GET', endpoint), 'Worker domain listing').find(domain => domain.hostname === hostname);
  if (existing && existing.service !== service) throw new Stop(hostname + ' is attached to Worker ' + existing.service + '; refusing to replace it.');
  if (!existing) {
    io.log('Attaching ' + hostname + ' to ' + service + '.');
    must(await api(io, token, 'PUT', endpoint, { hostname, service, zone_id: zoneId }), 'Domain attachment');
  }
}

async function waitForHealth(io, origin) {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await io.fetch(origin + '/_pneuma-space/health', { signal: AbortSignal.timeout(15000) });
      if (response.ok && (await response.json()).service === 'pneuma-space-cf') return;
    } catch {}
    await io.sleep(15000);
  }
  throw new Stop(origin + ' does not answer over valid HTTPS yet; the certificate may still be issuing. Run the same command again later.');
}

export async function install(options, io = nodeIo, cfDir = CF_DIR) {
  const paths = statePaths(options.stateDir), names = resourceNames(options.prefix), origin = 'https://' + options.domain;
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await chmod(options.stateDir, 0o700);
  const { accountId, zoneId, session, wrangler } = await preflight(io, options, cfDir);
  const { token, tokenId } = await readToken(io, options, paths, accountId);
  const template = JSON.parse(await readFile(join(cfDir, 'wrangler.jsonc'), 'utf8'));
  const write = databaseId => writePrivate(paths.config, JSON.stringify(generateConfig(template, { cfDir, ...options, accountId, zoneId, databaseId }), null, 2) + '\n');
  if (!await claimNames(io, options, paths, accountId, session, token)) await write(template.d1_databases[0].database_id);
  await write(await ensureDatabase(io, session, accountId, names.database));
  await ensureBucket(io, token, accountId, names.artifacts, artifactCors(JSON.parse(await readFile(join(cfDir, 'deploy/artifact-cors.json'), 'utf8')), origin));
  await ensureBucket(io, token, accountId, names.objects, JSON.parse(await readFile(join(cfDir, 'deploy/object-cors.json'), 'utf8')));
  if (wrangler(['d1', 'execute', names.database, '--remote', '--file', join(cfDir, 'schema.sql'), '--yes', '--config', paths.config]).status !== 0) throw new Stop('Schema application failed; rerun this command.');
  await writePrivate(paths.secrets, JSON.stringify(workerSecrets(token, tokenId, JSON.parse(await readOptional(paths.secrets) ?? '{}')), null, 2) + '\n');
  const owner = await provisionOwner(wrangler, { configPath: paths.config, database: names.database, origin, username: options.owner, credentialsPath: paths.owner });
  let deployed = false;
  for (let attempt = 1; attempt <= DEPLOY_ATTEMPTS && !deployed; attempt++) {
    if (attempt > 1) { io.log('Deploy attempt ' + (attempt - 1) + ' failed; retrying.'); await io.sleep(10000); }
    deployed = wrangler(['deploy', '--config', paths.config, '--secrets-file', paths.secrets]).status === 0;
  }
  if (!deployed) throw new Stop('Deployment failed ' + DEPLOY_ATTEMPTS + ' times; read the Wrangler output above, then run the same command again.');
  await attachDomain(io, token, { accountId, zoneId, hostname: options.domain, service: names.worker });
  io.log('Waiting for ' + origin + ' to answer over HTTPS.');
  await waitForHealth(io, origin);
  io.log('Installed. Console: ' + origin + '\nOwner credentials: ' + paths.owner + '\nSign in at ' + origin + '/login with the account (' + owner.account + ') and key in that file.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await install(parseInstallArgs(process.argv.slice(2))); }
  catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
