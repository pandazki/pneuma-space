import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { KubeInfra } from './kube-infra.ts';

const BASIC = `Basic ${Buffer.from('ann:secret').toString('base64')}`;
const DIGEST = 'sha256:4f1c0e2a';

/** A registry for `team/notes:1` answering 401 with `challenge` until a request carries `accepted`. */
async function registry(t: TestContext, challenge: (host: string) => string, accepted: string, extra?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean) {
  const seen: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req);
    if (extra?.(req, res)) return;
    if (req.method !== 'HEAD' || req.url !== '/v2/team/notes/manifests/1') return res.writeHead(404).end();
    if (req.headers.authorization !== accepted) return res.writeHead(401, { 'www-authenticate': challenge(host) }).end();
    res.writeHead(200, { 'docker-content-digest': DIGEST }).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authFile = join(await mkdtemp(join(tmpdir(), 'registry-')), '.dockerconfigjson');
  await writeFile(authFile, JSON.stringify({ auths: { [host]: { auth: BASIC.slice('Basic '.length) } } }));
  return { host, seen, infra: new KubeInfra({ registry: host, authFile }) };
}

test('resolveImage answers a Basic challenge with the dockerconfigjson credentials and returns the digest reference', async (t) => {
  const { host, infra } = await registry(t, () => 'Basic realm="registry"', BASIC);
  assert.equal(await infra.resolveImage(`${host}/team/notes:1`), `${host}/team/notes@${DIGEST}`);
});

test('resolveImage exchanges the credentials for a Bearer token at the challenge realm and returns the digest reference', async (t) => {
  let scope: string | null = null;
  const { infra, host } = await registry(t, (h) => `Bearer realm="http://${h}/token",service="registry"`, 'Bearer tk', (req, res) => {
    if (!req.url!.startsWith('/token')) return false;
    scope = new URL(req.url!, 'http://x').searchParams.get('scope');
    if (req.headers.authorization !== BASIC) res.writeHead(401).end();
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'tk' }));
    return true;
  });
  assert.equal(await infra.resolveImage('team/notes:1'), `${host}/team/notes@${DIGEST}`);
  assert.equal(scope, 'repository:team/notes:pull');
});
