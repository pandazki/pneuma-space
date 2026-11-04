import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { PlatformRegistry } from './registry.ts';
import { SqliteStore } from './store.ts';
import {
  CAPABILITIES, NotFound,
  type AppId, type BundleId, type BundleIndex, type BundleStore, type CapabilityProvider, type ImageId,
  type ProviderName, type Resource, type ResourceKind, type Runtime,
} from './model.ts';

export type Call = readonly [verb: 'ensure' | 'suspend' | 'destroy', provider: ProviderName, app: AppId];

/** Records every provider call; `fail` makes the named verb throw once. */
export class FakeProvider implements CapabilityProvider {
  readonly kind: ResourceKind;
  readonly name: ProviderName;
  readonly calls: Call[];
  fail: Call[0] | null = null;

  constructor(kind: ResourceKind, name: ProviderName, calls: Call[]) {
    this.kind = kind;
    this.name = name;
    this.calls = calls;
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
    return current ?? { name: `${this.name}-${app}-${randomUUID()}` };
  }

  inject(_app: AppId, resource: Resource) {
    return { env: { [`FAKE_${this.name.toUpperCase()}`]: resource.name }, mounts: [] };
  }

  async suspend(app: AppId): Promise<void> {
    this.#record('suspend', app);
  }

  async destroy(app: AppId): Promise<void> {
    this.#record('destroy', app);
  }
}

/** Images are resolved from a fixed table; counts every call so tests can prove listing makes none besides `state`. */
export class FakeRuntime implements Runtime {
  readonly images = new Map<string, ImageId>([['example:1', 'sha256:one' as ImageId], ['example:2', 'sha256:two' as ImageId]]);
  readonly calls: string[] = [];
  async acquire(): Promise<never> { throw new Error('not used'); }
  release(): void {}
  channel(): void {}
  async retire(app: AppId): Promise<void> { this.calls.push(`retire ${app}`); }
  async reconcile(): Promise<void> {}
  state(): 'none' { return 'none'; }
  async runJob(): Promise<never> { throw new Error('not used'); }
  async resolveImage(reference: string): Promise<ImageId | null> {
    this.calls.push(`resolveImage ${reference}`);
    return this.images.get(reference) ?? null;
  }
  async ensureVolume(): Promise<void> {}
  async removeVolume(): Promise<void> {}
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
  /** Opens a fresh store and registry over the same file, as a gateway restart would. */
  open(): Promise<{ store: SqliteStore; registry: PlatformRegistry }>;
};

const temporary: string[] = [];
process.once('exit', () => temporary.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

export function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-registry-'));
  temporary.push(dir);
  const calls: Call[] = [];
  const providers = new Map<ProviderName, FakeProvider>();
  for (const [kind, spec] of Object.entries(CAPABILITIES)) {
    for (const name of spec.providers) providers.set(name, new FakeProvider(kind as ResourceKind, name, calls));
  }
  const runtime = new FakeRuntime();
  const bundles = new FakeBundles();
  return {
    dir, calls, providers, runtime, bundles,
    async open() {
      const store = new SqliteStore(join(dir, 'pneuma-space.sqlite3'));
      const registry = await PlatformRegistry.open({ store, runtime, bundles, providers: [...providers.values()] });
      return { store, registry };
    },
  };
}
