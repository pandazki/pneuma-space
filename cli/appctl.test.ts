import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const FAKE_IMAGE = `sha256:${'ab'.repeat(32)}`;

type Recorded = { method: string; url: string; body: Buffer };
let requests: Recorded[] = [];
let server: Server;
let admin: string;

const AUDIT_ROWS = [
  { id: 2, at: Date.UTC(2026, 10, 9, 1), actor: 'user:alice', actorTenant: 'lab', tenant: 'lab', action: 'app.purge', targetKind: 'app', target: 'survey', result: 'ok', details: {} },
  { id: 1, at: Date.UTC(2026, 10, 9, 0), actor: 'user:alice', actorTenant: 'lab', tenant: 'lab', action: 'app.purge', targetKind: 'app', target: 'survey', result: 'started', details: {} },
];

function reply(request: Recorded): unknown {
  if (request.url.startsWith('/api/audit')) return AUDIT_ROWS;
  if (request.url === '/api/bundles') return { bundle: createHash('sha256').update(request.body).digest('hex') };
  if (request.url.endsWith('/release')) return { app: 'a1b2c3', number: 1 };
  if (request.url === '/api/tokens') return { token: 'one-time-secret-42', subject: 'service:ci' };
  return JSON.parse(request.body.toString() || 'null');
}

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const recorded = { method: req.method!, url: req.url!, body: Buffer.concat(chunks) };
    requests.push(recorded);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply(recorded)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  admin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => (requests = []));

function stub(tools: Record<string, string>): string {
  const bin = mkdtempSync(join(tmpdir(), 'appctl-bin-'));
  for (const [tool, script] of Object.entries(tools)) {
    writeFileSync(join(bin, tool), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  return bin;
}
const stubDocker = (script: string) => stub({ docker: script });
const dockerMustNotRun = stubDocker('echo "docker must not be invoked: $*" >&2; exit 99');

function appctl(args: string[], { bin = dockerMustNotRun, cli = join(repo, 'cli/appctl.ts') } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const { PNEUMA_SPACE_OWNER: _, ...inherited } = process.env;
    const env = { ...inherited, PNEUMA_SPACE_ADMIN: admin, PATH: `${bin}:${process.env.PATH}` };
    execFile(process.execPath, [cli, ...args], { env }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr }));
  });
}

function source(manifest: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'appctl-src-'));
  writeFileSync(join(dir, 'pneuma-space.json'), JSON.stringify(manifest));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const json = (r: Recorded) => JSON.parse(r.body.toString());

test('static-only publish uploads a reproducible tar of static.dir and releases it with no image, without docker', async () => {
  const dir = source({ contract: 1, capabilities: { static: { dir: 'dist' } } }, {
    'dist/index.html': '<h1>hi</h1>',
    'dist/assets/app.js': 'console.log(1)',
    'README.md': 'not bundled',
  });
  const first = await appctl(['publish', 'site', dir, '--owner', 'user:ann']);
  assert.equal(first.code, 0, first.stderr);
  const [upload, release] = requests;
  assert.deepEqual([upload.method, upload.url, release.method, release.url], ['POST', '/api/bundles', 'PUT', '/api/apps/site/release']);
  const bundle = createHash('sha256').update(upload.body).digest('hex');
  assert.deepEqual(json(release), {
    image: null, manifest: { contract: 1, capabilities: { static: { dir: 'dist' } } }, bundle, owner: 'user:ann',
  });
  const tarFile = join(mkdtempSync(join(tmpdir(), 'appctl-tar-')), 'b.tar');
  writeFileSync(tarFile, upload.body);
  assert.deepEqual(execFileSync('tar', ['-tf', tarFile], { encoding: 'utf8' }).trim().split('\n'), ['assets/app.js', 'index.html']);

  utimesSync(join(dir, 'dist/index.html'), new Date(2001, 1, 1), new Date(2001, 1, 1));
  requests = [];
  assert.equal((await appctl(['publish', 'site', dir])).code, 0);
  assert.equal(createHash('sha256').update(requests[0].body).digest('hex'), bundle, 'same tree, same bundle id');
});

