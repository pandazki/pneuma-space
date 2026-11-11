import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { KubeClient, type Node, type Pod } from './kube.ts';
import { KubeInfra } from './kube-infra.ts';
import { Conflict } from './model.ts';

const nowhere = new KubeClient({ server: 'http://127.0.0.1:9', token: async () => 't', namespace: 'pneuma-space' });
const BASIC = `Basic ${Buffer.from('ann:secret').toString('base64')}`;
const DIGEST = 'sha256:4f1c0e2a';

/** A registry for `team/notes:1` answering 401 with `challenge` until a request carries `accepted`; with `pull`, nodes pull it as `pull` and the gateway reaches it through PNEUMA_SPACE_REGISTRY_API. */
async function registry(
  t: TestContext, challenge: (host: string) => string, accepted: string,
  extra?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean, pull?: string,
) {
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
  await writeFile(authFile, JSON.stringify({ auths: { [pull ?? host]: { auth: BASIC.slice('Basic '.length) } } }));
  return { host, seen, infra: new KubeInfra({ platform: nowhere, apps: nowhere, registry: pull ?? host, registryApi: pull ? `http://${host}` : null, authFile }) };
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

test('resolveImage reaches the configured registry through PNEUMA_SPACE_REGISTRY_API and names the pull host', async (t) => {
  const pull = 'registry.invalid:30500';
  const { infra, seen } = await registry(t, () => `Bearer realm="https://${pull}/token",service="registry"`, 'Bearer tk', (req, res) => {
    if (!req.url!.startsWith('/token')) return false;
    if (req.headers.authorization !== BASIC) res.writeHead(401).end();
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'tk' }));
    return true;
  }, pull);
  assert.equal(await infra.resolveImage(`${pull}/team/notes:1`), `${pull}/team/notes@${DIGEST}`);
  assert.deepEqual(seen.map((req) => req.url!.split('?')[0]), ['/v2/team/notes/manifests/1', '/token', '/v2/team/notes/manifests/1']);
});

const node = (name: string, unschedulable = false): Node => ({
  metadata: { name, labels: { zone: 'a' } },
  spec: { unschedulable, taints: unschedulable ? [{ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' }] : [] },
  status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '3500m', memory: '8Gi', pods: '110' } },
});
const rolePod = (name: string, role: string, nodeName: string, requests: { cpu?: string; memory?: string }, phase: 'Running' | 'Succeeded' = 'Running'): Pod => ({
  metadata: { name, labels: { 'pneuma-space.role': role } },
  spec: { nodeName, containers: [{ name: 'c', image: 'i', resources: { requests } }] },
  status: { phase, podIP: '10.0.0.1', containerStatuses: [{ name: 'c', ready: true, restartCount: 2 }] },
});

test('nodes sums the requests of the platform Pods on each node across both namespaces and marks a cordoned node unschedulable', async (t) => {
  const listed: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://fake');
    listed.push(`${url.pathname}?${url.searchParams.get('labelSelector') ?? ''}`);
    const items = url.pathname === '/api/v1/nodes' ? [node('n1'), node('n2', true)]
      : url.pathname === '/api/v1/namespaces/pneuma-space/pods' ? [rolePod('gw', 'gateway', 'n1', { cpu: '250m', memory: '256Mi' }), rolePod('runner-0', 'runner', 'n2', { cpu: '1', memory: '1Gi' })]
        : [rolePod('app-a', 'instance', 'n1', { cpu: '100m', memory: '128Mi' }), rolePod('app-done', 'instance', 'n1', { cpu: '2', memory: '1Gi' }, 'Succeeded')];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ metadata: { resourceVersion: '1' }, items }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const at = (namespace: string) => new KubeClient({ server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: async () => 't', namespace });
  const nodes = await new KubeInfra({ platform: at('pneuma-space'), apps: at('pneuma-space-apps'), registry: null, registryApi: null, authFile: null }).nodes();
  assert.deepEqual(nodes.map((n) => [n.name, n.schedulable, n.requested, n.allocatable]), [
    ['n1', true, { cpuMillis: 350, memoryBytes: 384 * 2 ** 20, pods: 2 }, { cpuMillis: 3500, memoryBytes: 8 * 2 ** 30, pods: 110 }],
    ['n2', false, { cpuMillis: 1000, memoryBytes: 2 ** 30, pods: 1 }, { cpuMillis: 3500, memoryBytes: 8 * 2 ** 30, pods: 110 }],
  ]);
  assert.deepEqual(nodes[1]!.pods.map((p) => [p.name, p.role, p.ready, p.restarts]), [['runner-0', 'runner', true, 2]]);
  assert.deepEqual(listed.filter((l) => l.includes('/pods')).sort(), ['/api/v1/namespaces/pneuma-space-apps/pods?pneuma-space.role', '/api/v1/namespaces/pneuma-space/pods?pneuma-space.role']);
});

