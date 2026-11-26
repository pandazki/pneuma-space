import { readFile, writeFile, mkdir, chmod, rm, access } from 'node:fs/promises';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const CF_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const API = 'https://api.cloudflare.com/client/v4';
const DEPLOY_ATTEMPTS = 3;
const HEALTH_WAIT_MS = 20 * 60000;
const ENTRY_ATTEMPTS = 20;
/** signR2 signs for at most an hour, so after this no URL signed before a switch still works. */
const SIGNED_URL_MAX_MS = 3600000;
/** The old Worker's clock may lag this machine's; an audit row read twice is inserted once. */
const CLOCK_MARGIN_MS = 300000;
/** schema.sql's triggers refuse UPDATE and DELETE on it. */
const APPEND_ONLY = 'audit';
export const LOCATIONS = ['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'];
const USAGE = 'Usage: node cf/scripts/install.mjs CONTROL_DOMAIN --prefix PREFIX [--owner USERNAME] [--account ACCOUNT_ID] [--location HINT | --relocate HINT [--yes] | --remove-previous]';

export class Stop extends Error {}

function parseInstallArgs(argv, home = homedir()) {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: { prefix: { type: 'string' }, owner: { type: 'string' }, account: { type: 'string' }, location: { type: 'string' }, relocate: { type: 'string' }, yes: { type: 'boolean' }, 'remove-previous': { type: 'boolean' } } }); }
  catch (error) { throw new Stop(error.message + '\n' + USAGE); }
  const domain = parsed.positionals[0]?.toLowerCase(), { prefix, location, relocate, yes = false, 'remove-previous': removePrevious = false } = parsed.values;
  if (parsed.positionals.length !== 1 || !prefix || [location, relocate, removePrevious || undefined].filter(Boolean).length > 1 || (yes && !relocate)) throw new Stop(USAGE);
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Stop('Give a domain name such as space.example.com, not ' + JSON.stringify(domain) + '.');
  if (!/^[a-z](?:[a-z0-9-]{0,51}[a-z0-9])$/.test(prefix)) throw new Stop('Use a prefix of 2 to 53 lowercase letters, digits or hyphens that starts with a letter; it names the Worker, D1 database and R2 buckets.');
  if (parsed.values.owner !== undefined && !/^[a-z][a-z0-9_-]{2,31}$/.test(parsed.values.owner)) throw new Stop('Use an owner username of 3 to 32 lowercase letters, digits, hyphens or underscores that starts with a letter.');
  for (const hint of [location, relocate]) if (hint !== undefined && !LOCATIONS.includes(hint)) throw new Stop('Use one of the location hints ' + LOCATIONS.join(', ') + ', not ' + JSON.stringify(hint) + '.');
  return { domain, prefix, owner: parsed.values.owner, account: parsed.values.account, location, relocate, yes, removePrevious, stateDir: join(home, '.pneuma-space', 'hosts', domain) };
}

export const statePaths = stateDir => ({ config: join(stateDir, 'wrangler.json'), token: join(stateDir, 'api-token'), secrets: join(stateDir, 'worker-secrets.json'), owner: join(stateDir, 'owner.json'), data: join(stateDir, 'data.json') });

const resourceNames = prefix => ({ worker: prefix, database: prefix, artifacts: prefix + '-artifacts', objects: prefix + '-objects' });
/** Names are unique per account, and R2 keeps a deleted bucket's location for its name, so moved data carries its location in its names. */
const movedNames = (prefix, location) => ({ database: prefix + '-' + location, artifacts: prefix + '-' + location + '-artifacts', objects: prefix + '-' + location + '-objects' });
const dataNames = ({ database, artifacts, objects }) => ({ database, artifacts, objects });

function tokenLink(prefix) {
  const keys = [{ key: 'workers_scripts', type: 'edit' }, { key: 'workers_r2', type: 'edit' }];
  return 'https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=' + encodeURIComponent(JSON.stringify(keys)) + '&name=' + encodeURIComponent(prefix);
}

export function generateConfig(template, { cfDir, prefix, domain, accountId, databaseId, names = resourceNames(prefix) }) {
  const config = structuredClone(template);
  delete config.$schema;
  Object.assign(config, { name: prefix, account_id: accountId, main: join(cfDir, config.main), build: { ...config.build, cwd: cfDir } });
  Object.assign(config.vars, {
    PNEUMA_SPACE_CONTROL_ORIGIN: 'https://' + domain, PNEUMA_SPACE_ACCOUNT_ID: accountId,
    PNEUMA_SPACE_ARTIFACT_BUCKET: names.artifacts, PNEUMA_SPACE_OBJECT_BUCKET: names.objects,
  });
  config.d1_databases[0] = { ...config.d1_databases[0], database_name: names.database, database_id: databaseId };
  config.r2_buckets = config.r2_buckets.map(bucket => ({ ...bucket, bucket_name: bucket.binding === 'PNEUMA_SPACE_ARTIFACTS' ? names.artifacts : names.objects }));
  config.containers = config.containers.map(container => ({ ...container, name: prefix, images: Object.fromEntries(Object.entries(container.images).map(([key, image]) => [key, { ...image, dockerfile: join(cfDir, image.dockerfile) }])) }));
  config.assets = { ...config.assets, directory: join(cfDir, config.assets.directory) };
  return config;
}

