import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import {
  admin, appOrigin, bearer, bundle, call, control, credential, deploy, fixture, image, json,
  login, logout, record, request, string, unique, visit, waitFor, type Session,
} from './harness.ts';

const enabled = control.protocol === 'https:';
const options = { skip: !enabled, timeout: 300_000 };
const dockerOptions = { ...options, skip: !enabled || !process.env.PNEUMA_SPACE_TLS_TEST_PROJECT };
const MiB = 1024 * 1024;
let alice: Session;
before(async () => {
  if (!enabled) return;
  assert.equal(control.protocol, 'https:');
  alice = await login('alice');
  execFileSync('docker', ['build', '-q', '-t', image, fixture('echo')], { stdio: 'pipe' });
  if (process.env.PNEUMA_SPACE_HOSTED_TEST_REGISTRY) execFileSync('docker', ['push', image], { stdio: 'pipe' });
});
after(async () => {
  if (!enabled) return;
  if (alice) await logout(alice);
  execFileSync('docker', ['rmi', image], { stdio: 'pipe' });
});

async function upload(url: string, bytes: number, headers: Record<string, string> = {}) {
  const chunk = Buffer.alloc(MiB, 'pneuma');
  const hash = createHash('sha256');
  let received = '';
  const req = request(new URL(url), { method: 'PUT', headers: { 'content-length': String(bytes), ...headers }, signal: AbortSignal.timeout(240_000) });
  const reply = new Promise<number>((resolve, reject) => {
    req.on('error', reject);
    req.on('response', (response) => {
      response.on('data', (part) => { received += part.toString(); });
      response.on('error', reject);
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
  });
  await Promise.all([reply, (async () => {
    for (let sent = 0; sent < bytes;) {
      const part = chunk.subarray(0, Math.min(chunk.length, bytes - sent));
      hash.update(part);
      sent += part.length;
      if (!req.write(part)) await once(req, 'drain');
    }
    req.end();
  })()]);
  return { status: await reply, text: received, hash: hash.digest('hex') };
}

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
function networkBytes(container: string) {
  const line = docker('exec', container, 'cat', '/proc/net/dev').split('\n').find((value) => value.includes('eth0:'));
  assert.ok(line);
  const values = line.split(':')[1]!.trim().split(/\s+/).map(Number);
  return values[0]! + values[8]!;
}

test('AC-SAAS-18 mismatched TLS Host cannot reach a gateway route', options, async () => {
  const reply = await call(control, 'GET', { host: 'unknown.localhost:54443' });
  assert.ok([404, 421].includes(reply.status), reply.text);
});

test('AC-SAAS-18 private static HEAD and Range retain authorization and cache policy', options, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: { contract: 1, capabilities: { static: { dir: '.' } } }, bundle: await bundle(alice, fixture('static-site')) });
  const issued = await credential(t, alice);
  const head = await call(appOrigin(app.name), 'HEAD', bearer(issued.token));
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers['cache-control'], 'private, no-cache');
  const full = await visit(app, issued.token);
  const range = await call(appOrigin(app.name), 'GET', { ...bearer(issued.token), range: 'bytes=0-9' });
  assert.equal(range.status, 206);
  assert.equal(range.text, full.text.slice(0, 10));
  assert.equal((await call(appOrigin(app.name), 'HEAD')).status, 401);
});

test('AC-SAAS-18 original CLI publishes a static bundle over trusted TLS', options, async (t) => {
  const issued = await credential(t, alice);
  const name = unique();
  t.after(async () => {
    assert.equal((await admin(alice, 'POST', `/api/apps/${name}/remove`)).status, 200);
    assert.equal((await admin(alice, 'POST', `/api/apps/${name}/purge`, { confirm: name })).status, 200);
  });
  const output = execFileSync(process.execPath, ['cli/appctl.ts', 'publish', name, 'templates/static', '--tenant', alice.tenant], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8',
    env: { ...process.env, PNEUMA_SPACE_ADMIN: control.origin, PNEUMA_SPACE_TOKEN: issued.token },
  });
  assert.ok(output.includes(name));
  const page = await call(appOrigin(name), 'GET', bearer(issued.token));
  assert.equal(page.status, 200, page.text);
});

test('AC-SAAS-18 app request streams more than 100 MiB without byte changes', options, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: { contract: 1, runtime: 'isolate', capabilities: {} },
    bundle: await bundle(alice, fileURLToPath(new URL('./fixtures/stream/', import.meta.url))) });
  const issued = await credential(t, alice);
  const result = await upload(`${appOrigin(app.name)}/upload`, 128 * MiB, bearer(issued.token));
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(JSON.parse(result.text), { bytes: 128 * MiB, hash: result.hash });
});

