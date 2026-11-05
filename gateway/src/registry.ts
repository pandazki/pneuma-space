import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  APPS_PATH, CAPABILITIES, Conflict, InputError, NotFound,
  declaredKinds, effectivePolicy, newAppId, releaseKey, selectProvider,
  type App, type AppDetail, type AppId, type AppName, type AppSummary, type Binding, type BindingState,
  type BundleId, type BundleIndex, type BundleStore, type CapabilityKind, type CapabilityProvider, type ImageId,
  type Injection, type Manifest, type Policy, type PolicyOverride, type PolicyPatch, type ProviderName,
  type PublishRequest, type Registry, type Release, type ReleaseNumber, type ResourceKind, type RouteView,
  type RunSpec, type Runtime, type SchedulerView, type Stats, type Store, type StoreOps, type Subject, type Trigger, type TriggerName,
} from './model.ts';
import { emit } from './events.ts';
import { issueToken } from './identity.ts';

export type RegistryDeps = {
  readonly store: Store;
  readonly runtime: Runtime;
  readonly bundles: BundleStore;
  readonly providers: readonly CapabilityProvider[];
  /** Ingress counters once U8 wires them; the last snapshot otherwise. */
  readonly statsSource?: () => Promise<Stats[]>;
};

const SECONDS_FIELDS = ['idle_seconds', 'ready_timeout_seconds', 'drain_timeout_seconds', 'connection_idle_seconds', 'trigger_timeout_seconds'] as const;
const DETAIL_DELIVERIES = 50;

const log = emit;

const isResourceKind = (kind: CapabilityKind): kind is ResourceKind => CAPABILITIES[kind].class === 'resource';

/** The one rule for a binding's state; publish, remove, policy changes and restart all converge to it. */
function desiredState(app: App, manifest: Manifest | null, policy: Policy, binding: Binding): BindingState {
  const declared = app.status === 'registered' && manifest?.capabilities[binding.kind] !== undefined;
  return declared && selectProvider(binding.kind, policy) === binding.provider ? 'active' : 'suspended';
}

function parsePolicyPatch(raw: unknown, scope: 'global' | 'app'): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new InputError('policy must be a JSON object');
  const allowed: readonly string[] = [...SECONDS_FIELDS, 'db_backend', ...(scope === 'global' ? ['timezone'] : [])];
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) {
      const hint = key === 'timezone' ? 'timezone is global only; set it with PUT /api/policy' : `allowed: ${allowed.join(', ')}`;
      throw new InputError(`policy field "${key}" is not accepted here; ${hint}`);
    }
    if (value === null && scope === 'app') continue;
    if ((SECONDS_FIELDS as readonly string[]).includes(key) && !(Number.isInteger(value) && (value as number) > 0)) {
      throw new InputError(`${key} must be a positive integer number of seconds, got ${JSON.stringify(value)}`);
    }
    if (key === 'db_backend' && !(CAPABILITIES.db.providers as readonly unknown[]).includes(value)) {
      throw new InputError(`db_backend must be one of ${CAPABILITIES.db.providers.join(', ')}, got ${JSON.stringify(value)}`);
    }
    if (key === 'timezone' && !validTimezone(value)) throw new InputError(`timezone ${JSON.stringify(value)} is not an IANA time zone like "UTC" or "Asia/Shanghai"`);
  }
  return raw as Record<string, unknown>;
}

function validTimezone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

async function currentRelease(store: StoreOps, app: App): Promise<Release | null> {
  return app.current === null ? null : store.release(app.id, app.current);
}

function triggersOf(app: AppId, manifest: Manifest): Trigger[] {
  return Object.entries(manifest.capabilities.cron?.triggers ?? {}).map(([name, t]) => ({
    app, name: name as TriggerName, schedule: t.schedule ?? null,
  }));
}

export class PlatformRegistry implements Registry {
  readonly #store: Store;
  readonly #runtime: Runtime;
  readonly #bundles: BundleStore;
  readonly #providers: ReadonlyMap<ProviderName, CapabilityProvider>;
  readonly #stats: () => Promise<Stats[]>;
  readonly #changed = new EventEmitter();
  readonly #views = new Map<AppName, RouteView>();
  readonly #specs = new Map<AppId, RunSpec>();
  readonly #names = new Map<AppId, AppName>();
  readonly #schedules = new Map<AppId, SchedulerView>();
  readonly #indexes = new Map<BundleId, BundleIndex>();
  readonly #locks = new Map<AppName, Promise<unknown>>();
  #policy: Policy;

