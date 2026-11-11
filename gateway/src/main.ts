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
import { hostSample, httpProbe, Metrics, networkProbe, profileProbe, serveMetrics, Series, tcpProbe, untilUp, type Probe, type ServiceName } from './metrics.ts';
import { ADMIN_PORT, INGRESS_PORT, RUNTIMES, type AppId, type ReplicaId, type VolumeSample } from './model.ts';
import { DockerInfra } from './infra.ts';
import { inClusterClient } from './kube.ts';
import { NodeView, type RunnerHealth } from './nodes.ts';
import { KubeInfra } from './kube-infra.ts';
import { planeOf, podConfig, PodRuntime } from './pods.ts';
import { createProviders, providerConfig, resolvesOnNetwork, S3BundleStore } from './providers.ts';
import { PlatformRegistry } from './registry.ts';
import { IsolateRuntime, RUNNER_PORT, StatefulSetPool, StaticPool } from './isolate.ts';
import { canConnect, DockerRuntime } from './runtime.ts';
import { AppGuard, Runtimes } from './runtimes.ts';
import { requests } from './requests.ts';
import { DeliveryScheduler } from './scheduler.ts';
import { parsePgUrl } from './pg.ts';
import { PgStore } from './store-pg.ts';
import { SqliteStore } from './store.ts';

const SAMPLE_MS = 10_000;
const NODES_MS = 15_000;
const RUNNER_HEALTH_MS = 1000;

const log = (ev: string, extra: Record<string, unknown> = {}) => emit(ev, null, extra);

