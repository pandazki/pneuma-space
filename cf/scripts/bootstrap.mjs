import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const username = process.argv[2], destination = process.argv[3];
if (!username || !/^[a-z][a-z0-9_-]{2,31}$/.test(username) || !destination) {
  throw new Error('Usage: node scripts/bootstrap.mjs USERNAME PRIVATE_CREDENTIALS_FILE');
}
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const path = resolve(destination);
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
let credential;
try { credential = JSON.parse(await readFile(path, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  credential = { origin: config.vars.PNEUMA_SPACE_CONTROL_ORIGIN, account: username, key: randomBytes(32).toString('hex'), userId: 'u_' + randomBytes(16).toString('hex'), tenantId: 't_' + randomBytes(16).toString('hex') };
  await writeFile(path, JSON.stringify(credential, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
await chmod(path, 0o600);
if (credential.account !== username || credential.origin !== config.vars.PNEUMA_SPACE_CONTROL_ORIGIN) throw new Error('Credential file belongs to a different account or service.');
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const keyHash = createHash('sha256').update(credential.key).digest('hex');
const sql = [
  'INSERT OR IGNORE INTO users(id,username,name,key_hash,platform_admin,created_at) VALUES(' + [credential.userId, username, username, keyHash, 1, Date.now()].map(quote).join(',') + ');',
  'INSERT OR IGNORE INTO tenants(id,name,created_at) VALUES(' + [credential.tenantId, username + "'s space", Date.now()].map(quote).join(',') + ');',
  "INSERT OR IGNORE INTO memberships(tenant_id,user_id,role) SELECT " + quote(credential.tenantId) + ',' + quote(credential.userId) + ",'admin' WHERE EXISTS(SELECT 1 FROM users WHERE id=" + quote(credential.userId) + ' AND key_hash=' + quote(keyHash) + ');',
].join('\n');
const sqlPath = path + '.sql';
await writeFile(sqlPath, sql, { mode: 0o600 });
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', config.d1_databases[0].database_name, '--remote', '--file', sqlPath, '--yes'], { cwd: new URL('..', import.meta.url), stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const query = 'SELECT count(*) AS owners FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=' + quote(credential.userId) + ' AND u.username=' + quote(username) + ' AND u.key_hash=' + quote(keyHash) + ' AND u.platform_admin=1 AND u.disabled=0 AND m.tenant_id=' + quote(credential.tenantId) + " AND m.role='admin';";
const verified = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', config.d1_databases[0].database_name, '--remote', '--command', query, '--yes', '--json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
if (verified.status !== 0 || !JSON.parse(verified.stdout).some(result => result.results?.some(row => row.owners === 1))) throw new Error('Owner verification failed. An existing account may use a different credential; no existing key was replaced.');
console.log('Owner provisioned. Private credentials saved to ' + path);
