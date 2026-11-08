import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { KubeClient, type Node, type PersistentVolumeClaim, type Pod } from './kube.ts';
import type { Ending, Slot } from './lifecycle.ts';
import { appName, DEFAULT_POLICY, DEFAULT_TENANT, type AppId, type ImageId, type InstanceLog, type ReleaseNumber, type RunSpec } from './model.ts';
import { planeOf, podConfig, podFor, PodDriver } from './pods.ts';
import { Unavailable } from './runtimes.ts';

const APP = 'a1b2c3d4e5f6' as AppId;
const NAME = `pneuma-space-${APP}`;
const CLAIM = `pneuma-space-db-${APP}`;

const spec = {
  app: APP, name: appName('notes'), tenant: DEFAULT_TENANT, release: 3 as ReleaseNumber,
  runtime: { kind: 'container', image: 'registry.example.com/notes@sha256:abc' as ImageId },
  injection: { env: { PNEUMA_SPACE_REDIS_URL: 'redis://r' }, storage: [{ id: CLAIM, target: '/pneuma/db', env: { PNEUMA_SPACE_DB_URL: 'sqlite://{dir}/app.sqlite3' } }], services: ['postgres'] },
  policy: { ...DEFAULT_POLICY, cpu_millis: 500, memory_mb: 256, drain_timeout_seconds: 30 },
  version: 1,
} satisfies RunSpec;

const config = podConfig({ PNEUMA_SPACE_K8S_PULL_SECRETS: 'pull-a,pull-b', PNEUMA_SPACE_K8S_NODE_SELECTOR: 'pool=apps,zone=a' });

/** A Kubernetes API server holding Pods, claims and nodes in memory, with a watch on Pods. */
class FakeKube {
  readonly pods = new Map<string, Pod>();
  readonly claims = new Map<string, PersistentVolumeClaim>();
  readonly logs = new Map<string, string>();
  nodes: Node[] = [];
  /** A delete without grace 0 leaves the Pod Terminating until `remove`. */
  terminating = false;
  claimStays = false;
  /** Runs before a Pod create is answered, as a racing writer would. */
  beforeCreate: (() => void) | null = null;
  readonly journal: string[] = [];
  readonly requests: { method: string; url: URL; body: any }[] = [];
  readonly #watchers = new Set<http.ServerResponse>();
  #rv = 1;
  #uid = 0;

