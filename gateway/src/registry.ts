import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  APPS_PATH, CAPABILITIES, Conflict, InputError, NotFound,
  declaredKinds, effectivePolicy, newAppId, releaseKey, selectProvider, subject,
  type App, type AppDetail, type AppId, type AppName, type AppSummary, type Binding, type BindingState,
  type BundleId, type BundleIndex, type BundleStore, type CapabilityKind, type CapabilityProvider, type ImageId,
  type Injection, type Manifest, type Policy, type PolicyOverride, type PolicyPatch, type ProviderName,
  type PublishRequest, type Registry, type Release, type ReleaseNumber, type ResourceKind, type RouteView,
  type RunSpec, type Runtime, type Stats, type Store, type Subject, type Trigger, type TriggerName,
} from './model.ts';
import type { SchedulerView } from './scheduler.ts';

export type RegistryDeps = {
  readonly store: Store;
  readonly runtime: Runtime;
  readonly bundles: BundleStore;
  readonly providers: readonly CapabilityProvider[];
  /** Ingress counters once U8 wires them; the last snapshot otherwise. */
  readonly statsSource?: () => Stats[];
};

const SECONDS_FIELDS = ['idle_seconds', 'ready_timeout_seconds', 'drain_timeout_seconds', 'connection_idle_seconds', 'trigger_timeout_seconds'] as const;
const DETAIL_DELIVERIES = 50;