const setup = (() => {
  try {
    const pods = planeOf(process.env) === 'kubernetes' ? podConfig(process.env) : null;
    const identity = parseIdentityEnv(process.env);
    const admins = parsePlatformAdmins(process.env.PNEUMA_SPACE_PLATFORM_ADMINS);
    const upstream = identity.kind === 'upstream' ? { ...identity.options, verifier: new JwtVerifier(identity.jwt), audiences: identity.jwt.audiences } : null;
    const consoleIdentity = identity.kind === 'upstream' && upstream ? { ...upstream, audiences: identity.consoleAudiences } : null;
    const scaleMax = Number(process.env.PNEUMA_SPACE_SCALE_MAX || 10);
    if (!Number.isInteger(scaleMax) || scaleMax < 1) throw new Error(`PNEUMA_SPACE_SCALE_MAX must be a whole number of at least 1, got "${process.env.PNEUMA_SPACE_SCALE_MAX}"`);
    return { pods, admins, upstream, consoleIdentity, scaleMax, addressing: parseAppsOrigin(process.env.PNEUMA_SPACE_APPS_ORIGIN) };
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
// A cluster restart starts the platform store with the gateway; its Service routes once pg_isready passes. Wait rather than exit.
if (storeUrl) {
  const { host, port } = parsePgUrl(storeUrl);
  if (!(await untilUp(() => canConnect(host, port), { waiting: () => log('store-wait', { host }) }))) log('store-unready', { host });
}
const store = storeUrl
  ? await PgStore.open(storeUrl, {
    commands: Number(process.env.PNEUMA_SPACE_STORE_COMMANDS ?? 4), testRetry: process.env.PNEUMA_SPACE_STORE_TEST_RETRY === '1', volumeGb: config.volumeGb,
  })
  : new SqliteStore(join(data, 'pneuma-space.sqlite3'), { volumeGb: config.volumeGb });
const series = new Series();
const instances = new Instances(store, { replica });
await instances.ready();
await instances.start();
const specFor = (app: AppId) => registry.runSpec(app);
const guard = new AppGuard({ instances, specFor, series });
const probes: Readonly<Record<ServiceName, Probe>> = {
  redis: setup.pods ? tcpProbe('redis', 6379) : networkProbe('redis', 6379),
  object: httpProbe(`${config.object.endpoint}/health`),
  postgres: setup.pods ? tcpProbe('postgres', config.postgres.port) : profileProbe('postgres', 5432),
  coturn: setup.pods ? tcpProbe('coturn', 3478) : profileProbe('coturn', 3478),
  runner: setup.pods ? async () => ((await runnerUp()) ? 'up' : 'down') : profileProbe('runner', RUNNER_PORT),
};
/** What the state inventory lists as volumes, at the nominal single-host size. */
const volumes = async (): Promise<VolumeSample[]> => (await store.bindings()).flatMap((binding) => {
  const name = providers.find((p) => p.name === binding.provider)?.location(binding.resource).volume;
  return name ? [{ app: binding.app, name, sizeGb: config.volumeGb, storageClass: null, phase: null, node: null }] : [];
});
// The plane swaps the container driver, the runner pool and Infra; everything else is shared (ADR 0019 item 1).
const { infra, container, pool } = setup.pods
  ? await (async (pods) => {
    const apps = await inClusterClient('pneuma-space-apps');
    // The gateway's own namespace is the platform namespace, where the runner StatefulSet runs (ADR 0019 item 3).
    const platform = await inClusterClient();
    return {
      infra: new KubeInfra({
        platform, apps,
        registry: process.env.PNEUMA_SPACE_REGISTRY?.trim() || null,
        registryApi: process.env.PNEUMA_SPACE_REGISTRY_API?.trim() || null,
        authFile: process.env.PNEUMA_SPACE_REGISTRY_AUTH?.trim() || null,
      }),
      container: new PodRuntime({ kube: apps, config: pods, specFor, instances, guard }),
      pool: new StatefulSetPool(platform),
    };
  })(setup.pods)
  : await (async () => {
    const docker = new Docker();
    return {
      infra: new DockerInfra({ docker, probes, volumes }), container: new DockerRuntime({ docker, network, specFor, instances, guard }),
      pool: new StaticPool(`http://${RUNTIMES.isolate.service}:${RUNNER_PORT}`),
    };
  })();
const bundles = new S3BundleStore(config.object, (id, write) => store.exclusiveBundle(id, write));
const isolate = new IsolateRuntime({
  pool, bundleUrl: (id) => bundles.presignTar(id), specFor,
  hasRun: async (app) => (await store.releases(app)).some((release) => release.runtime === 'isolate'), instances, guard,
});
const runtime = new Runtimes({ runtimes: [container, isolate], specFor, instances });
// A Kubernetes Service name resolves whether or not a Pod serves it, so the cluster probes by connecting.
const SERVICE_PORTS = { postgres: config.postgres.port, coturn: 3478 } as const;
const providerProbe = setup.pods ? (service: keyof typeof SERVICE_PORTS) => canConnect(service, SERVICE_PORTS[service]) : resolvesOnNetwork;
// The runner is the pool's business on both planes: a ready runner, not a name that resolves.
const runnerUp = async (): Promise<boolean> => pool.runners().some((r) => r.ready);
const providers = Object.values(createProviders(runtime, config, providerProbe));
// The registry reads each current release's bundle index from the object store. After a host restart Docker starts every
// service on its own restart policy, without depends_on, so the store may not answer yet: wait for it rather than exit.
if (!(await untilUp(() => bundles.answers(), { waiting: () => log('object-wait', { endpoint: config.object.endpoint }) }))) log('object-unready', { endpoint: config.object.endpoint });
const registry = await PlatformRegistry.open({
  store, runtime, guard, infra, bundles, providers, statsSource: async () => metrics.stats(),
  addressing: setup.addressing, volumeGb: config.volumeGb, nodeOf: (app) => nodes.nodeOf(app),
  probe: (service) => (service === RUNTIMES.isolate.service && setup.pods ? runnerUp() : providerProbe(service as 'postgres' | 'coturn')),
});
const scheduler = new DeliveryScheduler({ store, runtime, view: (app) => registry.schedule(app), replica, policy: () => registry.policy() });
const authority = new Authority(store, setup.admins);
const identity: Identity = setup.upstream
  ? new UpstreamIdentity(setup.upstream, authority, registry)
  : new LocalIdentity(loadOrCreateSecret(join(data, 'pneuma-space.secret')), authority, setup.addressing.mode);
const ingress = new Ingress({
  registry, runtime, identity, authority, addressing: setup.addressing, bundles, scheduler,
  upstream: setup.upstream && { header: setup.upstream.header, stripCookies: setup.upstream.stripCookies }, stats: await store.stats(), flushStats: (stats) => store.putStats(stats), deleteStats: (app) => store.deleteStats(app),
  series,
});

const metrics = new Metrics({
  events,
  stats: () => ingress.snapshot(),
  apps: () => registry.listing(),
  deliveries: { counts: () => store.deliveryCounts(), failed: (limit) => store.deliveries({ state: 'failed', limit }) },
  nameOf: (app) => registry.nameOf(app),
  probes,
  host: () => hostSample(data),
  store,
  policy: () => registry.policy(),
  view: (name) => registry.view(name),
  series,
  retries: () => (store instanceof PgStore ? store.retries : 0),
  replica,
  leader: () => instances.leading,
});

const nodes = new NodeView({
  infra,
  apps: () => registry.listing(),
  nameOf: (app) => registry.nameOf(app),
  instances,
  replicas: () => store.replicas(),
  runner: async (host) => {
    const res = await fetch(`http://${host}:${RUNNER_PORT}/health`, { signal: AbortSignal.timeout(RUNNER_HEALTH_MS) }).catch(() => null);
    return res?.ok ? ((await res.json()) as RunnerHealth) : null;
  },
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
const peers = process.env.PNEUMA_SPACE_PEERS
  ? { host: process.env.PNEUMA_SPACE_PEERS, forward: ['authorization', ...(setup.upstream ? [setup.upstream.header] : [])] }
  : undefined;
const admin = await startAdmin({
  registry, bundles, runtime, guard, metrics, nodes, infra, scaleMax: setup.scaleMax, requests, replica, peers, store, ingressPort, upstream, providers,
}, { port: ADMIN_PORT, host: '0.0.0.0' });
const exporter = await serveMetrics(process.env.PNEUMA_SPACE_METRICS_PORT, () => metrics.prometheus());
const sample = () => metrics.sample().catch((error: Error) => log('sample-failed', { error: error.message }));
const flusher = setInterval(() => {
  ingress.flush().catch((error: Error) => log('flush-failed', { error: error.message }));
  void sample();
}, SAMPLE_MS);
void sample();
const sampleNodes = () => nodes.sample().catch((error: Error) => log('nodes-sample-failed', { error: error.message }));
const nodeSampler = setInterval(() => void sampleNodes(), NODES_MS);
void sampleNodes();
log('gateway-ready', { network, data, replica, store: storeUrl ? 'postgres' : 'sqlite' });

process.once('SIGTERM', async () => {
  clearInterval(flusher);
  clearInterval(nodeSampler);
  scheduler.stop();
  container.close();
  isolate.close();
  admin.closeAllConnections();
  exporter?.close();
  exporter?.closeAllConnections();
  await Promise.all([ingress.close(), new Promise((resolve) => admin.close(resolve))]);
  await ingress.flush();
  await instances.close();
  log('gateway-stopped');
  await metrics.flushEvents();
  await store.close();
  process.exit(0);
});