test('publish of a dir that declares db builds the image and releases the built id', async () => {
  const dir = source({ contract: 1, capabilities: { db: {} } }, { Dockerfile: 'FROM scratch' });
  const log = join(dir, 'docker-args');
  const bin = stubDocker(`echo "$*" > ${log}; echo ${FAKE_IMAGE}`);
  const result = await appctl(['publish', 'board', dir, '--tag', 'v1'], { bin });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(log, 'utf8').trim(), `build -q -t pneuma-space-app/board:v1 ${dir}`);
  assert.deepEqual(requests.map((r) => r.url), ['/api/apps/board/release']);
  assert.deepEqual(json(requests[0]), { image: FAKE_IMAGE, manifest: { contract: 1, capabilities: { db: {} } }, bundle: null });
  assert.match(result.stdout, /board\s+\/apps\/board\/\s+release 1/);
});

test('a bad manifest exits 2 with the gateway message before any request', async () => {
  const dir = source({ contract: 1, capabilities: { route: {} } });
  const result = await appctl(['publish', 'bad', dir]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /route is implicit/);
  assert.deepEqual(requests, []);
});

test('policy without a name sets global fields, numbers as numbers', async () => {
  const result = await appctl(['policy', 'idle_seconds=5', 'db_backend=postgres', 'timezone=Asia/Shanghai']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.map((r) => [r.method, r.url, json(r)]), [
    ['PUT', '/api/policy', { idle_seconds: 5, db_backend: 'postgres', timezone: 'Asia/Shanghai' }],
  ]);
});

test('policy with a name sets that app\'s overrides, null clears one', async () => {
  const result = await appctl(['policy', 'board', 'idle_seconds=3', 'drain_timeout_seconds=null']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.map((r) => [r.method, r.url, json(r)]), [
    ['PUT', '/api/apps/board/policy', { idle_seconds: 3, drain_timeout_seconds: null }],
  ]);
});

test('token create prints the one-time secret exactly once', async () => {
  const result = await appctl(['token', 'create', 'ci']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(json(requests[0]), { name: 'ci' });
  assert.equal((result.stdout + result.stderr).split('one-time-secret-42').length - 1, 1);
});

test('init copies the template next to the CLI into a new dir and refuses a non-empty one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'appctl-repo-'));
  cpSync(join(repo, 'cli/appctl.ts'), join(root, 'cli/appctl.ts'));
  cpSync(join(repo, 'cli/scaffold.ts'), join(root, 'cli/scaffold.ts'));
  cpSync(join(repo, 'gateway/src/model.ts'), join(root, 'gateway/src/model.ts'));
  mkdirSync(join(root, 'templates/static'), { recursive: true });
  writeFileSync(join(root, 'templates/static/pneuma-space.json'), '{"contract":1}');
  const target = join(root, 'out', 'site');
  const cli = join(root, 'cli/appctl.ts');

  assert.equal((await appctl(['init', target, '--static'], { cli })).code, 0);
  assert.equal(readFileSync(join(target, 'pneuma-space.json'), 'utf8'), '{"contract":1}');
  const again = await appctl(['init', target, '--static'], { cli });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /not empty/);
  assert.ok(existsSync(join(target, 'pneuma-space.json')));
});

const tarList = (body: Buffer) => {
  const file = join(mkdtempSync(join(tmpdir(), 'appctl-tar-')), 'b.tar');
  writeFileSync(file, body);
  return execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).trim().split('\n');
};

const scaffoldManifest = JSON.parse(readFileSync(join(repo, 'templates/app/pneuma-space.json'), 'utf8'));

