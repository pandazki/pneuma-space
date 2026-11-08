import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  CAPABILITIES, Conflict, DEFAULT_ENTRY, DEFAULT_QUOTA, DEFAULT_TENANT, GLOBAL_ONLY_POLICY, InputError, NotFound, QUOTA_RESOURCES, RUNTIMES,
  declaredKinds, effectivePolicy, newAppId, releaseKey, selectProvider, subject,
  type Access, type App, type AppDetail, type AppId, type AppName, type AppSummary, type Binding, type BindingState,
  type BundleId, type BundleIndex, type BundleStore, type CapabilityKind, type Change, type CapabilityProvider, type Guard, type Infra,
  type Manifest, type Policy, type PolicyOverride, type PolicyPatch, type ProviderName, type Quota, type Role,
  type PublishRequest, type Registry, type Release, type ReleaseNumber, type ResourceKind, type RouteView,
  type RunSpec, type Runtime, type RuntimeKind, type SchedulerView, type Stats, type Store, type StoreOps, type Subject, type Tenant, type TenantName,
  type Trigger, type TriggerName,
} from './model.ts';
import { address, PATH_ADDRESSING, type Addressing } from './address.ts';
import { emit } from './events.ts';
import { issueToken } from './identity.ts';
import { resolvesOnNetwork, type ServiceProbe } from './providers.ts';

export type RegistryDeps = {
  readonly store: Store;
  readonly runtime: Pick<Runtime, 'retire' | 'state' | 'since' | 'leases' | 'sleepsAt'>;
  readonly guard: Pick<Guard, 'quarantine'>;
  readonly infra: Pick<Infra, 'resolveImage'>;
  readonly bundles: BundleStore;
  readonly providers: readonly CapabilityProvider[];
  /** Whether a runtime's compose service is up; publish refuses a runtime whose service is not. */
  readonly probe?: ServiceProbe;
  /** The 24 h counts and last access per app; the stored last access otherwise. */
  readonly statsSource?: () => Promise<Stats[]>;
  readonly addressing?: Addressing;
};

const SECONDS_FIELDS = ['idle_seconds', 'ready_timeout_seconds', 'drain_timeout_seconds', 'connection_idle_seconds', 'trigger_timeout_seconds', 'failure_window_seconds', 'restart_backoff_seconds'] as const;
const WHOLE_FIELDS = ['max_failures', 'cpu_millis', 'memory_mb', 'usage_retention_days', 'events_retention_days', 'events_max_rows'] as const;
const POLICY_FIELDS: readonly string[] = [...SECONDS_FIELDS, ...WHOLE_FIELDS, 'db_backend', 'timezone'];
const DETAIL_DELIVERIES = 50;
const SIGHTING_MS = 5 * 60_000;

const log = emit;

/** A listing row with the columns AppSummary lacks while model.ts is frozen. */
export type Listed = AppSummary & { readonly tenant: TenantName; readonly access: Access };

/** What the admin API calls: the frozen interface, the tenant commands and the wider listing. */
export type AdminRegistry = Omit<Registry, 'listing'> & TenantCommands & { listing(): Promise<Listed[]> };

export type IssuedToken = { readonly id: string; readonly token: string; readonly subject: Subject };

/** Commands beyond the frozen Registry interface; actor-free, since the admin boundary audits them (ADR 0024 item 6). */
export type TenantCommands = {
  /** Copies DEFAULT_QUOTA; `admins` are user ids, at least one. */
  createTenant(name: TenantName, display: string, admins: readonly string[]): Promise<Tenant>;
  setQuota(tenant: TenantName, patch: Readonly<Record<string, unknown>>): Promise<Quota>;
  /** `force` lets a platform admin leave a tenant without an admin; otherwise demoting or removing the last one is a Conflict. */
  setMember(tenant: TenantName, user: string, role: Role, force: boolean): Promise<void>;
  removeMember(tenant: TenantName, user: string, force: boolean): Promise<void>;
  issueTenantToken(tenant: TenantName, subject: Subject, label: string, createdBy: Subject | 'local'): Promise<IssuedToken>;
  revokeToken(tenant: TenantName, id: string): Promise<void>;
  setAccess(name: AppName, access: Access): Promise<void>;
  /** Retires the instance, then moves the row, so quota, labels and tokens switch at once (ADR 0022 item 3). */
  moveApp(name: AppName, tenant: TenantName): Promise<void>;
};

const isResourceKind = (kind: CapabilityKind): kind is ResourceKind => CAPABILITIES[kind].class === 'resource';

