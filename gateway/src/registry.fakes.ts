import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { TestContext } from 'node:test';
import { KubeClient } from './kube.ts';
import { KubeInfra } from './kube-infra.ts';
import { PlatformRegistry, type RegistryDeps } from './registry.ts';
import { SqliteStore } from './store.ts';
import {
  CAPABILITIES, Conflict, NotFound,
  type AppId, type BundleId, type BundleIndex, type BundleStore, type CapabilityProvider, type Guard, type Home, type ImageId, type Infra, type Lease,
  type ProviderName, type Quarantine, type Resource, type ResourceKind, type Runtime, type Store,
} from './model.ts';

export type Call = readonly [verb: 'ensure' | 'suspend' | 'destroy', provider: ProviderName, app: AppId];

/** Records every provider call; `fail` makes the named verb throw once; destroy refuses while `inUse` holds the app, like a volume a container mounts. */
export class FakeProvider implements CapabilityProvider {
  readonly kind: ResourceKind;
  readonly name: ProviderName;
  readonly service = null;
  readonly calls: Call[];
  readonly inUse: ReadonlySet<AppId>;
  fail: Call[0] | null = null;

  constructor(kind: ResourceKind, name: ProviderName, calls: Call[], inUse: ReadonlySet<AppId>) {
    this.kind = kind;
    this.name = name;
    this.calls = calls;
    this.inUse = inUse;
  }

  #record(verb: Call[0], app: AppId): void {
    this.calls.push([verb, this.name, app]);
    if (this.fail === verb) {
      this.fail = null;
      throw new Error(`${this.name} ${verb} failed`);
    }
  }

  async ensure(app: AppId, current: Resource | null): Promise<Resource> {
    this.#record('ensure', app);
    return current ?? { name: `${this.name}-${app}-${randomUUID()}`, password: `secret-${randomUUID()}` };
  }

  inject(_app: AppId, resource: Resource) {
    return { env: { [`FAKE_${this.name.toUpperCase()}`]: resource.name }, storage: [] };
  }

  location(resource: Resource) {
    return { name: resource.name! };
  }

  async suspend(app: AppId): Promise<void> {
    this.#record('suspend', app);
  }

  async destroy(app: AppId): Promise<void> {
    this.#record('destroy', app);
    if (this.inUse.has(app)) throw new Conflict(`${this.name} of ${app} is still used by a container`);
  }
}

/**
 * Images are resolved from a fixed table; counts every call so tests can prove listing makes none besides `state`.
 * `containers` are the apps with a container; until `reconcile` after a restart, retire does not know them.
 */
export class FakeRuntime implements Runtime, Infra, Guard {
  readonly kind = 'container';
  readonly quarantined = new Map<AppId, Quarantine>();
  readonly images = new Map<string, ImageId>([['example:1', 'sha256:one' as ImageId], ['example:2', 'sha256:two' as ImageId]]);
  readonly calls: string[] = [];
  readonly containers = new Set<AppId>();
  reconciled = true;
  async acquire(app: AppId): Promise<Lease> {
    this.calls.push(`acquire ${app}`);
    return { app, address: 'fake:8000' };
  }
  release(): void {}
  channel(): void {}
  async retire(app: AppId): Promise<void> {
    this.calls.push(`retire ${app}`);
    if (this.reconciled) this.containers.delete(app);
  }
  async kill(app: AppId): Promise<void> { this.calls.push(`kill ${app}`); }
  async reconcile(): Promise<void> { this.reconciled = true; }
  async logs(app: AppId, tail: number): Promise<string> { return `last ${tail} lines of ${app}\n`; }
  state(): 'none' { return 'none'; }
  since(): null { return null; }
  leases() { return { request: 0, channel: 0, trigger: 0 }; }
  sleepsAt(): null { return null; }
  health() { return []; }
  async destroyStorage(): Promise<void> {}
  quarantine(app: AppId): Quarantine | null { return this.quarantined.get(app) ?? null; }
  unquarantine(app: AppId): void { this.quarantined.delete(app); }
  async nodes(): Promise<null> { return null; }
  async workloads() { return []; }
  async volumes() { return []; }
  async warnings() { return []; }
  async scale(name: string, replicas: number): Promise<void> { this.calls.push(`scale ${name} ${replicas}`); }
  removedBy(): null { return null; }
  /** What `homes` answers, as instance rows would. */
  homed: Home[] = [];
  async homes(): Promise<Home[]> { return this.homed; }
  async deletePod(name: string): Promise<void> { this.calls.push(`deletePod ${name}`); }
  async resolveImage(reference: string): Promise<ImageId | null> {
    this.calls.push(`resolveImage ${reference}`);
    return this.images.get(reference) ?? null;
  }
}