  private constructor(deps: RegistryDeps, policy: Policy) {
    this.#store = deps.store;
    this.#runtime = deps.runtime;
    this.#bundles = deps.bundles;
    this.#providers = new Map(deps.providers.map((p) => [p.name, p]));
    this.#stats = deps.statsSource ?? (() => deps.store.stats());
    this.#policy = policy;
  }

  /** Loads the global policy and every RouteView, fetching bundle indexes of current releases. */
  static async open(deps: RegistryDeps): Promise<PlatformRegistry> {
    const registry = new PlatformRegistry(deps, await deps.store.policy());
    for (const app of await deps.store.apps()) {
      const bundle = (await currentRelease(deps.store, app))?.bundle;
      if (bundle && !registry.#indexes.has(bundle)) registry.#indexes.set(bundle, await deps.bundles.index(bundle));
      await registry.#refresh(app.name);
    }
    return registry;
  }

  publish(request: PublishRequest): Promise<Release> {
    return this.#exclusive(request.name, () => this.#publish(request));
  }

  async #publish({ name, image: reference, manifest, bundle, owner }: PublishRequest): Promise<Release> {
    const kinds = declaredKinds(manifest);
    if (reference === null && !(kinds.includes('static') && !kinds.some((k) => CAPABILITIES[k].needsImage))) {
      throw new InputError('image is required unless the manifest declares static and nothing that needs a container');
    }
    if (kinds.includes('static') !== (bundle !== null)) {
      throw new InputError(bundle === null ? 'static is declared; upload the directory with POST /api/bundles and pass its id as bundle' : 'bundle given but the manifest does not declare static');
    }
    const image = reference === null ? null : await this.#runtime.resolveImage(reference);
    if (reference !== null && image === null) throw new NotFound(`image "${reference}" not found on this host; docker build it first`);
    if (bundle !== null && !this.#indexes.has(bundle)) this.#indexes.set(bundle, await this.#bundles.index(bundle));
    const key = releaseKey(image, manifest, bundle);

    let app = await this.#store.app(name);
    if (app?.status === 'purging') throw new Conflict(`app "${name}" is being purged; publish again once purge finishes`);
    const current = app && (await currentRelease(this.#store, app));
    if (app?.status === 'registered' && current?.releaseKey === key) return current;

    const override: PolicyOverride = app?.policyOverride ?? {};
    const pinned = kinds.includes('db') && override.db_backend === undefined ? { ...override, db_backend: this.#policy.db_backend } : override;
    const policy = effectivePolicy(this.#policy, pinned);
    const resourceKinds = kinds.filter(isResourceKind);
    const providers = resourceKinds.map((kind) => this.#provider(selectProvider(kind, policy)));

    if (!app) {
      if (owner === null) throw new InputError(`owner is required on the first publish of "${name}"; pass user:<name> or service:<name>`);
      app = { name, id: newAppId(), owner, status: 'registered', current: null, policyOverride: pinned, registeredAt: Date.now() };
      await this.#store.putApp(app);
      await this.#refresh(name);
      log('app-created', name, { id: app.id });
    } else if (pinned !== override) {
      await this.#updateApp(name, (fresh) => ({ ...fresh, policyOverride: pinned }));
    }

    for (const provider of providers) await this.#ensure(app.id, provider);

    const { next, release, suspended } = await this.#store.transaction(async (tx) => {
      const fresh = (await tx.app(name))!;
      const reused = current?.releaseKey === key ? current : null;
      const release: Release = reused ?? {
        app: fresh.id,
        number: (((await tx.releases(fresh.id)).at(-1)?.number ?? 0) + 1) as ReleaseNumber,
        image, manifest, bundle, releaseKey: key, publishedAt: Date.now(),
      };
      if (!reused) await tx.putRelease(release);
      await tx.replaceTriggers(fresh.id, triggersOf(fresh.id, manifest));
      const registeredAt = fresh.status === 'registered' ? fresh.registeredAt : Date.now();
      const next: App = { ...fresh, status: 'registered', current: release.number, registeredAt };
      await tx.putApp(next);
      return { next, release, suspended: await this.#settle(tx, next, manifest) };
    });
    await this.#settled(next, suspended);
    log('publish', name, { release: release.number });
    return release;
  }

  remove(name: AppName): Promise<void> {
    return this.#exclusive(name, async () => {
      const app = await this.#mustApp(name);
      if (app.status === 'removed') return this.#converge(name);
      if (app.status === 'purging') throw new Conflict(`app "${name}" is being purged`);
      const { next, suspended } = await this.#store.transaction(async (tx) => {
        const next: App = { ...(await tx.app(name))!, status: 'removed' };
        await tx.putApp(next);
        return { next, suspended: await this.#settle(tx, next, (await currentRelease(tx, next))?.manifest ?? null) };
      });
      await this.#settled(next, suspended);
      log('remove', name);
    });
  }

  purge(name: AppName): Promise<void> {
    return this.#exclusive(name, async () => {
      const app = await this.#mustApp(name);
      if (app.status === 'registered') throw new Conflict(`app "${name}" is registered; remove it before purging`);
      if (app.status === 'removed') {
        await this.#updateApp(name, (fresh) => ({ ...fresh, status: 'purging' }));
        await this.#refresh(name);
        this.#emit(app.id);
      }
      await this.#finishPurge(app);
    });
  }