describe('publish of an isolate dir', () => {
  let tar: string[];
  let npmArgs: string;
  let release: Recorded;
  let bundle: string;
  before(async () => {
    const dir = source(scaffoldManifest, {
      'package.json': '{"dependencies": {"dep": "1.0.0"}}',
      'package-lock.json': '{}',
      'src/server.ts': 'export {}',
      'src/server.test.ts': 'not shipped',
      'public/ui.css': 'body {}',
      'node_modules/stale/index.js': 'not shipped',
      'data/app.sqlite3': 'not shipped',
      '.git/HEAD': 'not shipped',
      '.audit/trail.tsv': 'not shipped',
      '.env': 'SECRET=1',
      '.env.local': 'SECRET=2',
      '.npmrc': '//registry/:_authToken=x',
    });
    const outside = source({});
    symlinkSync(join(outside, 'pneuma-space.json'), join(dir, 'src/outside.json'));
    symlinkSync('../missing', join(dir, 'src/dangling'));
    symlinkSync('../public/ui.css', join(dir, 'src/ui.css'));
    symlinkSync('../data', join(dir, 'public/uploads'));
    symlinkSync('../.env', join(dir, 'src/config'));
    const log = join(outside, 'npm-args');
    const bin = stub({
      docker: 'exit 99',
      npm: `echo "$*" > ${log}; mkdir -p node_modules/dep && echo x > node_modules/dep/index.js && ln -s ${outside} node_modules/linked`,
    });
    const result = await appctl(['publish', 'notes', dir, '--owner', 'user:ann'], { bin });
    assert.equal(result.code, 0, result.stderr);
    const [upload] = requests;
    release = requests[1];
    tar = tarList(upload.body);
    bundle = createHash('sha256').update(upload.body).digest('hex');
    npmArgs = readFileSync(log, 'utf8').trim();
  });

  test('installs production dependencies without their scripts', () => {
    assert.equal(npmArgs, 'ci --omit=dev --ignore-scripts');
  });

  test('ships no local state, secrets, tests or stale node_modules', () => {
    const excluded = ['data/app.sqlite3', '.git/HEAD', '.audit/trail.tsv', '.env', '.env.local', '.npmrc', 'src/server.test.ts', 'node_modules/stale/index.js'];
    assert.deepEqual(tar.filter((path) => excluded.includes(path)), []);
  });

  test('follows links inside the app and skips dangling ones and ones leading outside', () => {
    assert.ok(tar.includes('src/ui.css'));
    assert.deepEqual(tar.filter((path) => /^(src\/outside\.json|src\/dangling|node_modules\/linked)/.test(path)), []);
  });

  test('ships nothing through a link into data or to .env', () => {
    assert.deepEqual(tar.filter((path) => path.startsWith('public/uploads') || path.startsWith('src/config')), []);
  });

  test('puts files at app-relative paths', () => {
    const expected = ['node_modules/dep/index.js', 'package-lock.json', 'package.json', 'pneuma-space.json', 'public/ui.css', 'src/server.ts'];
    assert.deepEqual(expected.filter((path) => !tar.includes(path)), []);
  });

  test('releases the bundle with no image and the manifest entry', () => {
    assert.deepEqual(json(release), { image: null, manifest: { ...scaffoldManifest, entry: 'src/server.ts' }, bundle, owner: 'user:ann' });
  });
});

test('a path too long for a bundle exits 4 naming it before any upload', async () => {
  const path = `${'d'.repeat(90)}/${'d'.repeat(90)}/${'d'.repeat(90)}/index.html`;
  const dir = source({ contract: 1, capabilities: { static: { dir: 'dist' } } }, { [`dist/${path}`]: 'x' });
  const result = await appctl(['publish', 'site', dir]);
  assert.equal(result.code, 4);
  assert.equal(result.stderr, `appctl: file path too long for a bundle: ${path}\n`);
  assert.deepEqual(requests, []);
});

test('init --container is the app scaffold with runtime container and a Dockerfile', async () => {
  const target = join(mkdtempSync(join(tmpdir(), 'appctl-init-')), 'app');
  assert.equal((await appctl(['init', target, '--container'])).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'pneuma-space.json'), 'utf8')), { ...scaffoldManifest, runtime: 'container' });
  assert.ok(existsSync(join(target, 'sdk/serve.ts')));
  assert.ok(existsSync(join(target, 'Dockerfile')));
});

describe('appctl audit', () => {
  test('sends the filters as the query, --since as from', async () => {
    const before = Date.now();
    const { code } = await appctl(['audit', '--tenant', 'lab', '--since', '7d', '--action', 'app.purge', '--actor', 'user:alice']);
    assert.equal(code, 0);
    const query = new URL(requests[0].url, admin).searchParams;
    assert.deepEqual([query.get('tenant'), query.get('action'), query.get('actor')], ['lab', 'app.purge', 'user:alice']);
    assert.ok(Math.abs(Number(query.get('from')) - (before - 7 * 86_400_000)) < 5_000);
  });

  test('prints one TSV line per row: at, actor, action, target, result', async () => {
    const { stdout } = await appctl(['audit']);
    assert.equal(stdout, '2026-11-09T01:00:00.000Z\tuser:alice\tapp.purge\tsurvey\tok\n2026-11-09T00:00:00.000Z\tuser:alice\tapp.purge\tsurvey\tstarted\n');
  });

  test('--json prints the rows as the admin API answered them', async () => {
    const { stdout } = await appctl(['audit', '--json']);
    assert.deepEqual(JSON.parse(stdout), AUDIT_ROWS);
  });
});
