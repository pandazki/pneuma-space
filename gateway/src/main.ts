import { join } from 'node:path';
import { startAdmin } from './admin.ts';
import { Docker } from './docker.ts';
import { emit, events } from './events.ts';
import { loadOrCreateSecret, LocalIdentity } from './identity.ts';
import { Ingress } from './ingress.ts';
import { hostSample, httpProbe, Metrics, profileProbe, tcpProbe } from './metrics.ts';
import { ADMIN_PORT, INGRESS_PORT } from './model.ts';
import { createProviders, providerConfig, S3BundleStore } from './providers.ts';
import { PlatformRegistry } from './registry.ts';
import { composeProject, DockerRuntime } from './runtime.ts';
import { requests } from './requests.ts';
import { DeliveryScheduler } from './scheduler.ts';
import { SqliteStore } from './store.ts';

const SAMPLE_MS = 10_000;

const log = (ev: string, extra: Record<string, unknown> = {}) => emit(ev, null, extra);

const data = process.env.PNEUMA_SPACE_DATA ?? '/data';
const network = process.env.PNEUMA_SPACE_NETWORK ?? 'pneuma-space';
// The host port compose publishes the ingress on; the console links to apps through it.
const ingressPort = Number(process.env.PNEUMA_SPACE_HTTP_PORT ?? INGRESS_PORT);
const config = providerConfig(process.env);

const store = new SqliteStore(join(data, 'pneuma-space.sqlite3'));
const docker = new Docker();
const runtime = new DockerRuntime({ docker, network, project: await composeProject(docker), specFor: (app) => registry.runSpec(app) });
const bundles = new S3BundleStore(config.object);
const registry = await PlatformRegistry.open({
  store, runtime, bundles, providers: Object.values(createProviders(runtime, config)), statsSource: async () => ingress.snapshot(),
});
const scheduler = new DeliveryScheduler({ store, runtime, view: (app) => registry.schedule(app) });
const identity = new LocalIdentity(loadOrCreateSecret(join(data, 'pneuma-space.secret')), (hash) => store.token(hash));
const ingress = new Ingress({
  registry, runtime, identity, bundles, scheduler, stats: await store.stats(), flushStats: (stats) => store.putStats(stats), deleteStats: (app) => store.deleteStats(app),
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
  },
  host: () => hostSample(data),
});

process.on('unhandledRejection', (error) => log('unhandled-rejection', { error: String(error) }));

registry.onAppChanged((app) => {
  runtime.retire(app).catch((error: Error) => log('retire-failed', { app, error: error.message }));
  scheduler.reload(app).catch((error: Error) => log('reload-failed', { app, error: error.message }));
  if (registry.schedule(app) === null) ingress.forget(app).catch((error: Error) => log('forget-failed', { app, error: error.message }));
});

// Reconcile first so a resumed purge retires the containers it finds; Providers converge in the background (DESIGN 2.3).
await runtime.reconcile();
void registry.resume();
await scheduler.resume();
await ingress.listen(INGRESS_PORT, '0.0.0.0');
const admin = await startAdmin({ registry, bundles, runtime, metrics, requests, ingressPort }, { port: ADMIN_PORT, host: '0.0.0.0' });
const sample = () => metrics.sample().catch((error: Error) => log('sample-failed', { error: error.message }));
const flusher = setInterval(() => {
  ingress.flush().catch((error: Error) => log('flush-failed', { error: error.message }));
  void sample();
}, SAMPLE_MS);
void sample();
log('gateway-ready', { network, data });

process.once('SIGTERM', async () => {
  clearInterval(flusher);
  scheduler.stop();
  runtime.close();
  admin.closeAllConnections();
  await Promise.all([ingress.close(), new Promise((resolve) => admin.close(resolve))]);
  await ingress.flush();
  await store.close();
  log('gateway-stopped');
  process.exit(0);
});