  async #finishPurge(app: App): Promise<void> {
    await this.#runtime.retire(app.id);
    for (const binding of await this.#store.bindings(app.id)) {
      await this.#provider(binding.provider).destroy(app.id, binding.resource);
      log('destroy', app.name, { kind: binding.kind, provider: binding.provider });
    }
    const bundlesOf = async (id: AppId) => (await this.#store.releases(id)).flatMap((r) => (r.bundle ? [r.bundle] : []));
    const others = (await this.#store.apps()).filter((a) => a.id !== app.id);
    const elsewhere = new Set((await Promise.all(others.map((a) => bundlesOf(a.id)))).flat());
    for (const bundle of new Set(await bundlesOf(app.id))) {
      if (elsewhere.has(bundle)) continue;
      await this.#bundles.delete(bundle);
      this.#indexes.delete(bundle);
    }
    await this.#store.deleteApp(app.id);
    this.#views.delete(app.name);
    this.#specs.delete(app.id);
    this.#schedules.delete(app.id);
    log('purge', app.name);
    this.#emit(app.id);
    this.#names.delete(app.id);
  }

  async setGlobalPolicy(patch: Partial<Policy>): Promise<Policy> {
    const fields = parsePolicyPatch(patch, 'global');
    const next = await this.#store.transaction(async (tx) => {
      const merged = { ...(await tx.policy()), ...fields } as Policy;
      await tx.putPolicy(merged);
      return merged;
    });
    this.#policy = next;
    for (const name of [...this.#views.keys()]) await this.#refresh(name);
    log('policy', null, { policy: next });
    return next;
  }

  setAppPolicy(name: AppName, patch: PolicyPatch): Promise<PolicyOverride> {
    const fields = parsePolicyPatch(patch, 'app');
    return this.#exclusive(name, async () => {
      const app = await this.#mustApp(name);
      const override: Record<string, unknown> = { ...app.policyOverride };
      for (const [key, value] of Object.entries(fields)) {
        if (value === null) delete override[key];
        else override[key] = value;
      }
      const hasDb = (await this.#store.bindings(app.id)).some((b) => b.kind === 'db');
      if (hasDb && override.db_backend === undefined) {
        throw new Conflict(`app "${name}" has a database binding; db_backend can be switched but not cleared`);
      }
      const manifest = (await currentRelease(this.#store, app))?.manifest ?? null;
      const before = selectProvider('db', effectivePolicy(this.#policy, app.policyOverride));
      const after = selectProvider('db', effectivePolicy(this.#policy, override));
      const switching = app.status === 'registered' && manifest?.capabilities.db !== undefined && before !== after;
      if (switching) await this.#ensure(app.id, this.#provider(after));
      const { next, suspended } = await this.#store.transaction(async (tx) => {
        const next: App = { ...(await tx.app(name))!, policyOverride: override };
        await tx.putApp(next);
        return { next, suspended: await this.#settle(tx, next, manifest) };
      });
      await this.#settled(next, suspended, switching);
      log('app-policy', name, { override });
      return override as PolicyOverride;
    });
  }

  async setOwner(name: AppName, owner: Subject): Promise<void> {
    await this.#updateApp(name, (app) => ({ ...app, owner }));
    await this.#refresh(name);
    log('owner', name, { owner });
  }

  async issueToken(name: string): Promise<{ readonly token: string; readonly subject: Subject }> {
    const { token, hash, subject } = issueToken(name);
    await this.#store.putToken({ id: randomBytes(8).toString('hex'), subject, hash, createdAt: Date.now() });
    log('token', null, { subject });
    return { token, subject };
  }

  view(name: AppName): RouteView | null {
    return this.#views.get(name) ?? null;
  }

  policy(): Policy {
    return this.#policy;
  }

  runSpec(id: AppId): RunSpec | null {
    return this.#specs.get(id) ?? null;
  }

  nameOf(id: AppId): AppName | null {
    return this.#names.get(id) ?? null;
  }

  schedule(id: AppId): SchedulerView | null {
    return this.#schedules.get(id) ?? null;
  }

  async listing(): Promise<AppSummary[]> {
    const stats = new Map((await this.#stats()).map((s) => [s.app, s]));
    return [...this.#views.values()].map((view) => {
      const s = stats.get(view.app);
      return {
        name: view.name,
        address: `${APPS_PATH}/${view.name}/`,
        release: view.release,
        capabilities: [...view.kinds],
        status: view.status,
        instance: this.#runtime.state(view.app),
        since: this.#runtime.since(view.app),
        leases: this.#runtime.leases(view.app),
        sleepsAt: this.#runtime.sleepsAt(view.app),
        lastAccessAt: s?.lastAccessAt ?? null,
        requests: s?.requests ?? 0,
        errors: s?.errors ?? 0,
      };
    }).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async detail(name: AppName): Promise<AppDetail | null> {
    const stats = await this.#stats();
    return this.#store.transaction(async (tx) => {
      const app = await tx.app(name);
      if (!app) return null;
      return {
        app,
        releases: await tx.releases(app.id),
        bindings: (await tx.bindings(app.id)).map(({ resource: _, ...binding }) => binding),
        policy: effectivePolicy(this.#policy, app.policyOverride),
        instance: this.#runtime.state(app.id),
        stats: stats.find((s) => s.app === app.id) ?? { app: app.id, requests: 0, errors: 0, lastAccessAt: null },
        deliveries: await tx.deliveries({ app: app.id, limit: DETAIL_DELIVERIES }),
      };
    });
  }

  onAppChanged(listener: (app: AppId) => void): void {
    this.#changed.on('changed', listener);
  }

  /** Resolves once every interrupted purge and binding convergence has run; startup need not await it. */
  async resume(): Promise<void> {
    const apps = await this.#store.apps();
    const work = apps.map((app) => this.#exclusive(app.name, async () => {
      if (app.status === 'purging') await this.#finishPurge(app);
      else await this.#converge(app.name);
    }).catch((error: Error) => log('resume-failed', app.name, { error: error.message })));
    await Promise.all(work);
  }

  async #converge(name: AppName): Promise<void> {
    const app = await this.#mustApp(name);
    const manifest = (await currentRelease(this.#store, app))?.manifest ?? null;
    const policy = effectivePolicy(this.#policy, app.policyOverride);
    for (const binding of await this.#store.bindings(app.id)) {
      const provider = this.#provider(binding.provider);
      if (desiredState(app, manifest, policy, binding) === 'active') {
        await this.#ensure(app.id, provider);
      } else {
        await this.#store.putBinding({ ...binding, state: 'suspended' });
        await provider.suspend(app.id, binding.resource);
      }
    }
    await this.#refresh(name);
  }

  /** Writes the binding row right after the provider returns, so a crash before commit leaves a row the next publish adopts. */
  async #ensure(app: AppId, provider: CapabilityProvider): Promise<void> {
    const current = (await this.#store.bindings(app)).find((b) => b.kind === provider.kind && b.provider === provider.name);
    const resource = await provider.ensure(app, current?.resource ?? null);
    await this.#store.putBinding({ app, kind: provider.kind, provider: provider.name, state: 'active', resource });
  }

  /** Moves every binding of `app` to its desired state; returns the ones just suspended. */
  async #settle(tx: StoreOps, app: App, manifest: Manifest | null): Promise<Binding[]> {
    const policy = effectivePolicy(this.#policy, app.policyOverride);
    const suspended: Binding[] = [];
    for (const binding of await tx.bindings(app.id)) {
      const state = desiredState(app, manifest, policy, binding);
      if (state === binding.state) continue;
      await tx.putBinding({ ...binding, state });
      if (state === 'suspended') suspended.push(binding);
    }
    return suspended;
  }

  /** After a commit: backends follow the rows, then readers see the new view. A failed suspend is redone by `resume` or another remove. */
  async #settled(app: App, suspended: readonly Binding[], changed = true): Promise<void> {
    for (const binding of suspended) {
      await this.#provider(binding.provider).suspend(binding.app, binding.resource)
        .catch((error: Error) => log('suspend-failed', app.name, { kind: binding.kind, error: error.message }));
    }
    await this.#refresh(app.name);
    if (changed) this.#emit(app.id);
  }

  #emit(app: AppId): void {
    for (const listener of this.#changed.listeners('changed') as ((app: AppId) => void)[]) {
      try {
        listener(app);
      } catch (error) {
        log('listener-failed', this.#names.get(app) ?? null, { error: (error as Error).message });
      }
    }
  }

  /** Rebuilds the app's RouteView, RunSpec and SchedulerView from one read; inside the transaction, so a refresh that read older rows never lands last. */
  #refresh(name: AppName): Promise<void> {
    return this.#store.transaction(async (tx) => {
      const app = await tx.app(name);
      if (!app) return;
      const release = await currentRelease(tx, app);
      const policy = effectivePolicy(this.#policy, app.policyOverride);
      const view: RouteView = Object.freeze({
        app: app.id,
        name,
        status: app.status,
        owner: app.owner,
        release: release?.number ?? null,
        image: release?.image ?? null,
        kinds: new Set(release ? declaredKinds(release.manifest) : []),
        bundle: (release?.bundle && this.#indexes.get(release.bundle)) || null,
        identity: release?.manifest.capabilities.identity ?? null,
        policyOverride: Object.freeze({ ...app.policyOverride }),
      });
      this.#views.set(name, view);
      this.#names.set(app.id, name);
      const spec = release?.image && app.status === 'registered' ? this.#spec(app, release.image, release, await tx.bindings(app.id), policy) : null;
      if (spec) this.#specs.set(app.id, spec);
      else this.#specs.delete(app.id);
      if (release) {
        this.#schedules.set(app.id, {
          status: app.status,
          publishedAt: Math.max(release.publishedAt, app.registeredAt),
          triggers: triggersOf(app.id, release.manifest),
          policy,
        });
      } else {
        this.#schedules.delete(app.id);
      }
    });
  }

  #spec(app: App, image: ImageId, release: Release, bindings: readonly Binding[], policy: Policy): RunSpec {
    const injections: Injection[] = bindings
      .filter((b) => b.state === 'active' && desiredState(app, release.manifest, policy, b) === 'active')
      .map((b) => this.#provider(b.provider).inject(app.id, b.resource));
    return {
      app: app.id,
      name: app.name,
      release: release.number,
      image,
      injection: {
        env: Object.assign({}, ...injections.map((i) => i.env)),
        mounts: injections.flatMap((i) => i.mounts),
      },
      policy,
    };
  }

  async #mustApp(name: AppName): Promise<App> {
    const app = await this.#store.app(name);
    if (!app) throw new NotFound(`no app named "${name}"`);
    return app;
  }

  /** Reads and writes the app row in one transaction, so an owner change made meanwhile is not overwritten. */
  #updateApp(name: AppName, change: (app: App) => App): Promise<void> {
    return this.#store.transaction(async (tx) => {
      const app = await tx.app(name);
      if (!app) throw new NotFound(`no app named "${name}"`);
      await tx.putApp(change(app));
    });
  }

  #provider(name: ProviderName): CapabilityProvider {
    const provider = this.#providers.get(name);
    if (!provider) throw new Conflict(`provider "${name}" is not available in this gateway`);
    return provider;
  }

  /** Serializes commands per app so two publishes never race on the same rows or backend resources. */
  #exclusive<T>(name: AppName, fn: () => Promise<T>): Promise<T> {
    const run = (this.#locks.get(name) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    this.#locks.set(name, tail);
    void tail.then(() => this.#locks.get(name) === tail && this.#locks.delete(name));
    return run;
  }
}
