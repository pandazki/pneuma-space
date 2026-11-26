import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error The installer is a plain Node script.
import { statePaths } from '../scripts/install.mjs';

export const account = 'account-example', token = 'example-api-token';
type StoredObject = { body: Uint8Array, type: string, etag: string, modified: number };
type Options = {
  scripts?: string[], buckets?: string[], databases?: { name: string, uuid: string }[], domains?: { hostname: string, service: string }[], secrets?: string[], deploys?: number[],
  /** Where requests for the control domain enter; null when they never arrive. */
  colo?: string | null,
  /** SQL a database runs when it is created. */
  seed?: Record<string, string>,
  /** Where Cloudflare puts a resource whatever the hint. */
  placed?: Record<string, string>,
  /** Keys per listing page. */
  page?: number,
  /** Returns true to fail a `d1 execute --file` after doing what it likes to the database. */
  failFile?: (sql: string, db: DatabaseSync) => boolean,
  /** A key whose bytes R2 alters on upload. */
  corrupt?: string,
  /** REST calls, as `METHOD path`, that fail the first time. */
  refuseOnce?: string[],
  onDeploy?: () => void,
};

/** A Cloudflare account: REST API, R2's S3 API, D1 through Wrangler on real SQLite, and the control domain. */
export function cloudflare({ scripts = [], buckets = [], databases = [], domains = [], secrets = [], deploys = [0], colo = 'SJC', seed = {}, placed = {}, page = 1000, failFile, corrupt, refuseOnce = [], onDeploy }: Options = {}) {
  const calls: string[] = [], logs: string[] = [], upgrades: string[] = [];
  const d1 = new Map<string, { uuid: string, location: string, db: DatabaseSync }>(), r2 = new Map<string, { location: string, objects: Map<string, StoredObject> }>();
  let offset = 0, bindings: Record<string, string>[] = [];
  const now = () => Date.now() + offset;
  const createDatabase = (name: string, hint?: string, uuid = 'database-' + name) => {
    const db = new DatabaseSync(':memory:');
    if (seed[name]) db.exec(seed[name]);
    d1.set(name, { uuid, location: placed[name] ?? hint ?? 'apac', db });
  };
  for (const { name, uuid } of databases) createDatabase(name, undefined, uuid);
  for (const name of buckets) r2.set(name, { location: 'apac', objects: new Map() });
  const reply = (result: unknown, status = 200) => Response.json({ success: status < 400, result, errors: status < 400 ? [] : [{ message: 'refused' }] }, { status });
  const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

  const s3 = (pathname: string, searchParams: URLSearchParams, method: string, init: RequestInit) => {
    if (!new Headers(init.headers).get('authorization')?.startsWith('AWS4-HMAC-SHA256 Credential=token-id/')) return new Response('denied', { status: 403 });
    const [name, ...segments] = pathname.slice(1).split('/'), key = segments.map(decodeURIComponent).join('/'), bucket = r2.get(name);
    if (!bucket) return new Response('NoSuchBucket', { status: 404 });
    if (method === 'GET' && !segments.length) {
      const keys = [...bucket.objects.keys()].sort(), start = Number(searchParams.get('continuation-token') ?? 0), shown = keys.slice(start, start + page);
      const contents = shown.map(item => { const object = bucket.objects.get(item)!; return '<Contents><Key>' + escape(item) + '</Key><LastModified>' + new Date(object.modified).toISOString() + '</LastModified><ETag>&quot;' + object.etag + '&quot;</ETag><Size>' + object.body.length + '</Size></Contents>'; }).join('');
      const more = start + page < keys.length;
      return new Response('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>' + name + '</Name><IsTruncated>' + more + '</IsTruncated>' + contents + (more ? '<NextContinuationToken>' + (start + page) + '</NextContinuationToken>' : '') + '</ListBucketResult>', { headers: { date: new Date(now()).toUTCString() } });
    }
    const object = bucket.objects.get(key);
    if (method === 'GET') return object ? new Response(object.body.slice(), { headers: { 'content-type': object.type, etag: '"' + object.etag + '"' } }) : new Response('NoSuchKey', { status: 404 });
    if (method === 'PUT') {
      const body = new Uint8Array(init.body as Uint8Array);
      if (key === corrupt && body.length) body[0] ^= 1;
      put(name, key, body, new Headers(init.headers).get('content-type') ?? 'application/octet-stream');
      return new Response(null);
    }
    if (method === 'DELETE') { bucket.objects.delete(key); return new Response(null, { status: 204 }); }
    throw new Error('unexpected S3 ' + method + ' ' + pathname);
  };

  const fetch = async (url: string, init: RequestInit = {}) => {
    const { hostname, pathname, searchParams } = new URL(url), method = init.method ?? 'GET', path = pathname.replace('/client/v4', '');
    if (hostname === account + '.r2.cloudflarestorage.com') return s3(pathname, searchParams, method, init);
    if (path === '/_pneuma-space/health') return Response.json({ service: 'pneuma-space-cf' });
    if (path === '/cdn-cgi/trace') { if (!colo) throw new TypeError('fetch failed'); return new Response('h=space.example.com\ncolo=' + colo + '\nloc=JP\n'); }
    calls.push(method + ' ' + path);
    if (refuseOnce.includes(method + ' ' + path)) { refuseOnce.splice(refuseOnce.indexOf(method + ' ' + path), 1); return reply(null, 500); }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined, base = '/accounts/' + account;
    if (path === '/zones') return reply(searchParams.get('name') === 'example.com' ? [{ id: 'zone-example', name: 'example.com' }] : []);
    if (path === base + '/tokens/verify') return reply({ id: 'token-id', status: 'active', expires_on: '2027-01-01T00:00:00Z' });
    if (path === base + '/workers/scripts') return reply(scripts.map(id => ({ id })));
    if (path === base + '/d1/database' && method === 'GET') return reply([...d1].map(([name, { uuid }]) => ({ name, uuid })));
    if (path === base + '/d1/database') { createDatabase(body.name, body.primary_location_hint); return reply({ name: body.name, uuid: d1.get(body.name)!.uuid }); }
    const database = /^\/accounts\/[^/]+\/d1\/database\/([^/]+)$/.exec(path), named = [...d1].find(([, entry]) => entry.uuid === database?.[1]);
    if (database && !named) return reply(null, 404);
    if (database && method === 'DELETE') { d1.delete(named![0]); return reply({}); }
    if (database) return reply({ uuid: named![1].uuid, name: named![0], running_in_region: named![1].location.toUpperCase() });
    const bucket = /^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)(\/cors)?$/.exec(path), stored = bucket && r2.get(bucket[1]);
    if (bucket && !stored) return reply(null, 404);
    if (bucket?.[2]) return reply({});
    if (bucket && method === 'DELETE') { if (stored!.objects.size) return reply(null, 409); r2.delete(bucket[1]); return reply({}); }
    if (bucket) return reply({ name: bucket[1], location: stored!.location.toUpperCase() });
    if (path === base + '/r2/buckets') { r2.set(body.name, { location: placed[body.name] ?? body.locationHint ?? 'apac', objects: new Map() }); return reply({}); }
    if (path === base + '/workers/scripts/space-test/secrets') return reply(secrets.map(name => ({ name, type: 'secret_text' })));
    if (path.startsWith(base + '/workers/scripts/space-test/secrets/') && method === 'DELETE') return reply(null);
    if (path === base + '/workers/scripts/space-test/settings') return reply({ bindings });
    if (path === base + '/workers/domains' && method === 'GET') return reply(domains);
    if (path === base + '/workers/domains') { domains.push(body); return reply(body); }
    throw new Error('unexpected ' + method + ' ' + path);
  };

  const run = (command: string, args: string[]) => {
    if (command === 'docker') return { status: 0, stdout: '' };
    const [verb, sub, name] = args.slice(1), option = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : '';
    if (verb === 'whoami') return { status: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: account, name: 'Example' }] }) };
    if (verb === 'auth') return { status: 0, stdout: JSON.stringify({ type: 'oauth', token: 'session' }) };
    if (verb === 'deploy' && option('--config').endsWith('probe.json')) { calls.push('wrangler deploy probe'); return { status: 0, stdout: '' }; }
    if (verb === 'deploy') {
      calls.push('wrangler deploy');
      const status = deploys.shift() ?? 0;
      if (status) return { status, stdout: '' };
      const config = JSON.parse(readFileSync(option('--config'), 'utf8'));
      bindings = [{ type: 'd1', name: config.d1_databases[0].binding, database_id: config.d1_databases[0].database_id }, ...config.r2_buckets.map((entry: Record<string, string>) => ({ type: 'r2_bucket', name: entry.binding, bucket_name: entry.bucket_name })), ...Object.entries(config.vars as Record<string, string>).map(([key, text]) => ({ type: 'plain_text', name: key, text }))];
      onDeploy?.();
      return { status: 0, stdout: '' };
    }
    calls.push('wrangler ' + verb + ' ' + sub);
    const db = d1.get(name)?.db;
    if (!db) return { status: 1, stdout: '' };
    if (option('--file')) {
      const sql = readFileSync(option('--file'), 'utf8');
      if (option('--file').endsWith('upgrade.sql')) upgrades.push(sql);
      if (failFile?.(sql, db)) return { status: 1, stdout: '' };
      try { db.exec('BEGIN'); db.exec(sql); db.exec('COMMIT'); }
      catch { db.exec('ROLLBACK'); return { status: 1, stdout: '' }; }
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: JSON.stringify(option('--command').split(/;\s*/).filter(Boolean).map(statement => ({ results: db.prepare(statement).all(), success: true }))) };
  };

  const put = (bucket: string, key: string, body: Uint8Array, type: string) => r2.get(bucket)!.objects.set(key, { body, type, etag: createHash('md5').update(body).digest('hex'), modified: now() });
  return {
    calls, logs, upgrades, d1, r2, put,
    sql: (database: string) => d1.get(database)!.db,
    bindings: () => bindings,
    advance: (ms: number) => { offset += ms; },
    io: { fetch, run, sleep: async () => {}, log: (line: string) => logs.push(line), now },
  };
}

export async function host(saveToken = true, extra: Record<string, unknown> = {}) {
  const stateDir = join(await mkdtemp(join(tmpdir(), 'pneuma-space-install-')), 'space.example.com');
  const options = { domain: 'space.example.com', prefix: 'space-test', stateDir, ...extra };
  if (saveToken) { await mkdir(stateDir); await writeFile(statePaths(stateDir).token, token + '\n'); }
  return { options, stateDir, done: () => rm(join(stateDir, '..'), { recursive: true, force: true }) };
}

export const writes = (calls: string[]) => calls.filter(call => /^(POST|PUT|DELETE) |^wrangler (d1|deploy)/.test(call));