for (const path of ['/delayed', '/gap']) test(`AC-SAAS-18 ${path} survives 130 seconds without upstream bytes`, options, async (t) => {
  const app = await deploy(t, alice, { image: null, manifest: { contract: 1, runtime: 'isolate', capabilities: {} },
    bundle: await bundle(alice, fileURLToPath(new URL('./fixtures/stream/', import.meta.url))) });
  const issued = await credential(t, alice);
  const text = await new Promise<string>((resolve, reject) => {
    const req = request(new URL(appOrigin(app.name) + path), { headers: bearer(issued.token), signal: AbortSignal.timeout(150_000) }, (response) => {
      assert.equal(response.statusCode, 200);
      let body = '';
      response.on('error', reject);
      response.on('data', (chunk) => {
        body += chunk.toString();
        if (path === '/gap' && body === 'data: start\n\n') clearTimeout(firstEvent);
      });
      response.on('end', () => resolve(body));
    });
    const firstEvent = setTimeout(() => { if (path === '/gap') req.destroy(new Error('SSE first event was buffered')); }, 5000);
    req.on('error', reject);
    req.on('close', () => clearTimeout(firstEvent));
    req.end();
  });
  assert.equal(text, path === '/gap' ? 'data: start\n\ndata: end\n\n' : 'data: end\n\n');
});

test('AC-MEDIA-2 TLS object upload bypasses app and gateway byte paths', dockerOptions, async (t) => {
  const app = await deploy(t, alice, { image, manifest: { contract: 1, capabilities: { object: {} } } });
  const issued = await credential(t, alice);
  const signed = record(json(await visit(app, issued.token, '/presign?method=PUT&key=uploads/a%20b%2Bc.bin')));
  const container = docker('ps', '-q', '--filter', `name=^pneuma-space-${app.id}-`);
  const gateway = docker('ps', '-q', '--filter', `label=com.docker.compose.project=${process.env.PNEUMA_SPACE_TLS_TEST_PROJECT}`, '--filter', 'label=com.docker.compose.service=gateway');
  assert.ok(container && gateway);
  const before = [networkBytes(container), networkBytes(gateway)];
  assert.equal((await upload(string(signed.url), 500 * MiB)).status, 200);
  const bytes = [networkBytes(container) - before[0]!, networkBytes(gateway) - before[1]!];
  t.diagnostic(`500 MiB upload, app ${bytes[0]} bytes, gateway ${bytes[1]} bytes`);
  assert.ok(bytes.every((value) => value < MiB));
  const get = record(json(await visit(app, issued.token, '/presign?method=GET&key=uploads/a%20b%2Bc.bin')));
  const range = await call(string(get.url), 'GET', { range: 'bytes=0-9' });
  assert.equal(range.status, 206);
  assert.equal(range.text, Buffer.alloc(MiB, 'pneuma').subarray(0, 10).toString());
});

test('AC-MEDIA-4 TLS public object read leaves the app asleep', dockerOptions, async (t) => {
  const app = await deploy(t, alice, { image, manifest: { contract: 1, capabilities: { object: {} } } });
  const issued = await credential(t, alice);
  assert.equal((await admin(alice, 'PUT', `/api/apps/${app.name}/policy`, { idle_seconds: 2 })).status, 200);
  const env = record(json(await visit(app, issued.token, '/env')));
  const signed = record(json(await visit(app, issued.token, '/presign?method=PUT&key=public/movie.bin')));
  assert.equal((await upload(string(signed.url), 1024 * MiB)).status, 200);
  await waitFor(async () => record(json(await admin(alice, 'GET', `/api/apps/${app.name}`))).instance === 'asleep', 'object app to sleep');
  const gateway = docker('ps', '-q', '--filter', `label=com.docker.compose.project=${process.env.PNEUMA_SPACE_TLS_TEST_PROJECT}`, '--filter', 'label=com.docker.compose.service=gateway');
  const rss = () => {
    const match = /^VmRSS:\s+(\d+) kB/m.exec(docker('exec', gateway, 'cat', '/proc/1/status'));
    assert.ok(match);
    return Number(match[1]) * 1024;
  };
  const before = rss();
  const beforeBytes = networkBytes(gateway);
  const url = new URL(`${string(env.PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT)}/${string(env.PNEUMA_SPACE_OBJECT_BUCKET)}/public/movie.bin`);
  const bytes = await new Promise<number>((resolve, reject) => {
    request(url, { signal: AbortSignal.timeout(120_000) }, (response) => {
      assert.equal(response.statusCode, 200);
      let received = 0;
      response.on('data', (chunk) => { received += chunk.length; });
      response.on('error', reject);
      response.on('end', () => resolve(received));
    }).on('error', reject).end();
  });
  const growth = rss() - before;
  const gatewayBytes = networkBytes(gateway) - beforeBytes;
  t.diagnostic(`1 GiB read, gateway RSS change ${growth} bytes, network ${gatewayBytes} bytes`);
  assert.equal(bytes, 1024 * MiB);
  assert.ok(growth < MiB);
  assert.ok(gatewayBytes < MiB);
  assert.equal(record(json(await admin(alice, 'GET', `/api/apps/${app.name}`))).instance, 'asleep');
  assert.equal(docker('ps', '-q', '--filter', `name=^pneuma-space-${app.id}-`), '');
});
