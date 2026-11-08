// See kube.harness.ts. The instance runs PNEUMA_SPACE_TEST_APP_IMAGE (default traefik/whoami:v1.10, told to listen on 8000 by
// WHOAMI_PORT_NUMBER) as ServiceAccount `pneuma-space-app` from deploy/kubernetes/10-rbac.yaml, with one claim of the cluster's
// default storage class. The TCP probe dials the Pod IP from this host; where Pod IPs do not route here, set
// PNEUMA_SPACE_TEST_POD_ROUTABLE=0 and the probe is skipped.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { context, skip, smokeClient } from './kube.harness.ts';
import { KubeError, type KubeClient } from './kube.ts';
import { appName, DEFAULT_POLICY, DEFAULT_TENANT, type AppId, type ImageId, type InstanceLog, type ReleaseNumber, type RunSpec } from './model.ts';
import { podConfig, PodDriver, podName } from './pods.ts';
import { canConnect } from './runtime.ts';

const app = randomBytes(6).toString('hex') as AppId;
const claim = `pneuma-space-files-${app}`;
const spec = {
  app, name: appName(`smoke-${app}`), tenant: DEFAULT_TENANT, release: 1 as ReleaseNumber,
  runtime: { kind: 'container', image: (process.env.PNEUMA_SPACE_TEST_APP_IMAGE ?? 'traefik/whoami:v1.10') as ImageId },
  injection: { env: { WHOAMI_PORT_NUMBER: '8000' }, storage: [{ id: claim, target: '/data', env: {} }], services: [] },
  policy: { ...DEFAULT_POLICY, ready_timeout_seconds: 60 },
  version: 1,
} satisfies RunSpec;
const slot = { handle: null as string | null, release: spec.release, specHash: '', epoch: 1 };
const saved: InstanceLog[] = [];
const stop = new AbortController();
let kube: KubeClient;
let driver: PodDriver;

const missing = (error: unknown) => {
  if (!(error instanceof KubeError && error.status === 404)) throw error;
};

before(async () => {
  if (!context) return;
  kube = await smokeClient();
  driver = new PodDriver({
    kube, config: podConfig({ PNEUMA_SPACE_K8S_PENDING_SECONDS: '180' }), policyOf: () => spec.policy,
    store: { instanceLog: async () => saved.at(-1) ?? null, putInstanceLog: async (log) => void saved.push(log) },
    connect: process.env.PNEUMA_SPACE_TEST_POD_ROUTABLE === '0' ? async () => true : canConnect,
  });
  driver.follow(() => {}, stop.signal);
});

after(async () => {
  stop.abort();
  if (!context) return;
  await kube.delete('pods', podName(app), { gracePeriodSeconds: 0 }).catch(missing);
  await kube.delete('persistentvolumeclaims', claim).catch(missing);
});

test('start creates the claim and the Pod and resolves with the Pod IP once it accepts TCP', { skip }, async () => {
  assert.match(await driver.start(slot, spec), /^[\d.:a-f]+:8000$/);
  assert.equal((await kube.get('pods', podName(app))).metadata.uid, slot.handle);
});

test('logs reads the running Pod', { skip }, async () => {
  assert.notEqual(await driver.logs(app, slot.handle, 20), '');
});

test('sleep keeps the log tail and deletes the Pod, and the claim stays', { skip }, async () => {
  await driver.sleep(app, slot);
  assert.equal(slot.handle, null);
  assert.equal(saved.at(-1)?.reason, 'sleep');
  await assert.rejects(kube.get('pods', podName(app)), (error) => error instanceof KubeError && error.status === 404);
  assert.equal((await kube.get('persistentvolumeclaims', claim)).metadata.name, claim);
});

test('destroyStorage deletes the claim and resolves once it is gone', { skip }, async () => {
  await driver.destroyStorage(app, claim);
  await assert.rejects(kube.get('persistentvolumeclaims', claim), (error) => error instanceof KubeError && error.status === 404);
});
