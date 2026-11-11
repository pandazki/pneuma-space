// AC-OPS-11, 12, 14, 15 and 16 against a platform deployed on the cluster of PNEUMA_SPACE_TEST_KUBECONTEXT (see kube.harness.ts), through its admin API
// at PNEUMA_SPACE_TEST_ADMIN_URL (default http://127.0.0.1:38081, the port-forward of deploy/kubernetes/README.md, "Local cluster"). PNEUMA_SPACE_TEST_IDENTITY_HEADER carries
// PNEUMA_SPACE_TEST_ADMIN_JWT, a platform admin, or PNEUMA_SPACE_TEST_TENANT_JWT, an admin of PNEUMA_SPACE_TEST_TENANT (default `default`) only.
// PNEUMA_SPACE_TEST_APP_IMAGE is an image the platform resolves that listens on 8000; PNEUMA_SPACE_TEST_STUCK_IMAGE, one that never does, enables
// AC-OPS-15. Drain stops every instance on the node, the test's and any other.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { kubectl, NAMESPACE, skip } from './kube.harness.ts';
import { ADMIN_PATHS, type AuditRecord, type ClusterView, type Release } from './model.ts';

const env = process.env;
const ADMIN = env.PNEUMA_SPACE_TEST_ADMIN_URL ?? 'http://127.0.0.1:38081';
const TENANT = env.PNEUMA_SPACE_TEST_TENANT ?? 'default';
const PLATFORM = 'pneuma-space';
const RUNNER = 'pneuma-space-runner';
/** The sampler's period plus a margin: how long a change takes to show in GET /api/cluster. */
const SAMPLED_MS = 20_000;
const tag = randomBytes(3).toString('hex');
const created: string[] = [];

type Answer = { readonly status: number; readonly body: any };

const credentials = (as: 'admin' | 'tenant') => ({
  [env.PNEUMA_SPACE_TEST_IDENTITY_HEADER ?? '']: (as === 'admin' ? env.PNEUMA_SPACE_TEST_ADMIN_JWT : env.PNEUMA_SPACE_TEST_TENANT_JWT) ?? '', 'sec-fetch-site': 'same-origin',
});

