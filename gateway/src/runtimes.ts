import { emit, quotaRefused, type Emit, type QuotaRefused } from './events.ts';
import type { Instances } from './instances.ts';
import type { Series } from './metrics.ts';
import {
  admits, Conflict, NotFound, QuotaExceeded, RUNTIMES,
  type AppId, type Guard, type HealthCheck, type InstanceState, type Lease, type LeaseKind, type Quarantine,
  type Runtime, type RunSpec, type RuntimeKind, type StoreOps,
} from './model.ts';

/** A wake inside `restart_backoff_seconds` of the app's last failure. */
export class Backoff extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`the app failed moments ago; retry in ${retryAfterSeconds} s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The runtime's service did not answer; `reason` names it on the kubernetes plane, where there is no compose profile to start. */
export class Unavailable extends Conflict {
  constructor(kind: RuntimeKind, reason?: string) {
    super(reason ?? `runtime ${kind} is not available; start docker compose --profile ${RUNTIMES[kind].profile}`);
  }
}

export class Quarantined extends Error {
  readonly quarantine: Quarantine;
  constructor(quarantine: Quarantine) {
    super(`the app is quarantined after ${quarantine.failures} failures (${quarantine.reason}); publish a new release or POST /api/apps/<name>/unquarantine`);
    this.quarantine = quarantine;
  }
}

export type RuntimesOptions = {
  readonly runtimes: readonly Runtime[];
  readonly specFor: (app: AppId) => RunSpec | null;
  readonly instances: Instances;
  readonly quotaRefused?: QuotaRefused;
};

/** A wake refused by the tenant's quota answers 503 with this Retry-After; a refused delivery waits as long (ADR 0023 item 5). */
export const QUOTA_RETRY_SECONDS = 30;

/** What a wake takes from its tenant's quota (ADR 0023): an isolate worker shares the runner's CPU, so it records none. */
export const instanceShape = (spec: RunSpec) => ({ cpuMillis: spec.runtime.kind === 'isolate' ? 0 : spec.policy.cpu_millis, memoryMb: spec.policy.memory_mb });

/** The one Runtime the rest of the gateway sees: dispatches by the RunSpec's runtime (ADR 0017). */
export class Runtimes implements Omit<Runtime, 'kind'> {
  readonly #byKind: ReadonlyMap<RuntimeKind, Runtime>;
  readonly #specFor: (app: AppId) => RunSpec | null;
  readonly #instances: Instances;
  readonly #quotaRefused: QuotaRefused;
  readonly #owners = new WeakMap<Lease, Runtime>();

  constructor(options: RuntimesOptions) {
    this.#byKind = new Map(options.runtimes.map((runtime) => [runtime.kind, runtime]));
    this.#specFor = options.specFor;
    this.#instances = options.instances;
    this.#quotaRefused = options.quotaRefused ?? quotaRefused;
  }

  async acquire(app: AppId, kind: 'request' | 'trigger'): Promise<Lease> {
    const spec = this.#specFor(app);
    if (!spec) throw new NotFound(`app ${app} has no registered release with a runtime`);
    const runtime = this.#byKind.get(spec.runtime.kind);
    if (!runtime) throw new Unavailable(spec.runtime.kind);
    const row = this.#instances.row(app);
    // One row per app: the old runtime's instance goes before the new runtime wakes; an asleep row with no handle holds nothing.
    if (row && row.runtime !== runtime.kind && (row.state !== 'asleep' || row.handle !== null)) await this.#byKind.get(row.runtime)?.retire(app);
    const lease = await runtime.acquire(app, kind).catch((error: unknown) => {
      if (error instanceof QuotaExceeded) this.#quotaRefused(error, app, 'wake');
      throw error;
    });
    this.#owners.set(lease, runtime);
    return lease;
  }

  release(lease: Lease): void {
    this.#owners.get(lease)?.release(lease);
  }

  channel(lease: Lease, onRetire: () => void): void {
    this.#owners.get(lease)?.channel(lease, onRetire);
  }

  async retire(app: AppId): Promise<void> {
    await Promise.all(this.#all().map((runtime) => runtime.retire(app)));
  }

  async kill(app: AppId): Promise<void> {
    await Promise.all(this.#all().map((runtime) => runtime.kill(app)));
  }

  async reconcile(): Promise<void> {
    await Promise.all(this.#all().map((runtime) => runtime.reconcile()));
  }

  async destroyStorage(app: AppId, id: string): Promise<void> {
    await Promise.all(this.#all().map((runtime) => runtime.destroyStorage(app, id)));
  }

  state(app: AppId): InstanceState | 'none' {
    return this.#holder(app)?.state(app) ?? 'none';
  }

  since(app: AppId): number | null {
    return this.#holder(app)?.since(app) ?? null;
  }

  leases(app: AppId): Readonly<Record<LeaseKind, number>> {
    return this.#holder(app)?.leases(app) ?? { request: 0, channel: 0, trigger: 0 };
  }

  sleepsAt(app: AppId): number | null {
    return this.#holder(app)?.sleepsAt(app) ?? null;
  }

  async logs(app: AppId, tail: number): Promise<string> {
    return (await this.#holder(app)?.logs(app, tail)) ?? '';
  }

  /** What the platform as a whole detects: the union over its runtimes. */
  health(): readonly HealthCheck[] {
    return [...new Set(this.#all().flatMap((runtime) => runtime.health()))];
  }

  /** What one runtime detects; empty for a kind with no registered implementation. */
  healthOf(kind: RuntimeKind): readonly HealthCheck[] {
    return this.#byKind.get(kind)?.health() ?? [];
  }

  #all(): Runtime[] {
    return [...this.#byKind.values()];
  }

  #holder(app: AppId): Runtime | null {
    const row = this.#instances.row(app);
    return row ? (this.#byKind.get(row.runtime) ?? null) : null;
  }
}

export type GuardOptions = {
  readonly instances: Instances;
  readonly specFor: (app: AppId) => RunSpec | null;
  readonly log?: Emit;
  readonly now?: () => number;
  readonly series?: Pick<Series, 'wake'>;
};

/**
 * The only place that counts failures and quarantines (ADR 0017), on the app's guard row inside the transaction that observed the failure
 * (ADR 0020 item 5). It also owns wake admission: quarantine, backoff, then the tenant's quota under its row lock (ADR 0023 item 3).
 */
export class AppGuard implements Guard {
  readonly #instances: Instances;
  readonly #specFor: (app: AppId) => RunSpec | null;
  readonly #log: Emit;
  readonly #now: () => number;
  readonly #series: Pick<Series, 'wake'> | undefined;

  constructor(options: GuardOptions) {
    this.#instances = options.instances;
    this.#specFor = options.specFor;
    this.#log = options.log ?? emit;
    this.#now = options.now ?? Date.now;
    this.#series = options.series;
  }

  /** A guard row of an older release reads as none: a new release starts clean. */
  quarantine(app: AppId): Quarantine | null {
    const record = this.#instances.guard(app);
    if (!record || record.quarantinedAt === null || record.release !== this.#specFor(app)?.release) return null;
    return { reason: record.quarantineReason ?? '', since: record.quarantinedAt, failures: record.failures.length };
  }

  /** Deletes the guard row; resolves once it is gone, so the caller's next request finds the app admitted. */
  async unquarantine(app: AppId): Promise<void> {
    const lifted = this.quarantine(app);
    await this.#instances.store.deleteGuard(app);
    await this.#instances.refresh(app);
    if (lifted) this.#log('unquarantined', app);
  }

  /** Inside the wake transaction; throws Quarantined, Backoff or QuotaExceeded and writes only through `tx`. */
  readonly admit = async (tx: StoreOps, spec: RunSpec): Promise<void> => {
    const refusal = await this.#refusal(tx, spec);
    if (!refusal) return;
    this.#series?.wake(spec.tenant, spec.runtime.kind, 'refused');
    throw refusal;
  };

  async #refusal(tx: StoreOps, spec: RunSpec): Promise<Quarantined | Backoff | QuotaExceeded | null> {
    const record = await tx.guard(spec.app, 'update');
    if (record && record.release !== spec.release) await tx.deleteGuard(spec.app);
    else if (record) {
      if (record.quarantinedAt !== null) return new Quarantined({ reason: record.quarantineReason ?? '', since: record.quarantinedAt, failures: record.failures.length });
      const wait = record.failures.at(-1)! + spec.policy.restart_backoff_seconds * 1000 - this.#now();
      if (wait > 0) return new Backoff(Math.ceil(wait / 1000));
    }
    const tenant = await tx.tenant(spec.tenant, 'update');
    if (!tenant) return null;
    const shape = instanceShape(spec);
    const refusal = admits(tenant.quota, await tx.quotaUsed(spec.tenant), { awake: 1, cpu_millis: shape.cpuMillis, memory_mb: shape.memoryMb });
    return refusal && new QuotaExceeded(spec.tenant, refusal);
  }

  /** Records one failure inside the transaction that won the CAS observing it; returns the quarantine it caused, for the caller to announce after commit. */
  async fail(tx: StoreOps, spec: RunSpec, reason: string): Promise<Quarantine | null> {
    const now = this.#now();
    const found = await tx.guard(spec.app, 'update');
    const record = found?.release === spec.release ? found : null;
    const failures = [...(record?.failures ?? []).filter((t) => t > now - spec.policy.failure_window_seconds * 1000), now];
    const quarantined = record?.quarantinedAt == null && failures.length >= spec.policy.max_failures;
    await tx.putGuard({
      app: spec.app, release: spec.release, failures,
      quarantineReason: quarantined ? reason : (record?.quarantineReason ?? null),
      quarantinedAt: quarantined ? now : (record?.quarantinedAt ?? null),
    });
    return quarantined ? { reason, since: now, failures: failures.length } : null;
  }

  announce(app: AppId, quarantine: Quarantine): void {
    this.#log('quarantined', app, { reason: quarantine.reason, failures: quarantine.failures });
  }

  /** A removed instance starts clean, so republishing the same release after remove is not still quarantined. */
  async clear(tx: StoreOps, app: AppId): Promise<void> {
    await tx.deleteGuard(app);
  }
}
