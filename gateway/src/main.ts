import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseAppsOrigin } from './address.ts';
import { startAdmin } from './admin.ts';
import { Docker } from './docker.ts';
import { emit, events } from './events.ts';
import { Instances } from './instances.ts';
import { Authority, parsePlatformAdmins } from './authz.ts';
import { loadOrCreateSecret, LocalIdentity, parseIdentityEnv, UpstreamIdentity, type Identity } from './identity.ts';
import { JwtVerifier } from './jwt.ts';
import { Ingress } from './ingress.ts';
import { hostSample, httpProbe, Metrics, profileProbe, tcpProbe } from './metrics.ts';
import { ADMIN_PORT, INGRESS_PORT, RUNTIMES, type AppId, type ReplicaId } from './model.ts';
import { composeProject, DockerInfra } from './infra.ts';
import { inClusterClient } from './kube.ts';
import { KubeInfra } from './kube-infra.ts';
import { planeOf, podConfig, PodRuntime } from './pods.ts';
import { createProviders, providerConfig, S3BundleStore } from './providers.ts';
import { PlatformRegistry } from './registry.ts';
import { IsolateRuntime, RUNNER_PORT } from './isolate.ts';
import { DockerRuntime } from './runtime.ts';
import { AppGuard, Runtimes } from './runtimes.ts';
import { requests } from './requests.ts';
import { DeliveryScheduler } from './scheduler.ts';
import { PgStore } from './store-pg.ts';
import { SqliteStore } from './store.ts';

const SAMPLE_MS = 10_000;

const log = (ev: string, extra: Record<string, unknown> = {}) => emit(ev, null, extra);

const setup = (() => {
  try {
    const pods = planeOf(process.env) === 'kubernetes' ? podConfig(process.env) : null;
    const identity = parseIdentityEnv(process.env);
    const admins = parsePlatformAdmins(process.env.PNEUMA_SPACE_PLATFORM_ADMINS);
    const upstream = identity.kind === 'upstream' ? { ...identity.options, verifier: new JwtVerifier(identity.jwt), audiences: identity.jwt.audiences } : null;
    const consoleIdentity = identity.kind === 'upstream' && upstream ? { ...upstream, audiences: identity.consoleAudiences } : null;
    return { pods, admins, upstream, consoleIdentity, addressing: parseAppsOrigin(process.env.PNEUMA_SPACE_APPS_ORIGIN) };
  } catch (error) {
    console.error(`pneuma-space: ${(error as Error).message}`);
    process.exit(1);
  }
})();

const data = process.env.PNEUMA_SPACE_DATA ?? '/data';
const network = process.env.PNEUMA_SPACE_NETWORK ?? 'pneuma-space';
// The host port compose publishes the ingress on; the console links to apps through it.
const ingressPort = Number(process.env.PNEUMA_SPACE_HTTP_PORT ?? INGRESS_PORT);
const config = providerConfig(process.env);
const replica = (process.env.PNEUMA_SPACE_REPLICA ?? hostname()) as ReplicaId;

const storeUrl = process.env.PNEUMA_SPACE_STORE_URL;
const store = storeUrl
  ? await PgStore.open(storeUrl, {
    commands: Number(process.env.PNEUMA_SPACE_STORE_COMMANDS ?? 4), testRetry: process.env.PNEUMA_SPACE_STORE_TEST_RETRY === '1', volumeGb: config.volumeGb,
  })
  : new SqliteStore(join(data, 'pneuma-space.sqlite3'), { volumeGb: config.volumeGb });
const instances = new Instances(store, { replica });
await instances.ready();
await instances.start();
const specFor = (app: AppId) => registry.runSpec(app);
const guard = new AppGuard({ instances, specFor });
// The plane swaps the container driver and Infra; everything else is shared (ADR 0019 item 1).
const { infra, container } = setup.pods
  ? {
    infra: new KubeInfra({ registry: process.env.PNEUMA_SPACE_REGISTRY?.trim() || null, authFile: process.env.PNEUMA_SPACE_REGISTRY_AUTH?.trim() || null }),
    container: new PodRuntime({ kube: await inClusterClient('pneuma-space-apps'), config: setup.pods, specFor, instances, guard }),
  }
  : await (async () => {
    const docker = new Docker();
    return { infra: new DockerInfra(docker, await composeProject(docker)), container: new DockerRuntime({ docker, network, specFor, instances, guard }) };
  })();
