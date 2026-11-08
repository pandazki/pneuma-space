import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeView } from './nodes.ts';
import { appName, DEFAULT_TENANT, type AppId, type AppSummary, type Instance, type InstanceState, type NodeSample, type ReleaseNumber, type ReplicaId } from './model.ts';

const A = 'a1b2c3d4e5f6' as AppId;
const B = 'b1b2c3d4e5f6' as AppId;

const row = (app: AppId, state: InstanceState, node: string | null): Instance => ({
  app, runtime: 'container', release: 1 as ReleaseNumber, specHash: '', epoch: 1, state, actor: null, handle: 'h', address: null,
  node, home: null, since: 0, awakeAt: null, cpuMillis: 500, memoryMb: 256,
});

const summary = (name: string, instance: InstanceState, node: string | null): AppSummary => ({
  name: appName(name), address: `/apps/${name}/`, tenant: DEFAULT_TENANT, access: 'org', release: 1 as ReleaseNumber, capabilities: [], status: 'registered', instance, since: null,
  leases: { request: 0, channel: 0, trigger: 0 }, sleepsAt: null, runtime: 'container', quarantine: null, dbBackend: null,
  lastAccessAt: null, requests: 0, errors: 0, node,
});

const sample = (name: string, pods: NodeSample['pods'] = []): NodeSample => ({
  name, ready: true, schedulable: true, labels: {}, taints: [],
  allocatable: { cpuMillis: 4000, memoryBytes: 2 ** 33, pods: 110 }, requested: { cpuMillis: 0, memoryBytes: 0, pods: 0 }, pods,
});

function view({ cluster = null as NodeSample[] | null, rows = [] as Instance[], apps = [] as AppSummary[] } = {}) {
  const byApp = new Map(rows.map((r) => [r.app, r]));
  const nodes = new NodeView({
    infra: { nodes: async () => cluster },
    apps: async () => apps,
    instances: { row: (app) => byApp.get(app) ?? null, rows: () => byApp.values() },
    host: async () => ({ cpus: 8, load: [1, 1, 1], memory: { totalBytes: 2 ** 34, freeBytes: 2 ** 33 }, data: null }),
    runner: async () => ({ workers: 3, stuck: 0 }),
    runnerOnHost: async () => true,
    replica: 'gw-0' as ReplicaId,
    hostname: 'box',
    now: () => 42,
  });
  return { nodes };
}

test('on a single host the answer is source host with one node holding what awake instances requested', async () => {
  const { nodes } = view({ rows: [row(A, 'awake', null), row(B, 'asleep', null)], apps: [summary('survey', 'awake', null), summary('chess', 'asleep', null)] });
  await nodes.sample();
  const answer = nodes.snapshot();
  assert.equal(answer.source, 'host');
  assert.deepEqual(answer.nodes.map((n) => [n.name, n.requested, n.instances.map((i) => i.app), n.runner?.workers]), [
    ['box', { cpuMillis: 500, memoryBytes: 256 * 2 ** 20, pods: 1 }, ['survey'], 3],
  ]);
});

test('an app\'s node is its instance row\'s node while it runs and null once it sleeps', () => {
  const { nodes } = view({ rows: [row(A, 'awake', 'n2'), row(B, 'asleep', 'n2')] });
  assert.deepEqual([nodes.nodeOf(A), nodes.nodeOf(B)], ['n2', null]);
});

test('on a cluster each awake app is listed under its node, with the gateways and the runner of that node', async () => {
  const pod = (name: string, role: string) => ({ name, role, app: null, ip: '10.0.0.5', phase: 'Running', ready: true, restarts: 1 });
  const { nodes } = view({
    cluster: [sample('n1', [pod('gw-0', 'gateway')]), sample('n2', [pod('runner-0', 'runner')])],
    apps: [summary('survey', 'awake', 'n2'), summary('chess', 'asleep', null)],
  });
  await nodes.sample();
  assert.deepEqual(nodes.snapshot().nodes.map((n) => [n.name, n.gateways.map((g) => g.pod), n.runner && [n.runner.pod, n.runner.workers], n.instances.map((i) => i.app)]), [
    ['n1', ['gw-0'], null, []],
    ['n2', [], ['runner-0', 3], ['survey']],
  ]);
});
