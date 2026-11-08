// `PNEUMA_SPACE_TEST_KUBECONTEXT=<context> npm run test:k8s` against the operator's cluster; skipped when unset.
// The client gets the context's server and CA plus a 10-minute token for this ServiceAccount, which the operator creates once:
//
//   apiVersion: v1
//   kind: ServiceAccount
//   metadata: { name: pneuma-space-smoke, namespace: pneuma-space-apps, labels: { app.kubernetes.io/part-of: pneuma-space } }
//   ---
//   apiVersion: rbac.authorization.k8s.io/v1
//   kind: Role
//   metadata: { name: pneuma-space-smoke, namespace: pneuma-space-apps, labels: { app.kubernetes.io/part-of: pneuma-space } }
//   rules:
//     - { apiGroups: [""], resources: [pods], verbs: [create, get, list, watch, delete] }
//     - { apiGroups: [""], resources: [pods/log], verbs: [get] }
//   ---
//   apiVersion: rbac.authorization.k8s.io/v1
//   kind: RoleBinding
//   metadata: { name: pneuma-space-smoke, namespace: pneuma-space-apps, labels: { app.kubernetes.io/part-of: pneuma-space } }
//   roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: pneuma-space-smoke }
//   subjects: [{ kind: ServiceAccount, name: pneuma-space-smoke, namespace: pneuma-space-apps }]
//
// The context itself needs `create serviceaccounts/token` on that account. PNEUMA_SPACE_TEST_IMAGE overrides the busybox image.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { KubeClient, KubeError, type Pod, type WatchEvent } from './kube.ts';

const context = process.env.PNEUMA_SPACE_TEST_KUBECONTEXT;
const skip = context ? false : 'PNEUMA_SPACE_TEST_KUBECONTEXT is unset; set it to a kubectl context to run the Kubernetes smoke';
const NAMESPACE = 'pneuma-space-apps';
const SELECTOR = 'app.kubernetes.io/part-of=pneuma-space,pneuma-space.role=smoke';
const name = `pneuma-space-smoke-${randomBytes(3).toString('hex')}`;
let kube: KubeClient;

const kubectl = async (...args: string[]): Promise<string> =>
  (await promisify(execFile)('kubectl', ['--context', context!, ...args])).stdout;

async function until(resourceVersion: string, match: (event: WatchEvent<Pod>) => boolean): Promise<WatchEvent<Pod> | undefined> {
  for await (const event of kube.watch('pods', { labelSelector: SELECTOR, resourceVersion, signal: AbortSignal.timeout(120_000) })) {
    if (match(event)) return event;
  }
  return undefined;
}

const ours = (event: WatchEvent<Pod>): event is Extract<WatchEvent<Pod>, { object: Pod }> => event.type !== 'BOOKMARK' && event.object.metadata.name === name;

before(async () => {
  if (!context) return;
  const config = JSON.parse(await kubectl('config', 'view', '--raw', '--minify', '-o', 'json'));
  const cluster = config.clusters[0].cluster;
  const ca = cluster['certificate-authority-data']
    ? Buffer.from(cluster['certificate-authority-data'], 'base64')
    : cluster['certificate-authority'] && (await readFile(cluster['certificate-authority']));
  const token = (await kubectl('-n', NAMESPACE, 'create', 'token', 'pneuma-space-smoke', '--duration=10m')).trim();
  kube = new KubeClient({ server: cluster.server, ca, token: async () => token, namespace: NAMESPACE });
});

after(async () => {
  if (!context) return;
  await kube.delete('pods', name, { gracePeriodSeconds: 0 }).catch((error) => {
    if (!(error instanceof KubeError && error.reason === 'NotFound')) throw error;
  });
});

let listed = '';

test('Pods in pneuma-space-apps are listed with a resourceVersion', { skip }, async () => {
  const list = await kube.list('pods', { labelSelector: SELECTOR });
  assert.ok(Array.isArray(list.items));
  assert.match(list.metadata.resourceVersion, /^\d+$/);
  listed = list.metadata.resourceVersion;
});

test('a created Pod arrives on the watch as ADDED', { skip }, async () => {
  await kube.create('pods', {
    metadata: { name, labels: { 'app.kubernetes.io/part-of': 'pneuma-space', 'pneuma-space.role': 'smoke' } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 0,
      containers: [{ name: 'smoke', image: process.env.PNEUMA_SPACE_TEST_IMAGE ?? 'busybox:1.36', command: ['sh', '-c', 'echo pneuma-space-smoke; sleep 600'] }],
    },
  });
  assert.ok(await until(listed, (event) => ours(event) && event.type === 'ADDED'));
});

test('the running Pod log is read with tailLines', { skip }, async () => {
  const running = await until(listed, (event) => ours(event) && event.object.status?.phase === 'Running');
  assert.ok(running, 'the Pod reached Running within 120 s');
  assert.match(await kube.log(name, { container: 'smoke', tailLines: 10 }), /pneuma-space-smoke/);
});

test('a deleted Pod arrives on the watch as DELETED', { skip }, async () => {
  const current = (await kube.get('pods', name)).metadata.resourceVersion!;
  await kube.delete('pods', name, { gracePeriodSeconds: 0 });
  assert.ok(await until(current, (event) => ours(event) && event.type === 'DELETED'));
});