function artifactCors(template, origin) {
  return { rules: template.rules.map(rule => ({ ...rule, allowed: { ...rule.allowed, origins: [origin] } })) };
}

const LEGACY_TOKEN_SECRET = 'PNEUMA_SPACE_CF_API_TOKEN';

export function workerSecrets(token, tokenId, { [LEGACY_TOKEN_SECRET]: _, ...existing } = {}) {
  return { ...existing, PNEUMA_SPACE_R2_ACCESS_KEY_ID: tokenId, PNEUMA_SPACE_R2_SECRET_ACCESS_KEY: createHash('sha256').update(token).digest('hex') };
}

const nodeIo = {
  run: (command, args, { capture = false, cwd } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    return { status: result.error ? 127 : result.status ?? 1, stdout: result.stdout ?? '' };
  },
  fetch: (url, init) => fetch(url, init),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  log: line => console.log(line),
  now: () => Date.now(),
};

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function writePrivate(path, text) {
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}

const readJson = async path => JSON.parse(await readOptional(path) ?? 'null');
const saveData = (paths, data) => writePrivate(paths.data, JSON.stringify(data, null, 2) + '\n');

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
    ? 'API token expires ' + expiry.slice(0, 10) + '. The R2 signing key derives from it, so after that publishing cannot upload packages and apps cannot hand out object upload or download URLs; save a new token in ' + paths.token + ' and rerun this command.'
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

async function ensureDatabase(io, session, accountId, name, location) {
  const existing = await findDatabase(io, session, accountId, name);
  if (existing) return existing;
  io.log('Creating D1 database ' + name + (location ? ' in ' + location : '') + '.');
  return must(await api(io, session, 'POST', '/accounts/' + accountId + '/d1/database', { name, primary_location_hint: location }), 'D1 creation').uuid;
}

async function ensureBucket(io, token, accountId, name, cors, location) {
  if (!await bucketExists(io, token, accountId, name)) {
    io.log('Creating R2 bucket ' + name + (location ? ' in ' + location : '') + '.');
    must(await api(io, token, 'POST', '/accounts/' + accountId + '/r2/buckets', { name, locationHint: location }), 'R2 bucket creation');
  }
  must(await api(io, token, 'PUT', '/accounts/' + accountId + '/r2/buckets/' + name + '/cors', cors), 'R2 CORS update');
}

/** Splits a CREATE TABLE body at its top-level commas. */
function definitions(body) {
  const parts = [''];
  let depth = 0;
  for (const char of body) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0;
    if (char === ',' && depth === 0) parts.push(''); else parts[parts.length - 1] += char;
  }
  return parts.map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/** CREATE TABLE IF NOT EXISTS leaves an existing table as it is, so a column schema.sql gained since is added here. */
export function columnUpgrades(schema, existing) {
  const statements = [];
  for (const [, table, body] of schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\);/g)) {
    if (!existing[table]?.length) continue;
    for (const definition of definitions(body)) {
      const column = /^\w+/.exec(definition)[0];
      if (!/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(column) && !existing[table].includes(column)) statements.push('ALTER TABLE ' + table + ' ADD COLUMN ' + definition + ';');
    }
  }
  return statements;
}

async function upgradeColumns(wrangler, { configPath, database, schema, stateDir }) {
  const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) /g)].map(match => match[1]);
  const listed = wrangler(['d1', 'execute', database, '--remote', '--command', tables.map(table => 'PRAGMA table_info(' + table + ');').join(' '), '--yes', '--json', '--config', configPath], true);
  let results;
  try { results = JSON.parse(listed.stdout); } catch {}
  if (listed.status !== 0 || !Array.isArray(results) || results.length !== tables.length) throw new Stop('Reading the existing schema failed; rerun this command.');
  const statements = columnUpgrades(schema, Object.fromEntries(tables.map((table, index) => [table, (results[index].results ?? []).map(row => row.name)])));
  if (!statements.length) return;
  const sqlPath = join(stateDir, 'upgrade.sql');
  await writePrivate(sqlPath, statements.join('\n'));
  try { if (wrangler(['d1', 'execute', database, '--remote', '--file', sqlPath, '--yes', '--config', configPath]).status !== 0) throw new Stop('Schema upgrade failed; rerun this command.'); }
  finally { await rm(sqlPath, { force: true }); }
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