function log(ev: string, app: string | null, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: Date.now(), ev, app, ...extra }));
}

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
  readonly #stats: () => Stats[];
  readonly #changed = new EventEmitter();
  readonly #views = new Map<AppName, RouteView>();
  readonly #names = new Map<AppId, AppName>();
  readonly #indexes = new Map<BundleId, BundleIndex>();
  readonly #locks = new Map<AppName, Promise<unknown>>();
  #policy: Policy;

  private constructor(deps: RegistryDeps) {
    this.#store = deps.store;
    this.#runtime = deps.runtime;
    this.#bundles = deps.bundles;
    this.#providers = new Map(deps.providers.map((p) => [p.name, p]));
    this.#stats = deps.statsSource ?? (() => deps.store.stats());
    this.#policy = deps.store.policy();
  }

  /** Loads the global policy and every RouteView, fetching bundle indexes of current releases. */
  static async open(deps: RegistryDeps): Promise<PlatformRegistry> {
    const registry = new PlatformRegistry(deps);
    for (const app of deps.store.apps()) {
      const bundle = registry.#currentRelease(app)?.bundle;
      if (bundle && !registry.#indexes.has(bundle)) registry.#indexes.set(bundle, await deps.bundles.index(bundle));
      registry.#refresh(app.name);
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

    let app = this.#store.app(name);
    if (app?.status === 'purging') throw new Conflict(`app "${name}" is being purged; publish again once purge finishes`);
    const current = app && this.#currentRelease(app);
    if (app?.status === 'registered' && current?.releaseKey === key) return current;

    const override: PolicyOverride = app?.policyOverride ?? {};
    const pinned = kinds.includes('db') && override.db_backend === undefined ? { ...override, db_backend: this.#policy.db_backend } : override;
    const policy = effectivePolicy(this.#policy, pinned);
    const resourceKinds = kinds.filter(isResourceKind);
    const providers = resourceKinds.map((kind) => this.#provider(selectProvider(kind, policy)));

    if (!app) {
      if (owner === null) throw new InputError(`owner is required on the first publish of "${name}"; pass user:<name> or service:<name>`);
      app = { name, id: newAppId(), owner, status: 'registered', current: null, policyOverride: pinned };
      this.#store.putApp(app);
      this.#refresh(name);
      log('app-created', name, { id: app.id });
    } else if (pinned !== override) {
      this.#store.putApp({ ...app, policyOverride: pinned });
    }

    for (const provider of providers) await this.#ensure(app.id, provider);

    const { release, suspended } = this.#store.transaction(() => {
      const fresh = this.#store.app(name)!;
      const reused = current?.releaseKey === key ? current : null;
      const release: Release = reused ?? {
        app: fresh.id,
        number: ((this.#store.releases(fresh.id).at(-1)?.number ?? 0) + 1) as ReleaseNumber,
        image, manifest, bundle, releaseKey: key, publishedAt: Date.now(),
      };
      if (!reused) this.#store.putRelease(release);
      this.#store.replaceTriggers(fresh.id, triggersOf(fresh.id, manifest));
      const next: App = { ...fresh, status: 'registered', current: release.number };
      this.#store.putApp(next);
      return { release, suspended: this.#settle(next, manifest) };
    });
    await this.#settled(name, suspended);
    log('publish', name, { release: release.number });
    return release;
  }

  remove(name: AppName): Promise<void> {
    return this.#exclusive(name, async () => {
      const app = this.#mustApp(name);
      if (app.status === 'removed') return;
      if (app.status === 'purging') throw new Conflict(`app "${name}" is being purged`);
      const suspended = this.#store.transaction(() => {
        const next: App = { ...this.#store.app(name)!, status: 'removed' };
        this.#store.putApp(next);
        return this.#settle(next, this.#currentRelease(next)?.manifest ?? null);
      });
      await this.#settled(name, suspended);
      log('remove', name);
    });
  }

  purge(name: AppName): Promise<void> {
    return this.#exclusive(name, async () => {
      const app = this.#mustApp(name);
      if (app.status === 'registered') throw new Conflict(`app "${name}" is registered; remove it before purging`);
      if (app.status === 'removed') {
        this.#store.putApp({ ...app, status: 'purging' });
        this.#refresh(name);
        this.#emit(app.id);
      }
      await this.#finishPurge(app);
    });
  }

  async #finishPurge(app: App): Promise<void> {
    await this.#runtime.retire(app.id);
    for (const binding of this.#store.bindings(app.id)) {
      await this.#provider(binding.provider).destroy(app.id, binding.resource);
      log('destroy', app.name, { kind: binding.kind, provider: binding.provider });
    }
    this.#store.deleteApp(app.id);
    this.#views.delete(app.name);
    const referenced = new Set(this.#store.apps().flatMap((a) => this.#store.releases(a.id).flatMap((r) => (r.bundle ? [r.bundle] : []))));
    await this.#bundles.deleteUnreferenced(referenced);
    log('purge', app.name);
    this.#emit(app.id);
    this.#names.delete(app.id);
  }

  setGlobalPolicy(patch: Partial<Policy>): Policy {
    const next = { ...this.#policy, ...parsePolicyPatch(patch, 'global') } as Policy;
    this.#store.putPolicy(next);
    this.#policy = next;
    log('policy', null, { policy: next });
    return next;
  }

  setAppPolicy(name: AppName, patch: PolicyPatch): Promise<PolicyOverride> {
    const fields = parsePolicyPatch(patch, 'app');
    return this.#exclusive(name, async () => {
      const app = this.#mustApp(name);
      const override: Record<string, unknown> = { ...app.policyOverride };
      for (const [key, value] of Object.entries(fields)) {
        if (value === null) delete override[key];
        else override[key] = value;
      }
      const hasDb = this.#store.bindings(app.id).some((b) => b.kind === 'db');
      if (hasDb && override.db_backend === undefined) {
        throw new Conflict(`app "${name}" has a database binding; db_backend can be switched but not cleared`);
      }
      const manifest = this.#currentRelease(app)?.manifest ?? null;
      const before = selectProvider('db', effectivePolicy(this.#policy, app.policyOverride));
      const after = selectProvider('db', effectivePolicy(this.#policy, override));
      const switching = app.status === 'registered' && manifest?.capabilities.db !== undefined && before !== after;
      if (switching) await this.#ensure(app.id, this.#provider(after));
      const suspended = this.#store.transaction(() => {
        const next: App = { ...this.#store.app(name)!, policyOverride: override };
        this.#store.putApp(next);
        return this.#settle(next, manifest);
      });
      await this.#settled(name, suspended, switching);
      log('app-policy', name, { override });
      return override as PolicyOverride;
    });
  }

  setOwner(name: AppName, owner: Subject): void {
    this.#store.putApp({ ...this.#mustApp(name), owner });
    this.#refresh(name);
    log('owner', name, { owner });
  }

  issueToken(name: string): { readonly token: string; readonly subject: Subject } {
    const tokenSubject = subject(`service:${name}`);
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    this.#store.putToken({ id: randomBytes(8).toString('hex'), subject: tokenSubject, hash, createdAt: Date.now() });
    log('token', null, { subject: tokenSubject });
    return { token, subject: tokenSubject };
  }

  view(name: AppName): RouteView | null {
    return this.#views.get(name) ?? null;
  }

  policy(): Policy {
    return this.#policy;
  }

  runSpec(id: AppId): RunSpec | null {
    const name = this.#names.get(id);
    const app = name && this.#store.app(name);
    const release = app && app.status === 'registered' ? this.#currentRelease(app) : null;
    if (!app || !release?.image) return null;
    const policy = effectivePolicy(this.#policy, app.policyOverride);
    const injections: Injection[] = this.#store.bindings(id)
      .filter((b) => b.state === 'active' && desiredState(app, release.manifest, policy, b) === 'active')
      .map((b) => this.#provider(b.provider).inject(id, b.resource));
    return {
      app: id,
      name: app.name,
      release: release.number,
      image: release.image,
      injection: {
        env: Object.assign({}, ...injections.map((i) => i.env)),
        mounts: injections.flatMap((i) => i.mounts),
      },
      policy,
    };
  }

  schedule(id: AppId): SchedulerView | null {
    const name = this.#names.get(id);
    const view = name === undefined ? undefined : this.#views.get(name);
    const release = view?.release == null ? null : this.#store.release(id, view.release);
    if (!view || !release) return null;
    return {
      status: view.status,
      publishedAt: release.publishedAt,
      triggers: triggersOf(id, release.manifest),
      policy: effectivePolicy(this.#policy, view.policyOverride),
    };
  }

  listing(): AppSummary[] {
    const stats = new Map(this.#stats().map((s) => [s.app, s]));
    return [...this.#views.values()].map((view) => {
      const s = stats.get(view.app);
      return {
        name: view.name,
        address: `${APPS_PATH}/${view.name}/`,
        release: view.release,
        capabilities: [...view.kinds],
        status: view.status,
        instance: this.#runtime.state(view.app),
        lastAccessAt: s?.lastAccessAt ?? null,
        requests: s?.requests ?? 0,
        errors: s?.errors ?? 0,
      };
    }).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  detail(name: AppName): AppDetail | null {
    const app = this.#store.app(name);
    if (!app) return null;
    return {
      app,
      releases: this.#store.releases(app.id),
      bindings: this.#store.bindings(app.id).map(({ resource: _, ...binding }) => binding),
      policy: effectivePolicy(this.#policy, app.policyOverride),
      instance: this.#runtime.state(app.id),
      stats: this.#stats().find((s) => s.app === app.id) ?? { app: app.id, requests: 0, errors: 0, lastAccessAt: null },
      deliveries: this.#store.deliveries({ app: app.id, limit: DETAIL_DELIVERIES }),
    };
  }

  onAppChanged(listener: (app: AppId) => void): void {
    this.#changed.on('changed', listener);
  }

  /** Resolves once every interrupted purge and binding convergence has run; startup need not await it. */
  async resume(): Promise<void> {
    const apps = this.#store.apps();
    const work = apps.map((app) => this.#exclusive(app.name, async () => {
      if (app.status === 'purging') await this.#finishPurge(app);
      else await this.#converge(app.name);
    }).catch((error: Error) => log('resume-failed', app.name, { error: error.message })));
    await Promise.all(work);
  }

  async #converge(name: AppName): Promise<void> {
    const app = this.#mustApp(name);
    const manifest = this.#currentRelease(app)?.manifest ?? null;
    const policy = effectivePolicy(this.#policy, app.policyOverride);
    for (const binding of this.#store.bindings(app.id)) {
      const provider = this.#provider(binding.provider);
      if (desiredState(app, manifest, policy, binding) === 'active') {
        await this.#ensure(app.id, provider);
      } else {
        this.#store.putBinding({ ...binding, state: 'suspended' });
        await provider.suspend(app.id, binding.resource);
      }
    }
  }

  /** Writes the binding row right after the provider returns, so a crash before commit leaves a row the next publish adopts. */
  async #ensure(app: AppId, provider: CapabilityProvider): Promise<void> {
    const current = this.#store.bindings(app).find((b) => b.kind === provider.kind && b.provider === provider.name);
    const resource = await provider.ensure(app, current?.resource ?? null);
    this.#store.putBinding({ app, kind: provider.kind, provider: provider.name, state: 'active', resource });
  }

  /** Inside a transaction: moves every binding of `app` to its desired state; returns the ones just suspended. */
  #settle(app: App, manifest: Manifest | null): Binding[] {
    const policy = effectivePolicy(this.#policy, app.policyOverride);
    const suspended: Binding[] = [];
    for (const binding of this.#store.bindings(app.id)) {
      const state = desiredState(app, manifest, policy, binding);
      if (state === binding.state) continue;
      this.#store.putBinding({ ...binding, state });
      if (state === 'suspended') suspended.push(binding);
    }
    return suspended;
  }

  /** After a commit: backends follow the rows, then readers see the new view. A failed suspend is redone by `resume`. */
  async #settled(name: AppName, suspended: readonly Binding[], changed = true): Promise<void> {
    for (const binding of suspended) {
      await this.#provider(binding.provider).suspend(binding.app, binding.resource)
        .catch((error: Error) => log('suspend-failed', name, { kind: binding.kind, error: error.message }));
    }
    const view = this.#refresh(name);
    if (changed) this.#emit(view.app);
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

  #refresh(name: AppName): RouteView {
    const app = this.#store.app(name)!;
    const release = this.#currentRelease(app);
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
    return view;
  }

  #currentRelease(app: App): Release | null {
    return app.current === null ? null : this.#store.release(app.id, app.current);
  }

  #mustApp(name: AppName): App {
    const app = this.#store.app(name);
    if (!app) throw new NotFound(`no app named "${name}"`);
    return app;
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