/** The one rule for a binding's state; publish, remove, policy changes and restart all converge to it. */
function desiredState(app: App, manifest: Manifest | null, policy: Policy, binding: Binding): BindingState {
  const declared = app.status === 'registered' && manifest?.capabilities[binding.kind] !== undefined;
  return declared && selectProvider(binding.kind, policy) === binding.provider ? 'active' : 'suspended';
}

function parsePolicyPatch(raw: unknown, scope: 'global' | 'app'): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new InputError('policy must be a JSON object');
  const globalOnly: readonly string[] = GLOBAL_ONLY_POLICY;
  for (const [key, value] of Object.entries(raw)) {
    if (scope === 'app' && globalOnly.includes(key)) throw new InputError(`policy field "${key}" is global only; set it with PUT /api/policy`);
    if (!POLICY_FIELDS.includes(key)) {
      const allowed = scope === 'global' ? POLICY_FIELDS : POLICY_FIELDS.filter((field) => !globalOnly.includes(field));
      throw new InputError(`policy field "${key}" is not accepted here; allowed: ${allowed.join(', ')}`);
    }
    if (value === null && scope === 'app') continue;
    const positive = Number.isInteger(value) && (value as number) > 0;
    if ((SECONDS_FIELDS as readonly string[]).includes(key) && !positive) {
      throw new InputError(`${key} must be a positive integer number of seconds, got ${JSON.stringify(value)}`);
    }
    if ((WHOLE_FIELDS as readonly string[]).includes(key) && !positive) throw new InputError(`${key} must be a positive integer, got ${JSON.stringify(value)}`);
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

export class PlatformRegistry implements Registry, TenantCommands {
  readonly #store: Store;
  readonly #runtime: RegistryDeps['runtime'];
  readonly #guard: RegistryDeps['guard'];
  readonly #infra: RegistryDeps['infra'];
  readonly #probe: ServiceProbe;
  readonly #bundles: BundleStore;
  readonly #providers: ReadonlyMap<ProviderName, CapabilityProvider>;
  readonly #stats: () => Promise<Stats[]>;
  readonly #addressing: Addressing;
  readonly #changed = new EventEmitter();
  readonly #views = new Map<AppName, RouteView>();
  readonly #specs = new Map<AppId, RunSpec>();
  readonly #runtimes = new Map<AppId, RuntimeKind | null>();
  readonly #names = new Map<AppId, AppName>();
  readonly #schedules = new Map<AppId, SchedulerView>();
  readonly #indexes = new Map<BundleId, BundleIndex>();
  readonly #sightings = new Map<string, { readonly key: string; readonly at: number }>();
  #policy: Policy;

  private constructor(deps: RegistryDeps, policy: Policy) {
    this.#store = deps.store;
    this.#runtime = deps.runtime;
    this.#guard = deps.guard;
    this.#infra = deps.infra;
    this.#probe = deps.probe ?? resolvesOnNetwork;
    this.#bundles = deps.bundles;
    this.#providers = new Map(deps.providers.map((p) => [p.name, p]));
    this.#stats = deps.statsSource ?? (() => deps.store.stats());
    this.#addressing = deps.addressing ?? PATH_ADDRESSING;
    this.#policy = policy;
  }

  /** Loads the global policy and every RouteView, then follows committed changes from any replica. */
  static async open(deps: RegistryDeps): Promise<PlatformRegistry> {
    const registry = new PlatformRegistry(deps, await deps.store.policy());
    await registry.#reload();
    deps.store.onChange((change) => void registry.#follow(change).catch((error: Error) => log('follow-failed', null, { error: error.message })));
    deps.store.onResync(() => void registry.#reload().catch((error: Error) => log('resync-failed', null, { error: error.message })));
    return registry;
  }

  /** A command's own replica has already refreshed; the second refresh reads the same rows. Retire and reload stay with that replica (ADR 0025 item 5). */
  async #follow(change: Change): Promise<void> {
    if (change.kind === 'app') return this.#load(change.name);
    if (change.kind !== 'policy') return;
    this.#policy = await this.#store.policy();
    for (const name of [...this.#views.keys()]) await this.#refresh(name);
  }

  async #reload(): Promise<void> {
    this.#policy = await this.#store.policy();
    const names = new Set((await this.#store.apps()).map((app) => app.name));
    for (const name of new Set([...names, ...this.#views.keys()])) await this.#load(name);
  }

  /** Fetches the current release's bundle index if this replica has not seen it, then refreshes. */
  async #load(name: AppName): Promise<void> {
    const app = await this.#store.app(name);
    const bundle = app && (await currentRelease(this.#store, app))?.bundle;
    if (bundle && !this.#indexes.has(bundle)) this.#indexes.set(bundle, await this.#bundles.index(bundle));
    await this.#refresh(name);
  }

  publish(request: PublishRequest): Promise<Release> {
    return this.#store.exclusive(request.name, () => this.#publish(request));
  }

  async #publish({ name, image: reference, manifest, bundle, owner, tenant = DEFAULT_TENANT }: PublishRequest): Promise<Release> {
    const kinds = declaredKinds(manifest);
    const needsRuntime = kinds.some((k) => CAPABILITIES[k].needsRuntime);
    const runtime: RuntimeKind | null = manifest.runtime ?? (reference !== null ? 'container' : bundle !== null && needsRuntime ? 'isolate' : null);
    if (runtime === null && !(kinds.includes('static') && !needsRuntime)) {
      throw new InputError('image or code bundle is required unless the manifest declares static and nothing that needs a runtime');
    }
    if ((runtime === 'container') !== (reference !== null)) {
      throw new InputError(reference === null ? 'runtime "container" needs an image' : `an image is for runtime "container", not "${runtime}"`);
    }
    if (runtime === 'isolate' && bundle === null) throw new InputError('runtime "isolate" needs the app directory uploaded with POST /api/bundles, its id as bundle');
    if (kinds.includes('static') && bundle === null) throw new InputError('static is declared; upload the directory with POST /api/bundles and pass its id as bundle');
    if (bundle !== null && runtime !== 'isolate' && !kinds.includes('static')) throw new InputError('bundle given but the manifest declares neither static nor runtime "isolate"');
    const image = reference === null ? null : await this.#infra.resolveImage(reference);
    if (reference !== null && image === null) throw new NotFound(`image "${reference}" not found on this host; docker build it first`);
    if (bundle !== null && !this.#indexes.has(bundle)) this.#indexes.set(bundle, await this.#bundles.index(bundle));
    const key = releaseKey(image, manifest, bundle);

    let app = await this.#store.app(name);
    if (app?.status === 'purging') throw new Conflict(`app "${name}" is being purged; publish again once purge finishes`);
    const current = app && (await currentRelease(this.#store, app));
    if (app?.status === 'registered' && current?.releaseKey === key) return current;
    const service = runtime === null ? null : RUNTIMES[runtime].service;
    if (runtime !== null && service !== null && !(await this.#probe(service))) {
      throw new Conflict(`runtime "${runtime}" needs the ${service} service; start the platform with --profile ${RUNTIMES[runtime].profile}`);
    }

    const override: PolicyOverride = app?.policyOverride ?? {};
    const pinned = kinds.includes('db') && override.db_backend === undefined ? { ...override, db_backend: this.#policy.db_backend } : override;
    const policy = effectivePolicy(this.#policy, pinned);
    const resourceKinds = kinds.filter(isResourceKind);
    const providers = resourceKinds.map((kind) => this.#provider(selectProvider(kind, policy)));

    if (!app) {
      if (owner === null) throw new InputError(`owner is required on the first publish of "${name}"; pass user:<name> or service:<name>`);
      if (!(await this.#store.tenant(tenant))) throw new NotFound(`no tenant named "${tenant}"`);
      app = { name, id: newAppId(), tenant, access: 'org', owner, status: 'registered', current: null, policyOverride: pinned, registeredAt: Date.now() };
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
        image, manifest, bundle, runtime, releaseKey: key, publishedAt: Date.now(),
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
    return this.#store.exclusive(name, async () => {
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
    return this.#store.exclusive(name, async () => {
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
    this.#forget(app.name);
    log('purge', app.name);
    this.#emit(app.id);
    this.#names.delete(app.id);
  }

  /** Drops what this replica holds for an app whose row is gone. `nameOf` keeps answering for the id, so late events still carry the name. */
  #forget(name: AppName): void {
    const id = this.#views.get(name)?.app;
    this.#views.delete(name);
    if (id === undefined) return;
    this.#specs.delete(id);
    this.#runtimes.delete(id);
    this.#schedules.delete(id);
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
    return this.#store.exclusive(name, async () => {
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

  /** `id` is beyond the frozen interface; the admin boundary audits it. Under `local` every token lands in `default` (ADR 0022 item 4). */
  issueToken(name: string): Promise<IssuedToken> {
    return this.issueTenantToken(DEFAULT_TENANT, subject(`service:${name}`), name, 'local');
  }

  async issueTenantToken(tenant: TenantName, who: Subject, label: string, createdBy: Subject | 'local'): Promise<IssuedToken> {
    await this.#mustTenant(this.#store, tenant);
    const { token, hash } = issueToken(who);
    const id = randomBytes(8).toString('hex');
    await this.#store.putToken({ id, tenant, subject: who, label, hash, createdBy, createdAt: Date.now(), revokedAt: null });
    log('token', null, { tenant, subject: who });
    return { id, token, subject: who };
  }

  /** Revoking a revoked token succeeds, so a retry converges. */
  async revokeToken(tenant: TenantName, id: string): Promise<void> {
    if (!(await this.#store.tokens(tenant)).some((t) => t.id === id)) throw new NotFound(`no token "${id}" in tenant "${tenant}"`);
    await this.#store.revokeToken(id, Date.now());
    log('token-revoked', null, { tenant, token: id });
  }

  async createTenant(name: TenantName, display: string, admins: readonly string[]): Promise<Tenant> {
    if (admins.length === 0) throw new InputError('a tenant needs at least one admin');
    const tenant: Tenant = { name, display, quota: DEFAULT_QUOTA, createdAt: Date.now() };
    await this.#store.transaction(async (tx) => {
      if (await tx.tenant(name)) throw new Conflict(`tenant "${name}" exists`);
      await tx.putTenant(tenant);
      for (const user of admins) await tx.putMembership({ tenant: name, user, role: 'admin' });
    });
    log('tenant', null, { tenant: name, admins });
    return tenant;
  }

  async setQuota(name: TenantName, patch: Readonly<Record<string, unknown>>): Promise<Quota> {
    for (const [key, value] of Object.entries(patch)) {
      if (!(QUOTA_RESOURCES as readonly string[]).includes(key)) throw new InputError(`quota field "${key}" is not one of ${QUOTA_RESOURCES.join(', ')}`);
      if (value !== null && !(Number.isInteger(value) && (value as number) >= 0)) throw new InputError(`${key} must be a whole number or null for unlimited, got ${JSON.stringify(value)}`);
    }
    const quota = await this.#store.transaction(async (tx) => {
      const tenant = await this.#mustTenant(tx, name, 'update');
      const quota = { ...tenant.quota, ...patch } as Quota;
      await tx.putTenant({ ...tenant, quota });
      return quota;
    });
    log('quota', null, { tenant: name, quota });
    return quota;
  }

  async setMember(tenant: TenantName, user: string, role: Role, force: boolean): Promise<void> {
    await this.#store.transaction(async (tx) => {
      await this.#mustTenant(tx, tenant, 'update');
      if (role !== 'admin') await this.#keepAdmin(tx, tenant, user, force);
      await tx.putMembership({ tenant, user, role });
    });
    log('member', null, { tenant, user, role });
  }

  async removeMember(tenant: TenantName, user: string, force: boolean): Promise<void> {
    await this.#store.transaction(async (tx) => {
      await this.#mustTenant(tx, tenant, 'update');
      if (!(await tx.memberships({ tenant, user })).length) throw new NotFound(`"${user}" is not a member of tenant "${tenant}"`);
      await this.#keepAdmin(tx, tenant, user, force);
      await tx.deleteMembership(tenant, user);
    });
    log('member-removed', null, { tenant, user });
  }

  async #keepAdmin(tx: StoreOps, tenant: TenantName, leaving: string, force: boolean): Promise<void> {
    const admins = (await tx.memberships({ tenant })).filter((m) => m.role === 'admin');
    if (!force && admins.length === 1 && admins[0]!.user === leaving) throw new Conflict(`"${leaving}" is the last admin of tenant "${tenant}"; make another member admin first`);
  }

  async setAccess(name: AppName, access: Access): Promise<void> {
    await this.#updateApp(name, (app) => ({ ...app, access }));
    await this.#refresh(name);
    log('access', name, { access });
  }

  moveApp(name: AppName, tenant: TenantName): Promise<void> {
    return this.#store.exclusive(name, async () => {
      const app = await this.#mustApp(name);
      await this.#mustTenant(this.#store, tenant);
      if (app.status === 'purging') throw new Conflict(`app "${name}" is being purged`);
      if (app.tenant === tenant) return;
      await this.#runtime.retire(app.id);
      await this.#updateApp(name, (fresh) => ({ ...fresh, tenant }));
      await this.#refresh(name);
      this.#emit(app.id);
      log('move', name, { from: app.tenant, to: tenant });
    });
  }

  /** The authentication path's User write: once per user per 5 min on this replica, at once when the name or groups change (ADR 0022 item 1). */
  async sighted(id: string, name: string, groups: readonly string[]): Promise<void> {
    const key = JSON.stringify([name, groups]);
    const at = Date.now();
    const last = this.#sightings.get(id);
    if (last && last.key === key && at - last.at < SIGHTING_MS) return;
    await this.#store.putUser({ id, name, groups, firstSeen: at, lastSeen: at });
    this.#sightings.set(id, { key, at });
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

  async listing(): Promise<Listed[]> {
    const stats = new Map((await this.#stats()).map((s) => [s.app, s]));
    return [...this.#views.values()].map((view) => {
      const s = stats.get(view.app);
      return {
        name: view.name,
        address: address(this.#addressing, view.name),
        tenant: view.tenant,
        access: view.access,
        release: view.release,
        capabilities: [...view.kinds],
        status: view.status,
        instance: this.#runtime.state(view.app),
        since: this.#runtime.since(view.app),
        leases: this.#runtime.leases(view.app),
        sleepsAt: this.#runtime.sleepsAt(view.app),
        runtime: this.#runtimes.get(view.app) ?? null,
        quarantine: this.#guard.quarantine(view.app),
        dbBackend: view.kinds.has('db') ? effectivePolicy(this.#policy, view.policyOverride).db_backend : null,
        lastAccessAt: s?.lastAccessAt ?? null,
        requests: s?.requests ?? 0,
        errors: s?.errors ?? 0,
        node: null,
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
        quarantine: this.#guard.quarantine(app.id),
      };
    });
  }

  onAppChanged(listener: (app: AppId) => void): void {
    this.#changed.on('changed', listener);
  }

  /** Resolves once every interrupted purge and binding convergence has run; startup need not await it. */
  async resume(): Promise<void> {
    const apps = await this.#store.apps();
    const work = apps.map((app) => this.#store.exclusive(app.name, async () => {
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
      if (!app) return this.#forget(name);
      const release = await currentRelease(tx, app);
      const policy = effectivePolicy(this.#policy, app.policyOverride);
      const view: RouteView = Object.freeze({
        app: app.id,
        name,
        tenant: app.tenant,
        access: app.access,
        status: app.status,
        owner: app.owner,
        release: release?.number ?? null,
        image: release?.image ?? null,
        runtime: release?.runtime ?? null,
        kinds: new Set(release ? declaredKinds(release.manifest) : []),
        bundle: (release?.manifest.capabilities.static && release.bundle && this.#indexes.get(release.bundle)) || null,
        staticRoot: release?.runtime === 'isolate' && release.manifest.capabilities.static ? `${release.manifest.capabilities.static.dir}/` : '',
        identity: release?.manifest.capabilities.identity ?? null,
        policyOverride: Object.freeze({ ...app.policyOverride }),
      });
      this.#views.set(name, view);
      this.#names.set(app.id, name);
      this.#runtimes.set(app.id, release?.runtime ?? null);
      const spec = release?.runtime && app.status === 'registered' ? this.#spec(app, release, await tx.bindings(app.id), policy) : null;
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

  #spec(app: App, release: Release, bindings: readonly Binding[], policy: Policy): RunSpec {
    const providers = bindings
      .filter((b) => b.state === 'active' && desiredState(app, release.manifest, policy, b) === 'active')
      .map((b) => [this.#provider(b.provider), b.resource] as const);
    const injections = providers.map(([provider, resource]) => provider.inject(app.id, resource));
    return {
      app: app.id,
      name: app.name,
      tenant: app.tenant,
      release: release.number,
      runtime: release.runtime === 'isolate'
        ? { kind: 'isolate', bundle: release.bundle!, entry: release.manifest.entry ?? DEFAULT_ENTRY }
        : { kind: 'container', image: release.image! },
      injection: {
        env: Object.assign({}, ...injections.map((i) => i.env)),
        storage: injections.flatMap((i) => i.storage),
        services: [...new Set(providers.flatMap(([provider]) => (provider.service ? [provider.service] : [])))],
      },
      policy,
    };
  }

  async #mustTenant(store: StoreOps, name: TenantName, lock?: 'update'): Promise<Tenant> {
    const tenant = await store.tenant(name, lock);
    if (!tenant) throw new NotFound(`no tenant named "${name}"`);
    return tenant;
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
}