async function removeLegacyToken(io, token, accountId, worker) {
  const path = '/accounts/' + accountId + '/workers/scripts/' + worker + '/secrets';
  if (!must(await api(io, token, 'GET', path), 'Worker secret listing').some(secret => secret.name === LEGACY_TOKEN_SECRET)) return;
  io.log('Removing ' + LEGACY_TOKEN_SECRET + ' from ' + worker + '; the Worker no longer uses it.');
  must(await api(io, token, 'DELETE', path + '/' + LEGACY_TOKEN_SECRET), 'Worker secret removal');
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

/** Reads the data center a request for the control domain enters, from /cdn-cgi/trace or, before HTTPS works, the CF-Ray suffix. */
async function measureEntry(io, domain, attempts) {
  for (let attempt = 1; ; attempt++) {
    for (const scheme of ['https://', 'http://']) {
      const response = await io.fetch(scheme + domain + '/cdn-cgi/trace', { redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => undefined);
      if (!response) continue;
      const colo = /^colo=([A-Z]{3})$/m.exec(await response.text().catch(() => ''))?.[1] ?? /-([A-Z]{3})$/.exec(response.headers.get('cf-ray') ?? '')?.[1];
      if (colo) return colo;
    }
    if (attempt >= attempts) return undefined;
    await io.sleep(10000);
  }
}

/** The control domain answers through its own zone only once a Worker holds it, so a placeholder holds it until the real deploy replaces it. */
async function measureBeforeData(ctx) {
  const { io, options, accountId, zoneId, token, template, wrangler } = ctx;
  const config = join(options.stateDir, 'probe.json'), main = join(options.stateDir, 'probe.mjs');
  await writePrivate(main, "export default { fetch: () => new Response('Installing.', { status: 503 }) };\n");
  await writePrivate(config, JSON.stringify({ name: options.prefix, account_id: accountId, main, compatibility_date: template.compatibility_date, workers_dev: false }));
  try { if (wrangler(['deploy', '--config', config]).status !== 0) throw new Stop('Deploying a placeholder Worker for ' + options.domain + ' failed; rerun this command.'); }
  finally { await rm(config, { force: true }); await rm(main, { force: true }); }
  await attachDomain(io, token, { accountId, zoneId, hostname: options.domain, service: options.prefix });
  io.log('Measuring where requests for ' + options.domain + ' enter Cloudflare from this machine.');
  const colo = await measureEntry(io, options.domain, ENTRY_ATTEMPTS), location = colo && ctx.coloLocations[colo];
  if (!location) throw new Stop((colo ? 'Requests for ' + options.domain + ' enter Cloudflare at ' + colo + ', a data center this installer cannot place' : 'This machine could not reach ' + options.domain + ' through Cloudflare to learn where its requests enter') + '. No database or bucket was created. Rerun with --location ' + LOCATIONS.join('|') + ', naming the region where your users\' requests for the control domain enter Cloudflare (see README).');
  return { colo, location };
}

async function databaseRegion(ctx, databaseId) {
  return must(await api(ctx.io, ctx.session, 'GET', '/accounts/' + ctx.accountId + '/d1/database/' + databaseId), 'D1 lookup')?.running_in_region?.toLowerCase();
}

async function locate(ctx, databaseId, names) {
  const bucket = async name => must(await api(ctx.io, ctx.token, 'GET', '/accounts/' + ctx.accountId + '/r2/buckets/' + name), 'R2 bucket lookup')?.location?.toLowerCase();
  return { database: await databaseRegion(ctx, databaseId), artifacts: await bucket(names.artifacts), objects: await bucket(names.objects) };
}

const describe = places => places.database === places.artifacts && places.database === places.objects ? places.database ?? 'locations Cloudflare does not report' : 'D1 ' + (places.database ?? '?') + ', R2 artifacts ' + (places.artifacts ?? '?') + ', R2 objects ' + (places.objects ?? '?');

const command = (options, flag) => 'node cf/scripts/install.mjs ' + options.domain + ' --prefix ' + options.prefix + (options.account ? ' --account ' + options.account : '') + ' ' + flag;

/** An install from before data.json existed: its data is wherever Cloudflare put it. */
async function adopt(ctx) {
  const names = resourceNames(ctx.options.prefix), databaseId = await findDatabase(ctx.io, ctx.session, ctx.accountId, names.database);
  if (!databaseId) return null;
  const data = { location: await databaseRegion(ctx, databaseId), names: dataNames(names) };
  await saveData(ctx.paths, data);
  return data;
}

async function place(ctx) {
  const entry = ctx.options.location ? undefined : await measureBeforeData(ctx);
  const data = { location: ctx.options.location ?? entry.location, names: dataNames(resourceNames(ctx.options.prefix)) };
  await saveData(ctx.paths, data);
  return { data, entry };
}

const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** AWS Signature Version 4 for one request. */
export function signV4({ keyId, secret, region, service, method, host, path, query = {}, headers = {}, payloadHash, timestamp }) {
  const date = timestamp.slice(0, 8), scope = date + '/' + region + '/' + service + '/aws4_request';
  const canonicalQuery = Object.entries(query).map(([k, v]) => [encode(k), encode(v)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => k + '=' + v).join('&');
  const signed = Object.fromEntries(Object.entries({ ...headers, host }).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const names = Object.keys(signed).sort();
  const canonical = [method, path, canonicalQuery, names.map(name => name + ':' + signed[name] + '\n').join(''), names.join(';'), payloadHash].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
  return 'AWS4-HMAC-SHA256 Credential=' + keyId + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + createHmac('sha256', key).update(['AWS4-HMAC-SHA256', timestamp, scope, sha256(canonical)].join('\n')).digest('hex');
}

/** R2's S3 API under the key the Worker signs with, so a copy that succeeds shows the Worker can sign for the new buckets. */
function r2Client(ctx) {
  const { io, accountId } = ctx, secrets = workerSecrets(ctx.token, ctx.tokenId), host = accountId + '.r2.cloudflarestorage.com';
  return async (method, bucket, key, { query = {}, headers = {}, body } = {}) => {
    const path = '/' + bucket + (key === undefined ? '' : '/' + key.split('/').map(encode).join('/'));
    const timestamp = new Date(io.now()).toISOString().replace(/[-:]|\.\d{3}/g, '');
    const sent = { ...headers, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': timestamp };
    const authorization = signV4({ keyId: secrets.PNEUMA_SPACE_R2_ACCESS_KEY_ID, secret: secrets.PNEUMA_SPACE_R2_SECRET_ACCESS_KEY, region: 'auto', service: 's3', method, host, path, query, headers: sent, payloadHash: 'UNSIGNED-PAYLOAD', timestamp });
    const search = new URLSearchParams(query).toString();
    const response = await io.fetch('https://' + host + path + (search ? '?' + search : ''), { method, headers: { ...sent, authorization }, body, signal: AbortSignal.timeout(120000) })
      .catch(error => { throw new Stop('R2 did not answer (' + error.message + '); run the same command again.'); });
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) throw new Stop('R2 ' + method + ' ' + bucket + (key === undefined ? '' : '/' + key) + ' failed (' + response.status + '); run the same command again.');
    return response;
  };
}

const xmlText = value => value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, dec, hex, name) => dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()]);

/** Every object with its size, ETag and R2's modification time, and R2's clock when the listing began. */
async function listBucket(client, bucket) {
  const objects = new Map();
  let token, date;
  do {
    const response = await client('GET', bucket, undefined, { query: { 'list-type': '2', ...(token && { 'continuation-token': token }) } });
    date ??= Date.parse(response.headers.get('date') ?? '');
    const xml = await response.text();
    for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const field = name => xmlText(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(item)?.[1] ?? '');
      objects.set(field('Key'), { size: Number(field('Size')), etag: field('ETag'), modified: Date.parse(field('LastModified')) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') : undefined;
  } while (token);
  return { objects, date };
}

async function each(items, work, limit = 8) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => { while (queue.length) await work(queue.shift()); }));
}