/** A platform namespace holding `pods`; records every request as `METHOD path body`. */
async function platform(t: TestContext, pods: readonly Pod[]) {
  const seen: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push(`${req.method} ${req.url} ${req.headers['content-type'] ?? ''} ${body}`.replace(/ +/g, ' ').trim());
    const name = req.url!.split('/').at(-1);
    const pod = pods.find((p) => p.metadata.name === name);
    if (req.method === 'GET' && !pod) return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'Status', code: 404, reason: 'NotFound' }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(pod ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const kube = new KubeClient({ server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: async () => 't', namespace: 'pneuma-space' });
  return { seen, infra: new KubeInfra({ platform: kube, apps: kube, registry: null, registryApi: null, authFile: null }) };
}

const named = (name: string, labels: Record<string, string>): Pod => ({ metadata: { name, uid: `uid-${name}`, labels }, spec: { containers: [] } });

test('scaling pneuma-space-postgres is a Conflict and sends nothing to Kubernetes (AC-OPS-12)', async (t) => {
  const { seen, infra } = await platform(t, []);
  await assert.rejects(infra.scale('pneuma-space-postgres', 2), Conflict);
  assert.deepEqual(seen, []);
});

test('scaling the runner merge-patches the StatefulSet scale subresource (AC-OPS-12)', async (t) => {
  const { seen, infra } = await platform(t, []);
  await infra.scale('pneuma-space-runner', 3);
  assert.deepEqual(seen, ['PATCH /apis/apps/v1/namespaces/pneuma-space/statefulsets/pneuma-space-runner/scale application/merge-patch+json {"spec":{"replicas":3}}']);
});

test('a runner home is removed by a count exactly when its ordinal is at or above it, and no other workload holds homes (ADR 0032)', () => {
  const infra = new KubeInfra({ platform: nowhere, apps: nowhere, registry: null, registryApi: null, authFile: null });
  const homes = ['pneuma-space-runner-0', 'pneuma-space-runner-1', 'pneuma-space-runner-2', 'pneuma-space-runner-10', 'runner', 'pneuma-space-runner-x', 'pneuma-space-runner-2-a'];
  assert.deepEqual(homes.map(infra.removedBy('pneuma-space-runner', 2)!), [false, false, true, true, false, false, false]);
  assert.deepEqual([infra.removedBy('pneuma-space-gateway', 1), infra.removedBy('pneuma-space-postgres', 1)], [null, null]);
});

test('restarting a postgres Pod is a Conflict and deletes nothing (AC-OPS-13)', async (t) => {
  const { seen, infra } = await platform(t, [named('pneuma-space-postgres-0', { 'app.kubernetes.io/part-of': 'pneuma-space' })]);
  await assert.rejects(infra.deletePod('pneuma-space-postgres-0'), Conflict);
  assert.equal(seen.filter((s) => s.startsWith('DELETE')).length, 0);
});

test('restarting a gateway Pod deletes it under its uid', async (t) => {
  const { seen, infra } = await platform(t, [named('pneuma-space-gateway-7f9-x2', { 'pneuma-space.role': 'gateway' })]);
  await infra.deletePod('pneuma-space-gateway-7f9-x2');
  const deleted = seen.find((s) => s.startsWith('DELETE'))!;
  assert.match(deleted, /^DELETE \/api\/v1\/namespaces\/pneuma-space\/pods\/pneuma-space-gateway-7f9-x2 /);
  assert.equal(JSON.parse(deleted.slice(deleted.indexOf('{'))).preconditions.uid, 'uid-pneuma-space-gateway-7f9-x2');
});
