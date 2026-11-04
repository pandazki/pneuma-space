import { join } from 'node:path';
import { startAdmin } from './admin.ts';
import { Docker } from './docker.ts';
import { loadOrCreateSecret, LocalIdentity } from './identity.ts';
import { Ingress } from './ingress.ts';
import { ADMIN_PORT, INGRESS_PORT } from './model.ts';
import { createProviders, providerConfig, S3BundleStore } from './providers.ts';
import { PlatformRegistry } from './registry.ts';
import { composeProject, DockerRuntime } from './runtime.ts';
import { DeliveryScheduler } from './scheduler.ts';
import { SqliteStore } from './store.ts';

const STATS_FLUSH_MS = 10_000;

const log = (ev: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: Date.now(), ev, app: null, ...extra }));

const data = process.env.PNEUMA_SPACE_DATA ?? '/data';
const network = process.env.PNEUMA_SPACE_NETWORK ?? 'pneuma-space';
const config = providerConfig(process.env);

const store = new SqliteStore(join(data, 'pneuma-space.sqlite3'));
const docker = new Docker();
const runtime = new DockerRuntime({ docker, network, project: await composeProject(docker), specFor: (app) => registry.runSpec(app) });
const bundles = new S3BundleStore(config.object);
const registry = await PlatformRegistry.open({
  store, runtime, bundles, providers: Object.values(createProviders(runtime, config)), statsSource: () => ingress.snapshot(),
});
const scheduler = new DeliveryScheduler({ store, runtime, view: (app) => registry.schedule(app) });
const identity = new LocalIdentity(loadOrCreateSecret(join(data, 'pneuma-space.secret')), (hash) => store.token(hash));
const ingress = new Ingress({
  registry, runtime, identity, bundles, scheduler, stats: store.stats(), flushStats: (stats) => store.putStats(stats), deleteStats: (app) => store.deleteStats(app),
});

registry.onAppChanged((app) => {
  runtime.retire(app).catch((error: Error) => log('retire-failed', { app, error: error.message }));
  scheduler.reload(app);
  if (registry.schedule(app) === null) ingress.forget(app);
});

// Reconcile first so a resumed purge retires the containers it finds; Providers converge in the background (DESIGN 2.3).
await runtime.reconcile();
void registry.resume();
scheduler.resume();
await ingress.listen(INGRESS_PORT, '0.0.0.0');
const admin = await startAdmin({ registry, bundles }, { port: ADMIN_PORT, host: '0.0.0.0' });
const flusher = setInterval(() => ingress.flush(), STATS_FLUSH_MS);
log('gateway-ready', { network, data });

process.once('SIGTERM', async () => {
  clearInterval(flusher);
  scheduler.stop();
  runtime.close();
  admin.closeAllConnections();
  await Promise.all([ingress.close(), new Promise((resolve) => admin.close(resolve))]);
  ingress.flush();
  store.close();
  log('gateway-stopped');
  process.exit(0);
});