/** A multipart ETag is not the content's MD5, so a copy cannot match it. */
const sameObject = (source, copy) => source.size === copy.size && (source.etag === copy.etag || source.etag.includes('-'));

async function copyObject(client, from, to, key) {
  const response = await client('GET', from, key), type = response.headers.get('content-type');
  await client('PUT', to, key, { headers: type ? { 'content-type': type } : {}, body: new Uint8Array(await response.arrayBuffer()) });
}

/** Makes an unbound bucket equal to the live one; never called on a bucket the Worker uses. */
async function mirrorBucket(client, from, to) {
  const source = await listBucket(client, from), target = await listBucket(client, to);
  await each([...source.objects].filter(([key, object]) => !target.objects.has(key) || !sameObject(object, target.objects.get(key))).map(([key]) => key), key => copyObject(client, from, to, key));
  await each([...target.objects.keys()].filter(key => !source.objects.has(key)), key => client('DELETE', to, key));
  return source.date;
}

async function verifyBucket(client, from, to, digests) {
  const source = await listBucket(client, from), target = await listBucket(client, to), differ = [];
  for (const [key, object] of source.objects) if (!target.objects.has(key) || !sameObject(object, target.objects.get(key))) differ.push(key);
  for (const key of target.objects.keys()) if (!source.objects.has(key)) differ.push(key);
  await each([...source.objects].filter(([key, object]) => !differ.includes(key) && (digests || object.etag.includes('-'))).map(([key]) => key), async key => {
    const [a, b] = await Promise.all([from, to].map(async bucket => { const response = await client('GET', bucket, key); return response.headers.get('content-type') + ' ' + sha256(new Uint8Array(await response.arrayBuffer())); }));
    if (a !== b) differ.push(key);
  });
  if (differ.length) throw new Stop('R2 bucket ' + to + ' differs from ' + from + ' at ' + differ.slice(0, 3).join(', ') + (differ.length > 3 ? ' and ' + (differ.length - 3) + ' more' : '') + '. The Worker still uses the old data; run the same command again.');
  return source.objects.size;
}