export class FakeBundles implements BundleStore {
  readonly stored = new Set<BundleId>();
  async put(tar: Readable): Promise<BundleId> {
    const hash = createHash('sha256');
    for await (const chunk of tar) hash.update(chunk as Buffer);
    const id = hash.digest('hex') as BundleId;
    this.stored.add(id);
    return id;
  }
  async index(id: BundleId): Promise<BundleIndex> {
    if (!this.stored.has(id)) throw new NotFound(`bundle ${id} not found`);
    return { id, files: { 'index.html': { size: 5, etag: '"x"', contentType: 'text/html' } } };
  }
  async open(): Promise<never> { throw new Error('not used'); }
  async delete(id: BundleId): Promise<void> {
    this.stored.delete(id);
  }
}

export type World = {
  readonly dir: string;
  readonly calls: Call[];
  readonly providers: Map<ProviderName, FakeProvider>;
  readonly runtime: FakeRuntime;
  readonly bundles: FakeBundles;
  /** Compose services the registry's probe finds; none by default. */
  readonly services: Set<string>;
  /** Closes the last store and opens a fresh store and registry over the same file, as a gateway restart would. */
  open(deps?: Partial<RegistryDeps>): Promise<{ store: SqliteStore; registry: PlatformRegistry }>;
  /** Another replica's registry over `store`, with the same backends behind it. */
  replica(store: Store, deps?: Partial<RegistryDeps>): Promise<PlatformRegistry>;
};

const temporary: string[] = [];
process.once('exit', () => temporary.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

export function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-registry-'));
  temporary.push(dir);
  const calls: Call[] = [];
  const runtime = new FakeRuntime();
  const providers = new Map<ProviderName, FakeProvider>();
  for (const [kind, spec] of Object.entries(CAPABILITIES)) {
    for (const name of spec.providers) providers.set(name, new FakeProvider(kind as ResourceKind, name, calls, runtime.containers));
  }
  const bundles = new FakeBundles();
  const services = new Set<string>();
  let previous: SqliteStore | null = null;
  const replica = (store: Store, deps: Partial<RegistryDeps> = {}) => PlatformRegistry.open({
    store, runtime, guard: runtime, infra: runtime, bundles, providers: [...providers.values()], probe: async (service) => services.has(service), ...deps,
  });
  return {
    dir, calls, providers, runtime, bundles, services, replica,
    async open(deps) {
      await previous?.close();
      const store = (previous = new SqliteStore(join(dir, 'pneuma-space.sqlite3')));
      return { store, registry: await replica(store, deps) };
    },
  };
}

/** KubeInfra over a platform namespace whose Deployments and StatefulSets hold `replicas`, which a scale patch changes; records every request as `METHOD path`. */
export async function fakeKubernetes(t: TestContext, replicas: Record<string, number>) {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push(`${req.method} ${req.url}`);
    const scaled = /\/(?:deployments|statefulsets)\/([^/]+)\/scale$/.exec(req.url ?? '');
    if (req.method === 'PATCH' && scaled) replicas[scaled[1]!] = (JSON.parse(body) as { spec: { replicas: number } }).spec.replicas;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const kube = new KubeClient({ server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: async () => 't', namespace: 'pneuma-space' });
  return { seen, replicas, infra: new KubeInfra({ platform: kube, apps: kube, registry: null, registryApi: null, authFile: null }) };
}