const bundles = new S3BundleStore(config.object);
const isolate = new IsolateRuntime({
  runner: `http://${RUNTIMES.isolate.service}:${RUNNER_PORT}`, bundleUrl: (id) => bundles.presignTar(id), specFor,
  hasRun: async (app) => (await store.releases(app)).some((release) => release.runtime === 'isolate'), instances, guard,
});
const runtime = new Runtimes({ runtimes: [container, isolate], specFor, instances });
const registry = await PlatformRegistry.open({
  store, runtime, guard, infra, bundles, providers: Object.values(createProviders(infra, runtime, config)), statsSource: async () => metrics.stats(),
  addressing: setup.addressing, volumeGb: config.volumeGb,
});
const scheduler = new DeliveryScheduler({ store, runtime, view: (app) => registry.schedule(app), replica });
const authority = new Authority(store, setup.admins);
const identity: Identity = setup.upstream
  ? new UpstreamIdentity(setup.upstream, authority, registry)
  : new LocalIdentity(loadOrCreateSecret(join(data, 'pneuma-space.secret')), authority);
const ingress = new Ingress({
  registry, runtime, identity, authority, addressing: setup.addressing, bundles, scheduler,
  upstream: setup.upstream && { header: setup.upstream.header, stripCookies: setup.upstream.stripCookies }, stats: await store.stats(), flushStats: (stats) => store.putStats(stats), deleteStats: (app) => store.deleteStats(app),
});

const metrics = new Metrics({
  events,
  stats: () => ingress.snapshot(),
  apps: () => registry.listing(),
  deliveries: { counts: () => store.deliveryCounts(), failed: (limit) => store.deliveries({ state: 'failed', limit }) },
  nameOf: (app) => registry.nameOf(app),
  probes: {
    redis: tcpProbe('redis', 6379),
    object: httpProbe(`${config.object.endpoint}/health`),
    postgres: profileProbe('postgres', 5432),
    coturn: profileProbe('coturn', 3478),
    runner: profileProbe('runner', RUNNER_PORT),
  },
  host: () => hostSample(data),
  usage: store,
  policy: () => registry.policy(),
  view: (name) => registry.view(name),
  replica,
  leader: () => instances.leading,
});

process.on('unhandledRejection', (error) => log('unhandled-rejection', { error: String(error) }));

registry.onAppChanged((app) => {
  runtime.retire(app).catch((error: Error) => log('retire-failed', { app, error: error.message }));
  scheduler.reload(app).catch((error: Error) => log('reload-failed', { app, error: error.message }));
  if (registry.schedule(app) === null) ingress.forget(app).catch((error: Error) => log('forget-failed', { app, error: error.message }));
});

// Reconcile first so a resumed purge retires the containers it finds; Providers converge in the background (DESIGN 2.3).
await runtime.reconcile();
await instances.onLeader((leading) => {
  log('leader', { replica, leading });
  if (!leading) return scheduler.stop();
  void registry.resume();
  return scheduler.resume();
});
await ingress.listen(INGRESS_PORT, '0.0.0.0');
// The console audience keeps a JWT leaked from an app request from replaying on the admin API (ADR 0021 item 1).
const upstream = setup.consoleIdentity ? { identity: new UpstreamIdentity(setup.consoleIdentity, authority, registry), authority } : undefined;
const admin = await startAdmin({ registry, bundles, runtime, guard, metrics, requests, store, ingressPort, upstream }, { port: ADMIN_PORT, host: '0.0.0.0' });
const sample = () => metrics.sample().catch((error: Error) => log('sample-failed', { error: error.message }));
const flusher = setInterval(() => {
  ingress.flush().catch((error: Error) => log('flush-failed', { error: error.message }));
  void sample();
}, SAMPLE_MS);
void sample();
log('gateway-ready', { network, data, replica, store: storeUrl ? 'postgres' : 'sqlite' });

process.once('SIGTERM', async () => {
  clearInterval(flusher);
  scheduler.stop();
  container.close();
  isolate.close();
  admin.closeAllConnections();
  await Promise.all([ingress.close(), new Promise((resolve) => admin.close(resolve))]);
  await ingress.flush();
  await instances.close();
  await store.close();
  log('gateway-stopped');
  process.exit(0);
});