function d1Query(ctx, database, statements) {
  const result = ctx.wrangler(['d1', 'execute', database, '--remote', '--command', statements.join('; '), '--yes', '--json', '--config', ctx.paths.config], true);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch {}
  if (result.status !== 0 || !Array.isArray(parsed) || parsed.length !== statements.length) throw new Stop('Reading D1 database ' + database + ' failed; run the same command again.');
  return parsed.map(entry => entry.results ?? []);
}

async function d1File(ctx, database, sql, action) {
  const path = join(ctx.options.stateDir, 'copy.sql');
  await writePrivate(path, sql);
  try { if (ctx.wrangler(['d1', 'execute', database, '--remote', '--file', path, '--yes', '--config', ctx.paths.config]).status !== 0) throw new Stop(action + ' failed; run the same command again.'); }
  finally { await rm(path, { force: true }); }
}

const literal = value => {
  if (value === null || typeof value === 'string') return value === null ? 'NULL' : quote(value);
  if (Number.isSafeInteger(value)) return String(value);
  throw new Stop('D1 holds a value this copy cannot carry exactly: ' + JSON.stringify(value) + '. Nothing was switched.');
};
const insert = (table, row, orIgnore) => 'INSERT ' + (orIgnore ? 'OR IGNORE ' : '') + 'INTO ' + table + '(' + Object.keys(row).join(',') + ') VALUES(' + Object.values(row).map(literal).join(',') + ');';
const tableDigest = (rows, columns) => sha256(rows.map(row => JSON.stringify(columns.map(column => row[column]))).sort().join('\n'));

/** Rows into an unbound database, emptied first except the append-only table, which keeps what an interrupted copy wrote. */
export function copyStatements(tables, snapshot) {
  return ['PRAGMA defer_foreign_keys=true;', ...tables.toReversed().filter(table => table !== APPEND_ONLY).map(table => 'DELETE FROM ' + table + ';'), ...tables.flatMap(table => snapshot[table].map(row => insert(table, row, table === APPEND_ONLY)))].join('\n');
}

async function copyDatabase(ctx, from, to) {
  const tables = [...ctx.schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) /g)].map(match => match[1]);
  const triggers = [...ctx.schema.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+) /g)].map(match => match[1]);
  // One request reads every table, so the snapshot spans moments, not minutes.
  const [listed, ...rows] = d1Query(ctx, from, ["SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'", ...tables.map(table => 'SELECT * FROM ' + table)]);
  const unknown = listed.map(row => row.name).filter(name => !tables.includes(name));
  if (unknown.length) throw new Stop('D1 database ' + from + ' holds tables schema.sql does not define (' + unknown.join(', ') + '); nothing was switched.');
  const snapshot = Object.fromEntries(tables.map((table, index) => [table, rows[index]]));
  await d1File(ctx, to, copyStatements(tables, snapshot), 'Copying rows into D1 database ' + to);
  const [present, ...copied] = d1Query(ctx, to, ["SELECT name FROM sqlite_master WHERE type='trigger'", ...tables.map(table => 'SELECT * FROM ' + table)]);
  const differ = tables.filter((table, index) => { const columns = Object.keys(snapshot[table][0] ?? {}); return copied[index].length !== snapshot[table].length || tableDigest(copied[index], columns) !== tableDigest(snapshot[table], columns); });
  const missing = triggers.filter(name => !present.some(row => row.name === name));
  if (differ.length || missing.length) throw new Stop('D1 database ' + to + ' does not match ' + from + (differ.length ? ' in ' + differ.join(', ') : '') + (missing.length ? '; it lacks triggers ' + missing.join(', ') : '') + '. The Worker still uses the old data; run the same command again.');
  return tables.map(table => table + ' ' + snapshot[table].length).join(', ');
}

function plan(options, data, to) {
  const from = data.names;
  return [
    'Moving the data of ' + options.domain + ' from ' + (data.location ?? 'where Cloudflare put it') + ' to ' + options.relocate + ':',
    '  1. Create D1 database ' + to.database + ' and R2 buckets ' + to.artifacts + ' and ' + to.objects + ' with location hint ' + options.relocate + '.',
    '  2. Copy every R2 object and every D1 row; the audit table keeps its append-only triggers.',
    '  3. Compare row counts and digests per table, object keys, sizes and ETags, and the SHA-256 of every artifact. A difference stops the move with the Worker unchanged.',
    '  4. Bind the Worker to the new database and buckets, redeploy, and append the audit rows and objects that reached the old ones after the copy.',
    '  D1 database ' + from.database + ' and R2 buckets ' + from.artifacts + ' and ' + from.objects + ' stay until --remove-previous, at least an hour later.',
    'Not made safe automatically:',
    '  - Publish nothing, create, remove, purge or discard no app, and let no ephemeral app expire until the move ends.',
    '  - Accounts, invitations, tokens, sign-ins and request counts that change after step 2 keep their earlier state.',
    '  - URLs signed before step 4 point at the old buckets. Downloads through them work until --remove-previous; an upload through one that the app completes after the switch fails and must be repeated.',
    '  - Redeploying restarts the apps, as any upgrade does. Each app\'s own data stays in its Durable Object and does not move.',
  ];
}

