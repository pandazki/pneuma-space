// See kube.harness.ts. PNEUMA_SPACE_TEST_IMAGE overrides the busybox image.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { context, skip, smokeClient } from './kube.harness.ts';
import { KubeError, type KubeClient, type Pod, type WatchEvent } from './kube.ts';

const SELECTOR = 'app.kubernetes.io/part-of=pneuma-space,pneuma-space.role=smoke';
const name = `pneuma-space-smoke-${randomBytes(3).toString('hex')}`;
let kube: KubeClient;

async function until(resourceVersion: string, match: (event: WatchEvent<Pod>) => boolean): Promise<WatchEvent<Pod> | undefined> {
  for await (const event of kube.watch('pods', { labelSelector: SELECTOR, from: { metadata: { resourceVersion }, items: [] }, signal: AbortSignal.timeout(120_000) })) {
    if (match(event)) return event;
  }
  return undefined;
}

const ours = (event: WatchEvent<Pod>): event is Extract<WatchEvent<Pod>, { object: Pod }> => event.type !== 'BOOKMARK' && event.object.metadata.name === name;

before(async () => {
  if (context) kube = await smokeClient();
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