async function api(as: 'admin' | 'tenant', method: string, path: string, body?: unknown): Promise<Answer> {
  const res = await fetch(ADMIN + path, { method, headers: credentials(as), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function ok(as: 'admin' | 'tenant', method: string, path: string, body?: unknown): Promise<any> {
  const answer = await api(as, method, path, body);
  assert.equal(answer.status, 200, `${method} ${path}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms: number): Promise<T> {
  for (const end = Date.now() + ms; ; await sleep(1000)) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

const cluster = (): Promise<ClusterView> => ok('admin', 'GET', ADMIN_PATHS.cluster);
const state = async (name: string): Promise<string> => (await ok('admin', 'GET', ADMIN_PATHS.app(name))).instance;
const podUid = async (app: string): Promise<string | null> =>
  (await kubectl('-n', NAMESPACE, 'get', 'pod', `pneuma-space-${app}`, '--ignore-not-found', '-o', 'jsonpath={.metadata.uid}')).trim() || null;
const audited = async (action: string, target: string): Promise<AuditRecord[]> => ok('admin', 'GET', `${ADMIN_PATHS.audit}?action=${action}&target=${target}`);

/** Publishes an app with a files binding, so it has a claim; the afterEach hook removes and purges it, so a later row's quota does not carry it. */
async function publish(prefix: string, image = env.PNEUMA_SPACE_TEST_APP_IMAGE): Promise<{ name: string; id: string }> {
  const name = `${prefix}-${tag}`;
  created.push(name);
  const release: Release = await ok('admin', 'PUT', ADMIN_PATHS.release(name), { image, manifest: { contract: 1, capabilities: { files: {} } }, tenant: TENANT });
  return { name, id: release.app };
}

const ISOLATE = new URL('../../tests/acceptance/fixtures/isolate/', import.meta.url);

/** Uploads the acceptance suite's isolate app, which declares files and db, as a code bundle and publishes it; the afterEach hook purges it. */
async function publishIsolate(prefix: string): Promise<string> {
  const name = `${prefix}-${tag}`;
  created.push(name);
  const tar = execFileSync('tar', ['--format', 'ustar', '-cf', '-', '-C', fileURLToPath(ISOLATE), '.'], { env: { ...env, COPYFILE_DISABLE: '1' } });
  const upload = await fetch(ADMIN + ADMIN_PATHS.bundles, { method: 'POST', headers: credentials('admin'), body: tar });
  const uploaded = await upload.json();
  assert.equal(upload.status, 200, JSON.stringify(uploaded));
  const manifest = JSON.parse(readFileSync(new URL('pneuma-space.json', ISOLATE), 'utf8'));
  await ok('admin', 'PUT', ADMIN_PATHS.release(name), { image: null, manifest, bundle: uploaded.bundle, tenant: TENANT });
  return name;
}

const wake = (name: string) => ok('admin', 'POST', ADMIN_PATHS.restart(name));

afterEach(async () => {
  if (skip) return;
  for (const name of created.splice(0)) {
    await api('admin', 'POST', ADMIN_PATHS.remove(name));
    await api('admin', 'POST', ADMIN_PATHS.purge(name));
  }
});

test('AC-OPS-11: the cluster view lists nodes, the gateway and runner with the leader marked, the awake instance and its claim; a tenant admin gets 403', { skip }, async () => {
  const app = await publish('ops11');
  await wake(app.name);
  const view = await until('the instance and its claim in the view', async () => {
    const v = await cluster();
    return v.instances.some((i) => i.app === app.name) && v.volumes.some((v) => v.app === app.name) ? v : null;
  }, SAMPLED_MS);
  assert.equal(view.plane, 'kubernetes');
  assert.ok(view.nodes.length > 0 && view.nodes.every((n) => n.allocatable.cpuMillis > 0), 'every node with its allocatable');
  assert.deepEqual(view.workloads.filter((w) => w.scalable).map((w) => [w.name, w.kind]), [['pneuma-space-gateway', 'Deployment'], [RUNNER, 'StatefulSet']]);
  assert.equal(view.workloads.flatMap((w) => w.pods).filter((p) => p.leading).length, 1);
  const row = view.instances.find((i) => i.app === app.name)!;
  assert.deepEqual([row.tenant, row.pod, typeof row.node], [TENANT, `pneuma-space-${app.id}`, 'string']);
  assert.ok(Array.isArray(view.warnings));
  assert.equal((await api('tenant', 'GET', ADMIN_PATHS.cluster)).status, 403);
});

test('AC-OPS-12: the runner scales up and serves a wake on the new replica; scaling back is refused naming that app until it is purged, then keeps the removed replica\'s claim; bad counts are 400, postgres is 409, the audit has the counts', { skip }, async () => {
  const runner = async () => (await cluster()).workloads.find((w) => w.name === RUNNER)!;
  const before = (await runner()).desired;
  const added = `${RUNNER}-${before}`;
  await ok('admin', 'PUT', ADMIN_PATHS.scale(RUNNER), { replicas: before + 1 });
  await until(`${before + 1} ready runners`, async () => ((await runner()).ready === before + 1 ? true : null), 60_000 + SAMPLED_MS);
  // A first wake picks the ready runner with the fewest awake workers, ties by name, so one of before + 1 apps kept awake lands on the new one.
  let homed: string | null = null;
  for (let i = 0; i <= before && homed === null; i++) {
    const name = await publishIsolate(`ops12-${i}`);
    await ok('admin', 'PUT', ADMIN_PATHS.appPolicy(name), { idle_seconds: 600 });
    await wake(name);
    const pod = await until(`the runner of ${name} in the view`, async () => (await cluster()).instances.find((x) => x.app === name)?.pod ?? null, SAMPLED_MS);
    if (pod === added) homed = name;
  }
  assert.ok(homed, `an isolate wake on ${added}`);
  const desired = async () => Number((await kubectl('-n', PLATFORM, 'get', 'statefulset', RUNNER, '-o', 'jsonpath={.spec.replicas}')).trim());
  const stranded = await api('admin', 'PUT', ADMIN_PATHS.scale(RUNNER), { replicas: before });
  assert.equal(stranded.status, 409, JSON.stringify(stranded.body));
  assert.ok(stranded.body.stranded.homes.some((h: { app: string; home: string }) => h.app === homed && h.home === added), JSON.stringify(stranded.body));
  assert.equal(await desired(), before + 1);
  await ok('admin', 'POST', ADMIN_PATHS.remove(homed));
  await ok('admin', 'POST', ADMIN_PATHS.purge(homed));
  await ok('admin', 'PUT', ADMIN_PATHS.scale(RUNNER), { replicas: before });
  await until(`${before} runners`, async () => ((await runner()).pods.length === before ? true : null), 60_000 + SAMPLED_MS);
  const claim = `data-${added}`;
  assert.equal((await kubectl('-n', PLATFORM, 'get', 'pvc', claim, '-o', 'jsonpath={.metadata.name}')).trim(), claim);
  const refused = await Promise.all([
    api('admin', 'PUT', ADMIN_PATHS.scale(RUNNER), { replicas: 0 }),
    api('admin', 'PUT', ADMIN_PATHS.scale(RUNNER), { replicas: 10_000 }),
    api('admin', 'PUT', ADMIN_PATHS.scale('pneuma-space-postgres'), { replicas: 2 }),
  ]);
  assert.deepEqual(refused.map((r) => r.status), [400, 400, 409]);
  const rows = (await audited('cluster.scale', RUNNER)).map((r) => [r.result, r.details.replicas]);
  for (const row of [['ok', before + 1], ['refused', before], ['ok', before]]) assert.ok(rows.some(([result, n]) => result === row[0] && n === row[1]), `${row} in ${JSON.stringify(rows)}`);
});

test('AC-OPS-14: stop leaves the app asleep with no Pod, the tenant admin may stop it, and restart wakes it under a new Pod', { skip }, async () => {
  const app = await publish('ops14');
  await wake(app.name);
  const first = await podUid(app.id);
  await ok('tenant', 'POST', ADMIN_PATHS.stop(app.name));
  assert.deepEqual([await state(app.name), await podUid(app.id)], ['asleep', null]);
  await ok('admin', 'POST', ADMIN_PATHS.restart(app.name));
  const second = await podUid(app.id);
  assert.equal(await state(app.name), 'awake');
  assert.ok(second !== null && second !== first, 'a new Pod');
});

const stuck = env.PNEUMA_SPACE_TEST_STUCK_IMAGE ? skip : 'PNEUMA_SPACE_TEST_STUCK_IMAGE is unset';

test('AC-OPS-15: kill ends a wake stuck on a Pod that never gets ready: the Pod goes, the row is asleep, a tenant admin gets 403, the audit lists it', { skip: stuck }, async () => {
  const app = await publish('ops15', env.PNEUMA_SPACE_TEST_STUCK_IMAGE);
  await ok('admin', 'PUT', ADMIN_PATHS.appPolicy(app.name), { ready_timeout_seconds: 600 });
  const waking = api('admin', 'POST', ADMIN_PATHS.restart(app.name));
  await until('the stuck wake and its Pod', async () => ((await state(app.name)) === 'waking' && (await podUid(app.id)) ? true : null), 60_000);
  assert.equal((await api('tenant', 'POST', ADMIN_PATHS.kill(app.name))).status, 403);
  await ok('admin', 'POST', ADMIN_PATHS.kill(app.name));
  assert.equal(await state(app.name), 'asleep');
  await until('the Pod gone', async () => ((await podUid(app.id)) === null ? true : null), 10_000);
  await waking;
  assert.ok((await audited('app.kill', app.name)).some((r) => r.result === 'ok'));
});

test('AC-OPS-16: draining a node stops its instances only, and leaves the node schedulable flag and its platform Pods as they were', { skip }, async () => {
  const apps = [await publish('ops16a'), await publish('ops16b'), await publish('ops16c')];
  for (const app of apps) await wake(app.name);
  const view = await until('the three instances in the view', async () => {
    const v = await cluster();
    return apps.every((a) => v.instances.some((i) => i.app === a.name && i.node)) ? v : null;
  }, SAMPLED_MS);
  const nodeOf = (name: string) => view.instances.find((i) => i.app === name)!.node!;
  const node = nodeOf(apps[0]!.name);
  const platformPods = async () => (await kubectl('-n', PLATFORM, 'get', 'pods', '--field-selector', `spec.nodeName=${node}`, '-o', 'jsonpath={.items[*].metadata.uid}')).trim();
  const schedulable = () => kubectl('get', 'node', node, '-o', 'jsonpath={.spec.unschedulable}');
  const [pods, flag] = [await platformPods(), await schedulable()];
  const drained = await ok('admin', 'POST', ADMIN_PATHS.drain(node));
  assert.deepEqual(drained.failed, []);
  for (const app of apps) assert.equal(await state(app.name), nodeOf(app.name) === node ? 'asleep' : 'awake', app.name);
  assert.deepEqual([await platformPods(), await schedulable()], [pods, flag]);
});