/** Copies and verifies while the Worker still uses the old data, then records the new data as current; never writes to data the Worker uses. */
async function relocate(ctx, data) {
  const { io, options } = ctx, target = options.relocate;
  if (!data) throw new Stop(options.domain + ' has no data yet; finish the install first.');
  if (data.previous) {
    if (!data.previous.switchedAt && data.location === target) return data;
    throw new Stop(data.previous.switchedAt ? 'The data of ' + options.domain + ' moved to ' + data.location + ' and the previous data is kept; remove it with --remove-previous before moving again.' : 'A move to ' + data.location + ' is switching; finish it with --relocate ' + data.location + ' --yes.');
  }
  if (data.relocating && data.relocating.location !== target) throw new Stop('A move to ' + data.relocating.location + ' is unfinished; finish it with --relocate ' + data.relocating.location + ' --yes.');
  if (!data.relocating && data.location === target) throw new Stop('The data of ' + options.domain + ' is already in ' + target + '.');
  const to = movedNames(options.prefix, target);
  if (to.artifacts.length > 63) throw new Stop('R2 bucket names have at most 63 characters, so prefix ' + options.prefix + ' is too long to move its data.');
  for (const line of plan(options, data, to)) io.log(line);
  if (!options.yes) throw new Stop('Nothing was changed. Rerun with --yes to start.');
  if (!data.relocating) {
    const taken = [];
    if (await findDatabase(io, ctx.session, ctx.accountId, to.database)) taken.push(to.database);
    for (const name of [to.artifacts, to.objects]) if (await bucketExists(io, ctx.token, ctx.accountId, name)) taken.push(name);
    if (taken.length) throw new Stop('Already in this account: ' + taken.join(', ') + '. Nothing was changed.');
    data.relocating = { location: target, names: to };
    await saveData(ctx.paths, data);
  }
  const databaseId = await ensureDatabase(io, ctx.session, ctx.accountId, to.database, target);
  await ensureBucket(io, ctx.token, ctx.accountId, to.artifacts, ctx.cors.artifacts, target);
  await ensureBucket(io, ctx.token, ctx.accountId, to.objects, ctx.cors.objects, target);
  if (ctx.wrangler(['d1', 'execute', to.database, '--remote', '--file', join(ctx.cfDir, 'schema.sql'), '--yes', '--config', ctx.paths.config]).status !== 0) throw new Stop('Schema application failed; rerun this command.');
  const astray = Object.entries(await locate(ctx, databaseId, to)).filter(([, location]) => location && location !== target);
  if (astray.length) throw new Stop('Cloudflare put ' + astray.map(([kind, location]) => to[kind] + ' in ' + location).join(' and ') + ', not ' + target + '; location hints are best effort. Nothing was copied and the Worker still uses the data in ' + data.location + '. Delete what was created in the Cloudflare dashboard before trying again.');
  const client = r2Client(ctx), kinds = ['artifacts', 'objects'];
  io.log('Copying R2 objects.');
  for (const kind of kinds) await mirrorBucket(client, data.names[kind], to[kind]);
  io.log('Copying D1 rows.');
  const snapshotAt = io.now(), rows = await copyDatabase(ctx, data.names.database, to.database), syncedAt = {};
  for (const kind of kinds) syncedAt[kind] = await mirrorBucket(client, data.names[kind], to[kind]) || snapshotAt;
  const objects = [];
  for (const kind of kinds) objects.push(kind + ' ' + await verifyBucket(client, data.names[kind], to[kind], kind === 'artifacts'));
  io.log('Verified rows: ' + rows + '. Objects: ' + objects.join(', ') + '.');
  const previous = { location: data.location, names: data.names, databaseId: await findDatabase(io, ctx.session, ctx.accountId, data.names.database), snapshotAt, syncedAt };
  const moved = { location: target, names: to, previous };
  await saveData(ctx.paths, moved);
  return moved;
}

const previousDatabase = async (ctx, previous) => previous.databaseId && await findDatabase(ctx.io, ctx.session, ctx.accountId, previous.names.database) === previous.databaseId;