  pod(name: string, labels: Record<string, string> = {}, status: Pod['status'] = { phase: 'Pending' }): Pod {
    const pod: Pod = { metadata: { name, uid: `uid-${++this.#uid}`, resourceVersion: String(++this.#rv), labels: { 'pneuma-space.app': APP, 'pneuma-space.release': '3', ...labels } }, spec: { containers: [], nodeName: 'n1' }, status };
    this.pods.set(name, pod);
    this.#emit('ADDED', pod);
    return pod;
  }

  status(name: string, status: Pod['status']): void {
    const pod = { ...this.pods.get(name)!, status };
    this.pods.set(name, pod);
    this.#emit('MODIFIED', pod);
  }

  running(name: string, ip = '10.0.0.7'): void {
    this.status(name, { phase: 'Running', podIP: ip, containerStatuses: [{ name: 'app', ready: false, state: { running: {} } }] });
  }

  terminated(name: string, terminated: { exitCode: number; reason?: string }): void {
    this.status(name, { phase: 'Failed', containerStatuses: [{ name: 'app', ready: false, state: { terminated } }] });
  }

  remove(name: string): void {
    const pod = this.pods.get(name)!;
    this.pods.delete(name);
    this.#emit('DELETED', pod);
  }

  async watching(): Promise<void> {
    while (this.#watchers.size === 0) await sleep(2);
  }

  #emit(type: string, object: Pod): void {
    for (const res of this.#watchers) res.write(`${JSON.stringify({ type, object })}\n`);
  }

  handle(method: string, url: URL, body: any, res: http.ServerResponse): unknown {
    this.requests.push({ method, url, body });
    const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    const status = (code: number, reason: string) => json(code, { kind: 'Status', code, reason, message: reason });
    const [, kind, name, sub] = url.pathname.match(/^\/api\/v1(?:\/namespaces\/apps)?\/(\w+)(?:\/([^/]+))?(?:\/(\w+))?$/) ?? [];
    if (kind === 'nodes') return json(200, { metadata: { resourceVersion: '1' }, items: this.nodes.filter((n) => url.searchParams.get('fieldSelector') === `metadata.name=${n.metadata.name}`) });
    if (kind === 'persistentvolumeclaims') {
      if (method === 'POST') {
        if (this.claims.has(body.metadata.name)) return status(409, 'AlreadyExists');
        this.claims.set(body.metadata.name, body);
        return json(201, body);
      }
      if (!this.claims.has(name)) return status(404, 'NotFound');
      if (method === 'DELETE') {
        this.journal.push(`delete claim ${name}`);
        if (!this.claimStays) this.claims.delete(name);
      }
      return json(200, this.claims.get(name) ?? {});
    }
    if (method === 'GET' && !name && url.searchParams.has('watch')) {
      res.writeHead(200, { 'content-type': 'application/json' }).flushHeaders();
      this.#watchers.add(res);
      res.on('close', () => this.#watchers.delete(res));
      return;
    }
    if (method === 'GET' && !name) return json(200, { metadata: { resourceVersion: String(this.#rv) }, items: [...this.pods.values()] });
    if (method === 'POST') {
      this.beforeCreate?.();
      if (this.pods.has(body.metadata.name)) return status(409, 'AlreadyExists');
      this.journal.push('create pod');
      return json(201, this.pod(body.metadata.name, body.metadata.labels));
    }
    const pod = this.pods.get(name);
    if (!pod) return status(404, 'NotFound');
    if (sub === 'log') return this.logs.has(name) ? res.writeHead(200).end(this.logs.get(name)) : status(400, 'BadRequest');
    if (method === 'GET') return json(200, pod);
    if (body.preconditions?.uid && body.preconditions.uid !== pod.metadata.uid) return status(409, 'Conflict');
    this.journal.push(`delete pod ${pod.metadata.uid}${body.gracePeriodSeconds === 0 ? ' grace 0' : ''}`);
    if (this.terminating && body.gracePeriodSeconds !== 0) {
      const marked = { ...pod, metadata: { ...pod.metadata, deletionTimestamp: 'now' } };
      this.pods.set(name, marked);
      this.#emit('MODIFIED', marked);
    } else {
      this.remove(name);
    }
    json(200, pod);
  }
}

type Setup = { kube: FakeKube; driver: PodDriver; clock: { now: number }; gone: { app: AppId; uid: string; ending: Ending }[]; saved: InstanceLog[]; probes: string[] };

async function setup(t: TestContext, options: { ready?: () => boolean } = {}): Promise<Setup> {
  const kube = new FakeKube();
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    kube.handle(req.method!, new URL(req.url!, 'http://fake'), text ? JSON.parse(text) : {}, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const clock = { now: 1_000_000 };
  const saved: InstanceLog[] = [];
  const probes: string[] = [];
  const gone: Setup['gone'] = [];
  const driver = new PodDriver({
    kube: new KubeClient({ server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: async () => 't', namespace: 'apps' }),
    config,
    store: {
      instanceLog: async (app) => saved.findLast((log) => log.app === app) ?? null,
      putInstanceLog: async (log) => {
        kube.journal.push(`log ${log.reason}: ${log.tail}`);
        saved.push(log);
      },
    },
    policyOf: () => spec.policy,
    log: () => {},
    now: () => clock.now,
    pollMs: 5,
    connect: async (host, port) => {
      probes.push(`${host}:${port}`);
      return options.ready?.() ?? true;
    },
  });
  const stop = new AbortController();
  driver.follow((app, uid, ending) => gone.push({ app, uid, ending }), stop.signal);
  await kube.watching();
  t.after(() => {
    stop.abort();
    server.closeAllConnections();
    server.close();
  });
  return { kube, driver, clock, gone, saved, probes };
}

const slot = (epoch = 7): Slot<string> => ({ handle: null, release: 3 as ReleaseNumber, specHash: '', epoch });

async function until(what: string, condition: () => boolean): Promise<void> {
  for (const end = Date.now() + 3000; !condition(); await sleep(5)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

/** Starts the app and marks its Pod Running once created. */
async function started(s: Setup, epoch = 7) {
  const into = slot(epoch);
  const address = s.driver.start(into, spec);
  await until('the Pod is created', () => s.kube.requests.some((r) => r.method === 'POST' && r.url.pathname.endsWith('/pods')));
  s.kube.running(NAME);
  return { into, address: await address };
}

test('the Pod of a wake has the shape ADR 0019 item 4 names, with restricted off', () => {
  assert.deepEqual(podFor(spec, 7, config), {
    metadata: {
      name: NAME,
      labels: {
        'app.kubernetes.io/part-of': 'pneuma-space', 'pneuma-space.app': APP, 'pneuma-space.role': 'instance', 'pneuma-space.release': '3',
        'pneuma-space.epoch': '7', 'pneuma-space.tenant': 'default', 'pneuma-space.reach.postgres': '1',
      },
      annotations: { 'pneuma-space.spec': podFor(spec, 7, config).metadata.annotations!['pneuma-space.spec'] },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      serviceAccountName: 'pneuma-space-app',
      terminationGracePeriodSeconds: 10,
      imagePullSecrets: [{ name: 'pull-a' }, { name: 'pull-b' }],
      nodeSelector: { pool: 'apps', zone: 'a' },
      securityContext: { seccompProfile: { type: 'RuntimeDefault' }, fsGroup: 2000 },
      containers: [{
        name: 'app',
        image: 'registry.example.com/notes@sha256:abc',
        imagePullPolicy: 'IfNotPresent',
        ports: [{ containerPort: 8000 }],
        env: [
          { name: 'PNEUMA_SPACE_REDIS_URL', value: 'redis://r' },
          { name: 'PNEUMA_SPACE_DB_URL', value: 'sqlite:///pneuma/db/app.sqlite3' },
          { name: 'PNEUMA_SPACE_APP', value: 'notes' },
          { name: 'PNEUMA_SPACE_RELEASE', value: '3' },
          { name: 'PNEUMA_SPACE_PORT', value: '8000' },
        ],
        resources: { limits: { cpu: '500m', memory: '256Mi' }, requests: { cpu: '100m', memory: '256Mi' } },
        volumeMounts: [{ name: CLAIM, mountPath: '/pneuma/db' }],
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['NET_RAW'] } },
      }],
      volumes: [{ name: CLAIM, persistentVolumeClaim: { claimName: CLAIM } }],
    },
  });
});

test('PNEUMA_SPACE_K8S_RESTRICTED=1 adds runAsNonRoot and drops every capability', () => {
  const pod = podFor(spec, 7, podConfig({ PNEUMA_SPACE_K8S_RESTRICTED: '1' }));
  assert.equal(pod.spec.securityContext?.runAsNonRoot, true);
  assert.deepEqual(pod.spec.containers[0].securityContext?.capabilities?.drop, ['ALL']);
});

test('a 409 on Pod create whose Pod carries this epoch is this wake\'s Pod', async (t) => {
  const s = await setup(t);
  let raced = '';
  s.kube.beforeCreate = () => {
    s.kube.beforeCreate = null;
    raced = s.kube.pod(NAME, { 'pneuma-space.epoch': '7' }).metadata.uid!;
  };
  const { into } = await started(s);
  assert.equal(into.handle, raced);
});

test('a 409 on Pod create whose Pod carries another epoch fails the wake as Unavailable', async (t) => {
  const s = await setup(t);
  s.kube.beforeCreate = () => {
    s.kube.beforeCreate = null;
    s.kube.pod(NAME, { 'pneuma-space.epoch': '6' });
  };
  await assert.rejects(s.driver.start(slot(7), spec), Unavailable);
});

test('a Failed Pod left under the name is logged and deleted by uid before the new Pod is created', async (t) => {
  const s = await setup(t);
  const stale = s.kube.pod(NAME, {}, { phase: 'Failed', containerStatuses: [{ name: 'app', ready: false, state: { terminated: { exitCode: 1 } } }] });
  s.kube.logs.set(NAME, 'boom\n');
  await started(s);
  assert.deepEqual(s.kube.journal.slice(0, 3), ['log container exited with code 1: boom\n', `delete pod ${stale.metadata.uid}`, 'create pod']);
});

test('an existing claim is not an error on wake', async (t) => {
  const s = await setup(t);
  s.kube.claims.set(CLAIM, { metadata: { name: CLAIM }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } });
  assert.equal((await started(s)).address, '10.0.0.7:8000');
});

test('a Pod still Pending after PNEUMA_SPACE_K8S_PENDING_SECONDS fails the wake as Unavailable', async (t) => {
  const s = await setup(t);
  const start = s.driver.start(slot(), spec);
  await until('the Pod is created', () => s.kube.pods.has(NAME));
  s.clock.now += 60_000;
  await assert.rejects(start, Unavailable);
});

test('the TCP probe starts once the container runs and the wake resolves with the Pod IP', async (t) => {
  let ready = false;
  const s = await setup(t, { ready: () => ready });
  const start = s.driver.start(slot(), spec);
  await until('the Pod is created', () => s.kube.pods.has(NAME));
  await sleep(30);
  assert.deepEqual(s.probes, []);
  s.kube.running(NAME, '10.0.0.9');
  await until('a probe', () => s.probes.length > 0);
  ready = true;
  assert.equal(await start, '10.0.0.9:8000');
  assert.ok(s.probes.every((probe) => probe === '10.0.0.9:8000'));
});

test('a wake records the node its Pod was scheduled on, for the instance row', async (t) => {
  const s = await setup(t);
  const { into } = await started(s);
  assert.equal(into.node, 'n1');
});

test('a Pod that fails while the wake waits fails it as the app\'s, with the exit reason', async (t) => {
  const s = await setup(t);
  const start = s.driver.start(slot(), spec);
  await until('the Pod is created', () => s.kube.pods.has(NAME));
  s.kube.terminated(NAME, { exitCode: 3, reason: 'Error' });
  const error = await start.catch((e: unknown) => e);
  assert.ok(error instanceof Error && !(error instanceof Unavailable));
  assert.match(error.message, /exited with code 3 \(Error\)/);
});

test('sleep writes the log tail, deletes the Pod by uid and resolves on DELETED', async (t) => {
  const s = await setup(t);
  const { into } = await started(s);
  const uid = into.handle!;
  s.kube.logs.set(NAME, 'served 3 requests\n');
  s.kube.terminating = true;
  s.kube.journal.length = 0;
  let done = false;
  const sleeping = s.driver.sleep(APP, into).then(() => (done = true));
  await until('the delete', () => s.kube.journal.length === 2);
  await sleep(30);
  assert.equal(done, false);
  s.kube.remove(NAME);
  await sleeping;
  assert.deepEqual(s.kube.journal, ['log sleep: served 3 requests\n', `delete pod ${uid}`]);
  assert.equal(into.handle, null);
});

test('a Pod deleted from outside is reported stopped', async (t) => {
  const s = await setup(t);
  const { into } = await started(s);
  s.kube.remove(NAME);
  await until('the report', () => s.gone.length > 0);
  assert.deepEqual(s.gone, [{ app: APP, uid: into.handle, ending: { ev: 'stopped' } }]);
});

test('an OOMKilled container is reported crashed for memory', async (t) => {
  const s = await setup(t);
  await started(s);
  s.kube.terminated(NAME, { exitCode: 137, reason: 'OOMKilled' });
  await until('the report', () => s.gone.length > 0);
  assert.equal(s.gone[0].ending.ev, 'crashed');
  assert.match((s.gone[0].ending as { reason: string }).reason, /memory/);
});

test('a Pod stuck Terminating is force-deleted only after drain_timeout_seconds and only on a node tainted out-of-service', async (t) => {
  const s = await setup(t);
  const { into } = await started(s);
  const uid = into.handle!;
  s.kube.terminating = true;
  s.kube.nodes = [{ metadata: { name: 'n1' } }];
  const sleeping = s.driver.sleep(APP, into);
  await until('the delete', () => s.kube.journal.includes(`delete pod ${uid}`));
  s.kube.nodes = [{ metadata: { name: 'n1' }, spec: { taints: [{ key: 'node.kubernetes.io/out-of-service', value: 'nodeshutdown', effect: 'NoExecute' }] } }];
  await sleep(30);
  assert.ok(!s.kube.journal.includes(`delete pod ${uid} grace 0`), 'not before drain_timeout_seconds');
  s.kube.nodes = [{ metadata: { name: 'n1' } }];
  s.clock.now += 30_000;
  await sleep(30);
  assert.ok(!s.kube.journal.includes(`delete pod ${uid} grace 0`), 'not without the taint');
  s.kube.nodes = [{ metadata: { name: 'n1' }, spec: { taints: [{ key: 'node.kubernetes.io/out-of-service', value: 'nodeshutdown', effect: 'NoExecute' }] } }];
  await sleeping;
  assert.ok(s.kube.journal.includes(`delete pod ${uid} grace 0`));
});

test('adopt lists Pods labelled pneuma-space.role=instance with their release, spec and address', async (t) => {
  const s = await setup(t);
  const pod = s.kube.pod(NAME, { 'pneuma-space.epoch': '2' });
  s.kube.running(NAME);
  const adopted = await s.driver.adopt();
  assert.equal(s.kube.requests.findLast((r) => r.method === 'GET' && !r.url.searchParams.has('watch'))?.url.searchParams.get('labelSelector'), 'pneuma-space.role=instance');
  assert.deepEqual(adopted, [{ app: APP, handle: pod.metadata.uid, release: '3', spec: '', address: '10.0.0.7:8000' }]);
});

test('destroyStorage resolves once the deleted claim is gone', async (t) => {
  const s = await setup(t);
  s.kube.claims.set(CLAIM, { metadata: { name: CLAIM }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } });
  await s.driver.destroyStorage(APP, CLAIM);
  assert.deepEqual([s.kube.journal, s.kube.claims.has(CLAIM)], [[`delete claim ${CLAIM}`], false]);
});

test('destroyStorage throws Conflict when the claim is still there 30 s after its deletion', async (t) => {
  const s = await setup(t);
  s.kube.claims.set(CLAIM, { metadata: { name: CLAIM }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } });
  s.kube.claimStays = true;
  const destroying = s.driver.destroyStorage(APP, CLAIM);
  await until('the delete', () => s.kube.journal.length > 0);
  s.clock.now += 30_000;
  await assert.rejects(destroying, /still exists 30 s after/);
});

test('PNEUMA_SPACE_PLANE=kubernetes with PNEUMA_SPACE_IDENTITY=local refuses to start', () => {
  assert.throws(() => planeOf({ PNEUMA_SPACE_PLANE: 'kubernetes' }), /refuses PNEUMA_SPACE_IDENTITY=local/);
  assert.equal(planeOf({ PNEUMA_SPACE_PLANE: 'kubernetes', PNEUMA_SPACE_IDENTITY: 'upstream' }), 'kubernetes');
});
