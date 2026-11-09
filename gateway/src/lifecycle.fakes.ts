import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Instances } from './instances.ts';
import { Lifecycle, type Adopted, type Driver, type Ending, type Gone, type Slot } from './lifecycle.ts';
import {
  appName, DEFAULT_POLICY, DEFAULT_TENANT, newAppId,
  type AppId, type HealthCheck, type ImageId, type Policy, type ReleaseNumber, type ReplicaId, type RunSpec, type RuntimeKind,
} from './model.ts';
import { AppGuard } from './runtimes.ts';
import { SqliteStore } from './store.ts';

/** Registers the app a test RunSpec names, so a wake transaction finds its row; SQLite runs it before any later call. */
export function register(store: SqliteStore, spec: RunSpec): void {
  void store.putApp({ name: spec.name, id: spec.app, tenant: spec.tenant, access: 'org', owner: 'user:ann' as never, status: 'registered', current: spec.release, policyOverride: {}, registeredAt: 0, version: 0 });
}

/** Never older than the app row, so a test spec never waits for a Registry refresh. */
export const CURRENT = Number.MAX_SAFE_INTEGER;

export const tempStore = () => new SqliteStore(join(mkdtempSync(join(tmpdir(), 'pneuma-space-lifecycle-')), 'pneuma-space.sqlite3'));

/** A driver whose instances are names: start answers at once unless `failure` is set, and `end` reports an instance gone. */
export class FakeDriver implements Driver<RunSpec, string> {
  readonly kind: RuntimeKind;
  readonly handleKey = 'fake';
  starts = 0;
  readonly removed: string[] = [];
  readonly killed: AppId[] = [];
  readonly discarded: string[] = [];
  failure: Error | null = null;
  serving = true;
  node: string | undefined = undefined;
  adopted: Adopted<string>[] = [];
  #gone: Gone<string> = () => {};

  constructor(kind: RuntimeKind = 'container') {
    this.kind = kind;
  }

  accepts(spec: RunSpec): spec is RunSpec {
    return spec.runtime.kind === this.kind;
  }

  async start(slot: Slot<string>, spec: RunSpec): Promise<string> {
    this.starts++;
    await Promise.resolve();
    if (this.failure) throw this.failure;
    slot.handle = `${spec.app}-${this.starts}`;
    slot.node = this.node;
    return `fake:${this.starts}`;
  }

  async sleep(): Promise<void> {}
  async remove(_app: AppId, handle: string): Promise<void> {
    this.removed.push(handle);
  }

  async kill(app: AppId): Promise<void> {
    this.killed.push(app);
  }

  async discard(_app: AppId, handle: string): Promise<boolean> {
    this.discarded.push(handle);
    return true;
  }

  async adopt(): Promise<readonly Adopted<string>[]> {
    return this.adopted;
  }

  list(): Promise<readonly Adopted<string>[]> {
    return this.adopt();
  }

  follow(gone: Gone<string>): void {
    this.#gone = gone;
  }

  end(app: AppId, handle: string, ending: Ending): void {
    this.#gone(app, handle, ending);
  }

  async logs(): Promise<string> {
    return '';
  }

  health(): readonly HealthCheck[] {
    return ['exit'];
  }

  async destroyStorage(): Promise<void> {}

  serves(): boolean {
    return this.serving;
  }
}

/** An app registered in `store` with a container RunSpec the test can change. */
export async function registered(store: SqliteStore, policy: Partial<Policy> = {}) {
  const id = newAppId();
  const name = appName(`app-${id.slice(0, 8).toLowerCase()}`);
  await store.putApp({ name, id, tenant: DEFAULT_TENANT, access: 'org', owner: 'user:ann' as never, status: 'registered', current: 1 as ReleaseNumber, policyOverride: {}, registeredAt: 0, version: 0 });
  let spec: RunSpec = {
    app: id, name, tenant: DEFAULT_TENANT, release: 1 as ReleaseNumber, runtime: { kind: 'container', image: 'sha256:fake' as ImageId },
    injection: { env: {}, storage: [], services: [] }, policy: { ...DEFAULT_POLICY, ...policy }, version: CURRENT,
  };
  return {
    app: id,
    specFor: (app: AppId) => (app === id ? spec : null),
    set: (change: Partial<RunSpec>) => {
      spec = { ...spec, ...change };
    },
  };
}

export type Replica = { instances: Instances; driver: FakeDriver; lifecycle: Lifecycle<RunSpec, string>; guard: AppGuard; events: Record<string, unknown>[] };

/** One gateway replica over `store`: its own mirror, driver, Guard and Lifecycle. */
export function replica(store: SqliteStore, specFor: (app: AppId) => RunSpec | null, id = 'replica-a', options: { leader?: boolean; now?: () => number } = {}): Replica {
  const instances = new Instances(store, { replica: id as ReplicaId, leader: options.leader ?? true });
  const events: Record<string, unknown>[] = [];
  const log = (ev: string, _app?: string | null, extra: Record<string, unknown> = {}) => void events.push({ ev, ...extra });
  const guard = new AppGuard({ instances, specFor, log, now: options.now });
  const driver = new FakeDriver();
  const lifecycle = new Lifecycle(driver, { specFor, instances, guard, log });
  return { instances, driver, lifecycle, guard, events };
}

export async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; !(await condition()); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}