/** What reached the old data after the copy: audit rows, which are never deleted, and objects R2 stored after the last copy, which the new Worker cannot have deleted. */
async function catchUp(ctx, data) {
  const { previous } = data, since = previous.snapshotAt - CLOCK_MARGIN_MS;
  let rows = [];
  if (await previousDatabase(ctx, previous)) {
    const [late] = d1Query(ctx, previous.names.database, ['SELECT * FROM ' + APPEND_ONLY + ' WHERE at >= ' + since]);
    const [have] = d1Query(ctx, data.names.database, ['SELECT id FROM ' + APPEND_ONLY + ' WHERE at >= ' + since]);
    const known = new Set(have.map(row => row.id));
    rows = late.filter(row => !known.has(row.id));
    if (rows.length) await d1File(ctx, data.names.database, rows.map(row => insert(APPEND_ONLY, row, true)).join('\n'), 'Appending audit rows');
  }
  const client = r2Client(ctx);
  let objects = 0;
  for (const kind of ['artifacts', 'objects']) {
    if (!await bucketExists(ctx.io, ctx.token, ctx.accountId, previous.names[kind])) continue;
    const source = await listBucket(client, previous.names[kind]), target = await listBucket(client, data.names[kind]);
    const keys = [...source.objects].filter(([key, object]) => !target.objects.has(key) && object.modified >= previous.syncedAt[kind] - 1000).map(([key]) => key);
    await each(keys, key => copyObject(client, previous.names[kind], data.names[kind], key));
    objects += keys.length;
  }
  return { rows: rows.length, objects };
}

async function switched(ctx, data) {
  data.previous.switchedAt = ctx.io.now();
  await saveData(ctx.paths, data);
  ctx.io.log('The Worker now uses the data in ' + data.location + '.');
  await ctx.io.sleep(30000);
  const late = await catchUp(ctx, data);
  ctx.io.log('Appended ' + late.rows + ' audit rows and ' + late.objects + ' objects that reached the previous data after the copy.');
}

async function removePrevious(ctx) {
  const { io, options, accountId, session, token } = ctx, data = await readJson(ctx.paths.data), previous = data?.previous;
  if (!previous) throw new Stop('No previous data of ' + options.domain + ' is kept.');
  if (!previous.switchedAt) throw new Stop('The Worker does not use the data in ' + data.location + ' yet; run ' + command(options, '--relocate ' + data.location + ' --yes') + ' first.');
  const ready = previous.switchedAt + SIGNED_URL_MAX_MS;
  if (io.now() < ready) throw new Stop('URLs signed before the switch stay valid until ' + new Date(ready).toISOString() + '; run this again after that. Nothing was removed.');
  const bindings = must(await api(io, token, 'GET', '/accounts/' + accountId + '/workers/scripts/' + options.prefix + '/settings'), 'Worker settings lookup')?.bindings ?? [];
  const old = [previous.databaseId, previous.names.artifacts, previous.names.objects];
  if (!bindings.some(binding => binding.bucket_name === data.names.artifacts) || bindings.some(binding => old.includes(binding.database_id ?? binding.id) || old.includes(binding.bucket_name) || old.includes(binding.text))) throw new Stop('The deployed Worker does not bind the data in ' + data.location + ' alone; rerun ' + command(options, '').trim() + ', then this. Nothing was removed.');
  const late = await catchUp(ctx, data);
  io.log('Appended ' + late.rows + ' audit rows and ' + late.objects + ' objects that reached the previous data since the switch.');
  if (await previousDatabase(ctx, previous)) {
    const [[before], [after]] = [d1Query(ctx, previous.names.database, ['SELECT id FROM ' + APPEND_ONLY]), d1Query(ctx, data.names.database, ['SELECT id FROM ' + APPEND_ONLY])];
    const kept = new Set(after.map(row => row.id)), lost = before.filter(row => !kept.has(row.id)).length;
    if (lost) throw new Stop(lost + ' audit rows of ' + previous.names.database + ' are missing from ' + data.names.database + '. Nothing was removed.');
  }
  const client = r2Client(ctx);
  for (const bucket of [previous.names.artifacts, previous.names.objects]) {
    if (!await bucketExists(io, token, accountId, bucket)) continue;
    const { objects } = await listBucket(client, bucket);
    io.log('Removing R2 bucket ' + bucket + ' and its ' + objects.size + ' objects.');
    await each([...objects.keys()], key => client('DELETE', bucket, key));
    must(await api(io, token, 'DELETE', '/accounts/' + accountId + '/r2/buckets/' + bucket), 'R2 bucket removal');
  }
  if (await previousDatabase(ctx, previous)) {
    io.log('Removing D1 database ' + previous.names.database + '.');
    must(await api(io, session, 'DELETE', '/accounts/' + accountId + '/d1/database/' + previous.databaseId), 'D1 removal');
  }
  delete data.previous;
  await saveData(ctx.paths, data);
  io.log('Removed the previous data of ' + options.domain + ' (' + previous.location + ').');
}

