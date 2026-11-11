import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Conflict, ENV_BY_KIND, NotFound, newAppId, type BundleId, type CapabilityKind, type Injection } from './model.ts';
import { PgError } from './pg.ts';
import { createProviders, objectUrl, providerConfig, S3BundleStore, signedFetch } from './providers.ts';
import { Resp, RespError } from './resp.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const project = 'pneuma-space-u6';
const objectPort = 26000;
const stackEnv = {
  ...process.env,
  PNEUMA_SPACE_HTTP_PORT: '26080', PNEUMA_SPACE_ADMIN_PORT: '26081', PNEUMA_SPACE_OBJECT_PORT: String(objectPort), PNEUMA_SPACE_NETWORK: project,
};
const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

const pgPort = 26432;
const redisPort = 26379;
// The gateway reaches postgres and redis on the compose network; this test reaches them through these host ports,
// and coturn needs none, so a second stack's coturn on 3478 does not block it.
const override = join(mkdtempSync(join(tmpdir(), 'pneuma-space-u6-')), 'ports.yaml');
writeFileSync(override, `services:\n  postgres: { ports: ["127.0.0.1:${pgPort}:5432"] }\n  redis: { ports: ["127.0.0.1:${redisPort}:6379"] }\n  coturn: { ports: !reset [] }\n`);
const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-p', project, '-f', 'compose.yaml', '-f', override, '--profile', 'postgres', '--profile', 'rtc', ...args], { cwd: root, env: stackEnv, stdio: 'pipe' });

type ExecResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

function exec(service: string, argv: readonly string[], stdin = ''): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile('docker', ['exec', '-i', `${project}-${service}-1`, ...argv], (error, stdout, stderr) =>
      resolve({ exitCode: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
    child.stdin!.end(stdin);
  });
}

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });
const destroyed: string[] = [];
const storage = { destroyStorage: async (_app: string, id: string) => void destroyed.push(id) };
const defaults = providerConfig({
  PNEUMA_SPACE_OBJECT_ENDPOINT: `http://127.0.0.1:${objectPort}`,
  PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT: `http://127.0.0.1:${objectPort}`,
  PNEUMA_SPACE_RTC_SECRET: 'pneuma-local-rtc',
});
const config = {
  ...defaults,
  postgres: { ...defaults.postgres, host: '127.0.0.1', port: pgPort },
  redis: { ...defaults.redis, host: '127.0.0.1', port: redisPort },
};
const providers = createProviders(storage, config, async () => true);

