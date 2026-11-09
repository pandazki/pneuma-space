import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeView } from './nodes.ts';
import {
  appName, DEFAULT_TENANT,
  type AppId, type AppName, type AppSummary, type Instance, type InstanceState, type NodeSample, type PlatformPod, type ReleaseNumber, type Replica, type ReplicaId, type Workload,
} from './model.ts';

const A = 'a1b2c3d4e5f6' as AppId;
const B = 'b1b2c3d4e5f6' as AppId;

const row = (app: AppId, state: InstanceState, node: string | null): Instance => ({
  app, runtime: 'container', release: 1 as ReleaseNumber, specHash: '', epoch: 1, state, actor: null, handle: 'h', address: null,
  node, home: null, since: 0, awakeAt: null, cpuMillis: 500, memoryMb: 256,
});
const NAMES = new Map<AppId, AppName>([[A, appName('survey')], [B, appName('chess')]]);
const pod = (name: string, role: string, app: AppId | null = null, node: string | null = null): PlatformPod => ({
  name, role, app, ip: '10.0.0.5', phase: 'Running', ready: true, restarts: 1, node, startedAt: 0, leading: false,
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

function view({ cluster = null as NodeSample[] | null, rows = [] as Instance[], apps = [] as AppSummary[], workloads = [] as Workload[], replicas = [] as Replica[] } = {}) {
  const byApp = new Map(rows.map((r) => [r.app, r]));
  const nodes = new NodeView({
    infra: { nodes: async () => cluster, workloads: async () => workloads, volumes: async () => [], warnings: async () => [] },
    apps: async () => apps,
    nameOf: (app) => NAMES.get(app) ?? null,
    instances: { row: (app) => byApp.get(app) ?? null, rows: () => byApp.values() },
    replicas: async () => replicas,
    runner: async () => ({ workers: 3, stuck: 0 }),
    now: () => 42,
  });
  return { nodes };
}


test('an app\'s node is its instance row\'s node while it runs and null once it sleeps', () => {
  const { nodes } = view({ rows: [row(A, 'awake', 'n2'), row(B, 'asleep', 'n2')] });
  assert.deepEqual([nodes.nodeOf(A), nodes.nodeOf(B)], ['n2', null]);
});

test('on a cluster each awake app is listed under its node, with the gateways and the runner of that node', async () => {
  const { nodes } = view({
    cluster: [sample('n1', [pod('gw-0', 'gateway', null, 'n1')]), sample('n2', [pod('runner-0', 'runner', null, 'n2')])],
    apps: [summary('survey', 'awake', 'n2'), summary('chess', 'asleep', null)],
  });
  await nodes.sample();
  assert.deepEqual(nodes.snapshot().nodes.map((n) => [n.name, n.gateways.map((g) => g.pod), n.runner && [n.runner.pod, n.runner.workers], n.instances.map((i) => i.app)]), [
    ['n1', ['gw-0'], null, []],
    ['n2', [], ['runner-0', 3], ['survey']],
  ]);
});

test('the cluster view joins an awake instance to its Pod and node and marks the gateway whose heartbeat leads', async () => {
  const gateways: Workload = {
    name: 'pneuma-space-gateway', role: 'gateway', kind: 'Deployment', desired: 2, ready: 2, scalable: true, image: 'gw:1',
    pods: [pod('gw-0', 'gateway', null, 'n1'), pod('gw-1', 'gateway', null, 'n2')],
  };
  const { nodes } = view({
    cluster: [sample('n1', [pod('pneuma-space-a1', 'instance', A, 'n1')])],
    rows: [row(A, 'awake', null), row(B, 'asleep', null)],
    apps: [summary('survey', 'awake', 'n1'), summary('chess', 'asleep', null)],
    workloads: [gateways],
    replicas: [{ id: 'gw-0' as ReplicaId, startedAt: 0, seenAt: 42, leading: false }, { id: 'gw-1' as ReplicaId, startedAt: 0, seenAt: 42, leading: true }],
  });
  await nodes.sample();
  const cluster = nodes.snapshot();
  assert.deepEqual(cluster.instances.map((i) => [i.app, i.tenant, i.state, i.node, i.pod, i.restarts]), [['survey', DEFAULT_TENANT, 'awake', 'n1', 'pneuma-space-a1', 1]]);
  assert.deepEqual(cluster.workloads[0]!.pods.map((p) => [p.name, p.leading]), [['gw-0', false], ['gw-1', true]]);
});