async function report(ctx, data, databaseId, entry) {
  const { io, options } = ctx, places = await locate(ctx, databaseId, data.names);
  const colo = entry?.colo ?? await measureEntry(io, options.domain, 3);
  const measured = colo && { colo, location: ctx.coloLocations[colo] ?? null };
  await saveData(ctx.paths, { ...data, placed: places, entry: measured || null });
  io.log('Data: ' + describe(places) + '. ' + (measured ? 'Requests from this machine enter Cloudflare at ' + colo + (measured.location ? ' (' + measured.location + ')' : '') + ', where the Worker runs.' : 'Where requests from this machine enter Cloudflare could not be measured.'));
  if (measured?.location && Object.values(places).some(location => location && location !== measured.location)) io.log('The data is not where requests enter, so each request crosses to it and back; to move it, run ' + command(options, '--relocate ' + measured.location) + '.');
  if (data.relocating) io.log('A move of the data to ' + data.relocating.location + ' is unfinished; finish it with ' + command(options, '--relocate ' + data.relocating.location + ' --yes') + '.');
  if (data.previous?.switchedAt) io.log('The previous data in ' + data.previous.location + ' is kept; after ' + new Date(data.previous.switchedAt + SIGNED_URL_MAX_MS).toISOString() + ' remove it with ' + command(options, '--remove-previous') + '.');
}

export async function install(options, io = nodeIo, cfDir = CF_DIR) {
  const paths = statePaths(options.stateDir), origin = 'https://' + options.domain;
  if ((options.relocate || options.removePrevious) && !await readOptional(paths.config)) throw new Stop(options.domain + ' is not installed; install it first.');
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await chmod(options.stateDir, 0o700);
  const { accountId, zoneId, session, wrangler } = await preflight(io, options, cfDir);
  const { token, tokenId } = await readToken(io, options, paths, accountId);
  const template = JSON.parse(await readFile(join(cfDir, 'wrangler.jsonc'), 'utf8'));
  const ctx = {
    io, options, cfDir, paths, accountId, zoneId, session, wrangler, token, tokenId, template,
    schema: await readFile(join(cfDir, 'schema.sql'), 'utf8'),
    coloLocations: JSON.parse(await readFile(join(cfDir, 'scripts/colo-locations.json'), 'utf8')),
    cors: { artifacts: artifactCors(JSON.parse(await readFile(join(cfDir, 'deploy/artifact-cors.json'), 'utf8')), origin), objects: JSON.parse(await readFile(join(cfDir, 'deploy/object-cors.json'), 'utf8')) },
  };
  const write = (names, databaseId) => writePrivate(paths.config, JSON.stringify(generateConfig(template, { cfDir, ...options, accountId, databaseId, names }), null, 2) + '\n');
  if (!await claimNames(io, options, paths, accountId, session, token)) await write(undefined, template.d1_databases[0].database_id);
  if (options.removePrevious) return removePrevious(ctx);
  let data = await readJson(paths.data) ?? await adopt(ctx), entry;
  if (options.relocate) data = await relocate(ctx, data);
  else if (!data) ({ data, entry } = await place(ctx));
  else if (options.location && options.location !== data.location) throw new Stop('The data of ' + options.domain + ' is in ' + data.location + '; --location only places new data. To move it, run ' + command(options, '--relocate ' + options.location) + '.');
  const databaseId = await ensureDatabase(io, session, accountId, data.names.database, data.location);
  await write(data.names, databaseId);
  await ensureBucket(io, token, accountId, data.names.artifacts, ctx.cors.artifacts, data.location);
  await ensureBucket(io, token, accountId, data.names.objects, ctx.cors.objects, data.location);
  await upgradeColumns(wrangler, { configPath: paths.config, database: data.names.database, schema: ctx.schema, stateDir: options.stateDir });
  if (wrangler(['d1', 'execute', data.names.database, '--remote', '--file', join(cfDir, 'schema.sql'), '--yes', '--config', paths.config]).status !== 0) throw new Stop('Schema application failed; rerun this command.');
  await writePrivate(paths.secrets, JSON.stringify(workerSecrets(token, tokenId, JSON.parse(await readOptional(paths.secrets) ?? '{}')), null, 2) + '\n');
  const owner = await provisionOwner(wrangler, { configPath: paths.config, database: data.names.database, origin, username: options.owner, credentialsPath: paths.owner });
  let deployed = false;
  for (let attempt = 1; attempt <= DEPLOY_ATTEMPTS && !deployed; attempt++) {
    if (attempt > 1) { io.log('Deploy attempt ' + (attempt - 1) + ' failed; retrying.'); await io.sleep(10000); }
    deployed = wrangler(['deploy', '--config', paths.config, '--secrets-file', paths.secrets]).status === 0;
  }
  if (!deployed) throw new Stop('Deployment failed ' + DEPLOY_ATTEMPTS + ' times; read the Wrangler output above, then run the same command again.');
  if (data.previous && !data.previous.switchedAt) await switched(ctx, data);
  await removeLegacyToken(io, token, accountId, options.prefix);
  await attachDomain(io, token, { accountId, zoneId, hostname: options.domain, service: options.prefix });
  io.log('Waiting for ' + origin + ' to answer over HTTPS.');
  await waitForHealth(io, origin);
  await report(ctx, data, databaseId, entry);
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