async function until(probe: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const pgReady = async () => (await exec('postgres', ['pg_isready', '-U', 'postgres'])).exitCode === 0;
const redisReady = async () => (await exec('redis', ['redis-cli'], `AUTH ${config.redis.password}\nPING\n`)).stdout.includes('PONG');

function assertEnvNames(kind: CapabilityKind, injection: Pick<Injection, 'env'>): void {
  assert.deepEqual(Object.keys(injection.env).sort(), [...ENV_BY_KIND[kind]].sort());
}

for (const [name, kind, prefix] of [['volume', 'files', 'pneuma-space-files-'], ['sqlite', 'db', 'pneuma-space-db-']] as const) {
  describe(name, () => {
    const app = newAppId();
    const target = name === 'volume' ? '/data' : '/pneuma/db';

    test('ensure twice records the same storage and inject binds it with {dir} templates', async () => {
      const resource = await providers[name].ensure(app, null);
      assert.deepEqual(await providers[name].ensure(app, resource), resource);
      const [binding, ...rest] = providers[name].inject(app, resource).storage;
      assert.deepEqual([binding.id, binding.target, rest.length], [`${prefix}${app}`, target, 0]);
      assertEnvNames(kind, binding);
      assert.ok(Object.values(binding.env).every((value) => value.includes('{dir}')));
    });

    test('destroy hands the storage id to the runtime', async () => {
      await providers[name].destroy(app, {});
      assert.equal(destroyed.at(-1), `${prefix}${app}`);
    });
  });
}

test('the bundle store answers once a signed request gets anything but a 5xx, and not while nothing answers', async (t) => {
  const statuses = [503, 404];
  const server = createHttpServer((_, res) => void res.writeHead(statuses.shift() ?? 500).end()).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const store = new S3BundleStore({ ...providerConfig({}).object, endpoint: `http://127.0.0.1:${port}` });
  assert.deepEqual([await store.answers(), await store.answers()], [false, true]);
  server.close();
  await once(server, 'close');
  assert.equal(await store.answers(), false);
});

test('the bundle store does not answer when it takes the connection and never replies', async (t) => {
  const server = createHttpServer(() => {}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const store = new S3BundleStore({ ...providerConfig({}).object, endpoint: `http://127.0.0.1:${port}` });
  assert.equal(await store.answers(50), false);
  server.closeAllConnections();
});

test('the bundle store deletes a bundle\'s index before any other of its objects (#13)', async (t) => {
  const requests: string[] = [];
  let listed = false;
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://store');
    requests.push(`${req.method} ${url.pathname}`);
    req.resume().on('end', () => {
      if (req.method !== 'GET') return void res.writeHead(req.method === 'DELETE' ? 204 : 200).end();
      res.writeHead(200).end(listed ? '<ListBucketResult/>' : '<ListBucketResult><Contents><Key>b1/app.js</Key></Contents></ListBucketResult>');
      listed = true;
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  await new S3BundleStore({ ...providerConfig({}).object, endpoint: `http://127.0.0.1:${port}` }).delete('b1' as BundleId);
  assert.deepEqual(requests.filter((r) => !r.startsWith('GET')), ['DELETE /pneuma-space-bundles/b1/_pneuma-space/index.json', 'POST /pneuma-space-bundles']);
});

describe('providers against the real compose services', { skip: !dockerUp && 'Docker is not available' }, () => {
  before(async () => {
    compose('up', '-d', '--wait', 'rustfs', 'redis', 'postgres', 'coturn');
    await until(async () => (await fetch(`http://127.0.0.1:${objectPort}/health`)).ok, 'rustfs');
    await until(pgReady, 'postgres');
    await until(redisReady, 'redis');
  });
  after(() => compose('down', '-v'));

  describe('postgres', () => {
    const pg = providers.postgres;
    const app = newAppId();
    let resource = {};
    const login = (url: string, database?: string) => {
      const { username, password, pathname } = new URL(url);
      return exec('postgres', ['env', `PGPASSWORD=${password}`, 'psql', '-h', '127.0.0.1', '-U', username, '-d', database ?? pathname.slice(1), '-tAc', 'select 1']);
    };
    const count = async (sql: string) => (await exec('postgres', ['psql', '-U', 'postgres', '-tAc', sql])).stdout.trim();
    const url = () => pg.inject(app, resource).env.PNEUMA_SPACE_DB_URL;

    test('ensure twice is one role and one database, and the URL logs in', async () => {
      resource = await pg.ensure(app, null);
      assert.deepEqual(await pg.ensure(app, resource), resource);
      assert.equal(await count(`select count(*) from pg_roles where rolname = 'app_${app}'`), '1');
      assert.equal(await count(`select count(*) from pg_database where datname = 'app_${app}'`), '1');
      assertEnvNames('db', pg.inject(app, resource));
      assert.match(url(), new RegExp(`^postgresql://app_${app}:[0-9a-f]+@postgres:5432/app_${app}$`));
      assert.equal((await login(url())).stdout.trim(), '1');
    });

    test("another app's role cannot connect to the database", async () => {
      const other = newAppId();
      const otherUrl = pg.inject(other, await pg.ensure(other, null)).env.PNEUMA_SPACE_DB_URL;
      const denied = await login(otherUrl, `app_${app}`);
      await pg.destroy(other, {});
      assert.notEqual(denied.exitCode, 0);
      assert.match(denied.stderr, /permission denied for database/);
    });

    test('suspend twice refuses login and ensure restores it', async () => {
      await pg.suspend(app, resource);
      await pg.suspend(app, resource);
      const refused = await login(url());
      assert.notEqual(refused.exitCode, 0);
      assert.match(refused.stderr, /not permitted to log in/);
      assert.deepEqual(await pg.ensure(app, resource), resource);
      assert.equal((await login(url())).stdout.trim(), '1');
    });

    test('a server error rejects with PgError', async () => {
      const wrong = createProviders(storage, { ...config, postgres: { ...config.postgres, password: 'wrong' } }, async () => true).postgres;
      await assert.rejects(wrong.ensure(newAppId(), null), PgError);
    });

    test('destroy twice removes database and role', async () => {
      await pg.destroy(app, resource);
      await pg.destroy(app, resource);
      assert.equal(await count(`select count(*) from pg_database where datname = 'app_${app}'`), '0');
      assert.equal(await count(`select count(*) from pg_roles where rolname = 'app_${app}'`), '0');
    });
  });

  describe('redis', () => {
    const kv = providers.redis;
    const app = newAppId();
    let resource: Record<string, string> = {};
    const asApp = async (...commands: string[]) =>
      (await exec('redis', ['redis-cli'], [`AUTH ${resource.user} ${resource.password}`, ...commands, ''].join('\n'))).stdout;
    const asRoot = async (...commands: string[]) =>
      (await exec('redis', ['redis-cli'], [`AUTH ${config.redis.password}`, ...commands, ''].join('\n'))).stdout;

    test('ensure twice is one ACL user with the prefix', async () => {
      resource = { ...(await kv.ensure(app, null)) };
      assert.deepEqual(await kv.ensure(app, resource), resource);
      assert.equal((await asRoot('ACL LIST')).split('\n').filter((line) => line.startsWith(`user app_${app} `)).length, 1);
      const { env } = kv.inject(app, resource);
      assertEnvNames('kv', kv.inject(app, resource));
      assert.equal(env.PNEUMA_SPACE_KV_PREFIX, `${app}:`);
      assert.equal(env.PNEUMA_SPACE_KV_URL, `redis://app_${app}:${resource.password}@redis:6379`);
    });

    test('a key inside the prefix works and one outside fails with NOPERM', async () => {
      assert.deepEqual((await asApp(`SET ${app}:k v`, `GET ${app}:k`, 'SET other:k v')).split('\n').slice(0, 4),
        ['OK', 'OK', 'v', 'NOPERM No permissions to access a key']);
    });

    test('publish and subscribe work inside the prefix and fail outside', async () => {
      const subscriber = exec('redis', ['sh', '-c',
        `timeout 3 redis-cli --no-auth-warning --user app_${app} --pass ${resource.password} SUBSCRIBE ${app}:chan; true`]);
      await until(async () => (await asApp(`PUBLISH ${app}:chan hello`)).split('\n')[1] === '1', 'subscriber');
      assert.match((await subscriber).stdout, /hello/);
      assert.match(await asApp('PUBLISH other:chan hello'), /NOPERM/);
    });

    test('the ACL user and its keys survive docker compose restart redis', async () => {
      compose('restart', 'redis');
      await until(redisReady, 'redis after restart');
      assert.deepEqual((await asApp(`GET ${app}:k`)).split('\n').slice(0, 2), ['OK', 'v']);
    });

    test('suspend twice fails AUTH and ensure restores it', async () => {
      await kv.suspend(app, resource);
      await kv.suspend(app, resource);
      assert.match(await asApp('PING'), /^WRONGPASS/);
      await kv.ensure(app, resource);
      assert.deepEqual((await asApp('PING')).split('\n').slice(0, 2), ['OK', 'PONG']);
    });

    test('an error reply rejects with RespError', async () => {
      const resp = await Resp.open({ host: '127.0.0.1', port: redisPort, password: config.redis.password });
      await assert.rejects(resp.command('ACL', 'SETUSER', app, 'nosuchrule'), RespError);
      await resp.close();
    });

    test('destroy twice removes the prefix keys and the user, nothing else', async () => {
      await asRoot('SET unrelated:k keep');
      await kv.destroy(app, resource);
      await kv.destroy(app, resource);
      assert.deepEqual((await asRoot(`EXISTS ${app}:k`, 'GET unrelated:k')).split('\n').slice(0, 3), ['OK', '0', 'keep']);
      assert.doesNotMatch(await asRoot('ACL LIST'), new RegExp(`app_${app}`));
    });
  });

  describe('s3', () => {
    const s3 = providers.s3;
    const app = newAppId();
    const other = newAppId();
    let resource: Record<string, string> = {};
    const key = () => ({ accessKey: resource.accessKey, secretKey: resource.secretKey });
    const url = (bucket: string, path = '', query = '') => objectUrl(config.object, bucket, path, query);
    const anon = (path: string, headers: Record<string, string> = {}) => fetch(url(resource.bucket, path), { headers });

    test('ensure twice is one bucket and key; the key reads and writes its bucket', async () => {
      resource = { ...(await s3.ensure(app, null)) };
      assert.deepEqual(await s3.ensure(app, resource), resource);
      assertEnvNames('object', s3.inject(app, resource));
      assert.equal(s3.inject(app, resource).env.PNEUMA_SPACE_OBJECT_BUCKET, `app-${app}`);
      assert.equal((await signedFetch(key(), 'PUT', url(resource.bucket, 'private/a.txt'), 'secret')).status, 200);
      assert.equal(await (await signedFetch(key(), 'GET', url(resource.bucket, 'private/a.txt'))).text(), 'secret');
      assert.equal((await signedFetch(key(), 'PUT', url(resource.bucket, 'public/clip.bin'), 'clip')).status, 200);
    });

    test("the key cannot list or read another app's bucket", async () => {
      const theirs = await s3.ensure(other, null);
      await signedFetch(config.object.root, 'PUT', url(theirs.bucket, 'private/b.txt'), 'theirs');
      assert.equal((await signedFetch(key(), 'GET', url(theirs.bucket, '', '?list-type=2'))).status, 403);
      assert.equal((await signedFetch(key(), 'GET', url(theirs.bucket, 'private/b.txt'))).status, 403);
      await s3.destroy(other, theirs);
    });

    test('CORS lets any origin PUT', async () => {
      const preflight = await fetch(url(resource.bucket, 'public/x'), {
        method: 'OPTIONS',
        headers: { origin: 'http://127.0.0.1:8080', 'access-control-request-method': 'PUT' },
      });
      assert.ok(['*', 'http://127.0.0.1:8080'].includes(preflight.headers.get('access-control-allow-origin') ?? ''));
      assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PUT/);
    });

    test('suspend twice disables the key and public read; ensure restores both', async () => {
      await s3.suspend(app, resource);
      await s3.suspend(app, resource);
      const denied = await signedFetch(key(), 'GET', url(resource.bucket, 'private/a.txt'));
      const refusal = await denied.text();
      assert.ok([400, 403].includes(denied.status), `${denied.status} ${refusal}`);
      assert.match(refusal, /<Code>(ErrAccessKeyDisabled|AccessDenied|InvalidAccessKeyId)<\/Code>/);
      assert.equal((await anon('public/clip.bin')).status, 403);
      await s3.ensure(app, resource);
      assert.equal((await signedFetch(key(), 'GET', url(resource.bucket, 'private/a.txt'))).status, 200);
      assert.equal((await anon('public/clip.bin', { range: 'bytes=0-0' })).status, 206);
    });

    test('destroy twice removes bytes, bucket and key', async () => {
      await s3.destroy(app, resource);
      await s3.destroy(app, resource);
      assert.equal((await signedFetch(config.object.root, 'HEAD', url(resource.bucket))).status, 404);
      assert.equal((await anon('public/clip.bin')).status, 403);
      const user = await signedFetch(config.object.root, 'GET', new URL(`${config.object.endpoint}/minio/admin/v3/user-info?accessKey=${resource.accessKey}`));
      assert.equal(user.status, 404);
    });
  });

  describe('coturn', () => {
    const rtc = providers.coturn;
    const app = newAppId();

    test('ensure twice is no resource and inject has the three variables', async () => {
      assert.deepEqual(await rtc.ensure(app, null), {});
      assert.deepEqual(await rtc.ensure(app, {}), {});
      assert.deepEqual(rtc.inject(app, {}).env, {
        PNEUMA_SPACE_RTC_STUN_URLS: 'stun:127.0.0.1:3478',
        PNEUMA_SPACE_RTC_TURN_URLS: 'turn:127.0.0.1:3478?transport=udp',
        PNEUMA_SPACE_RTC_TURN_SECRET: 'pneuma-local-rtc',
      });
    });

    test('ensure refuses an empty secret', async () => {
      const unset = createProviders(storage, providerConfig({}), async () => true).coturn;
      await assert.rejects(unset.ensure(app, null), Conflict);
    });

    test('coturn accepts a credential minted from the injected secret', async () => {
      const username = `${Math.floor(Date.now() / 1000) + 600}:alice`;
      const credential = createHmac('sha1', rtc.inject(app, {}).env.PNEUMA_SPACE_RTC_TURN_SECRET).update(username).digest('base64');
      const run = await exec('coturn', ['sh', '-c', `turnutils_uclient -y -n 5 -m 1 -u '${username}' -w '${credential}' $(hostname -i)`]);
      assert.equal(run.exitCode, 0, run.stderr);
      assert.match(run.stdout, /Total lost packets 0/);
    });
  });

  describe('bundles', () => {
    const bundles = new S3BundleStore(config.object);
    const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-bundle-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>hi</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const pack = () => execFileSync('tar', ['-cf', '-', '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const tar = pack();
    let id = '' as BundleId;

    test('put stores every file with its content type, and the same tar twice gives the same id', async () => {
      id = await bundles.put(Readable.from([tar]));
      assert.equal(await bundles.put(Readable.from([tar])), id);
      assert.equal(id, createHash('sha256').update(tar).digest('hex'));
      const { files } = await new S3BundleStore(config.object).index(id);
      assert.deepEqual(Object.fromEntries(Object.entries(files).map(([path, file]) => [path, [file.size, file.contentType]])), {
        'index.html': [32, 'text/html; charset=utf-8'],
        'app.js': [14, 'text/javascript; charset=utf-8'],
        'assets/logo.svg': [41, 'image/svg+xml'],
      });
    });

    test('open with a range returns that slice', async () => {
      const chunks = await (await bundles.open(id, 'index.html', { start: 2, end: 8 })).toArray();
      assert.equal(Buffer.concat(chunks).toString(), 'doctype');
    });

    test('delete empties that bundle and keeps the others', async () => {
      writeFileSync(join(dir, 'app.js'), 'console.log(2)');
      const stale = await bundles.put(Readable.from([pack()]));
      await bundles.delete(stale);
      const list = await signedFetch(config.object.root, 'GET', objectUrl(config.object, 'pneuma-space-bundles', '', `?list-type=2&prefix=${stale}/`));
      assert.doesNotMatch(await list.text(), /<Key>/);
      assert.equal((await bundles.index(id)).id, id);
    });

    test('index answers NotFound once another store deleted a bundle this one had read (#13)', async () => {
      writeFileSync(join(dir, 'app.js'), 'console.log(3)');
      const gone = await bundles.put(Readable.from([pack()]));
      await bundles.index(gone);
      await new S3BundleStore(config.object).delete(gone);
      await assert.rejects(bundles.index(gone), NotFound);
    });
  });

  describe('profile detection on the compose network', () => {
    const probe = () => {
      const script = `
        import { createProviders, providerConfig } from '/src/providers.ts';
        const p = createProviders({ destroyStorage: async () => {} }, providerConfig({ PNEUMA_SPACE_RTC_SECRET: 's' }));
        for (const name of ['postgres', 'coturn']) {
          const t = Date.now();
          const outcome = await p[name].ensure('${newAppId()}', null).then(() => 'up', (e) => e.constructor.name);
          console.log(name, outcome, Date.now() - t);
        }`;
      return docker('run', '--rm', '--network', project, '-v', `${join(root, 'gateway/src')}:/src:ro`, 'node:24-alpine',
        'node', '--input-type=module', '-e', script).trim().split('\n').map((line) => line.split(' '));
    };

    test('ensure finds postgres and coturn when their profiles are up', () => {
      assert.deepEqual(probe().map(([name, outcome]) => [name, outcome]), [['postgres', 'up'], ['coturn', 'up']]);
    });

    test('ensure throws Conflict within 1.5 s when their profiles are down', () => {
      compose('rm', '-sf', 'postgres', 'coturn');
      for (const [name, outcome, ms] of probe()) {
        assert.equal(outcome, 'Conflict', name);
        assert.ok(Number(ms) < 1500, `${name} took ${ms} ms`);
      }
    });
  });
});
