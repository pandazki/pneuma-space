import { emit, type Emit, type EventLog, type LifecycleEvent } from './events.ts';
import {
  Conflict, NotFound, RUNTIMES,
  type AppId, type Guard, type HealthCheck, type InstanceState, type Lease, type LeaseKind, type Quarantine, type ReleaseNumber,
  type Runtime, type RunSpec, type RuntimeKind,
} from './model.ts';

/** A wake inside `restart_backoff_seconds` of the app's last failure. */
export class Backoff extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`the app failed moments ago; retry in ${retryAfterSeconds} s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class Quarantined extends Error {
  readonly quarantine: Quarantine;
  constructor(quarantine: Quarantine) {
    super(`the app is quarantined after ${quarantine.failures} failures (${quarantine.reason}); publish a new release or POST /api/apps/<name>/unquarantine`);
    this.quarantine = quarantine;
  }
}

/** Failure times (epoch ms) inside the window, counted against one release; a new release starts clean. */
type Health = { readonly release: ReleaseNumber; failures: number[]; quarantine: Quarantine | null };

const INSTANCE_STATES: ReadonlySet<string> = new Set<InstanceState>(['asleep', 'waking', 'awake', 'draining', 'stopping']);

export type RuntimesOptions = {
  readonly runtimes: readonly Runtime[];
  readonly specFor: (app: AppId) => RunSpec | null;
  readonly events: Pick<EventLog, 'onEvent'>;
  readonly log?: Emit;
  readonly now?: () => number;
};

/** The one Runtime the rest of the gateway sees: dispatches by the RunSpec's runtime and guards every wake (ADR 0017). */
export class Runtimes implements Omit<Runtime, 'kind'>, Guard {
  readonly #byKind: ReadonlyMap<RuntimeKind, Runtime>;
  readonly #specFor: (app: AppId) => RunSpec | null;
  readonly #log: Emit;
  readonly #now: () => number;
  readonly #owners = new WeakMap<Lease, Runtime>();
  readonly #health = new Map<AppId, Health>();
  /** Last instance state per app, so a failed wake (waking, then asleep with an error) is told from other errors. */
  readonly #states = new Map<string, string>();

  constructor(options: RuntimesOptions) {
    this.#byKind = new Map(options.runtimes.map((runtime) => [runtime.kind, runtime]));
    this.#specFor = options.specFor;
    this.#log = options.log ?? emit;
    this.#now = options.now ?? Date.now;
    options.events.onEvent((event) => this.#observe(event));
  }

  async acquire(app: AppId, kind: 'request' | 'trigger'): Promise<Lease> {
    const spec = this.#specFor(app);
    if (!spec) throw new NotFound(`app ${app} has no registered release with a runtime`);
    const runtime = this.#byKind.get(spec.runtime.kind);
    if (!runtime) throw new Conflict(`runtime ${spec.runtime.kind} is not available; start docker compose --profile ${RUNTIMES[spec.runtime.kind].profile}`);
    this.#admit(spec);
    const lease = await runtime.acquire(app, kind);
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

  quarantine(app: AppId): Quarantine | null {
    return this.#current(app)?.quarantine ?? null;
  }

  unquarantine(app: AppId): void {
    const lifted = this.#health.get(app)?.quarantine;
    this.#health.delete(app);
    if (lifted) this.#log('unquarantined', app);
  }

  #all(): Runtime[] {
    return [...this.#byKind.values()];
  }

  /** The spec's runtime, unless another one still holds an instance of the app (it moved between runtimes). */
  #holder(app: AppId): Runtime | null {
    const kind = this.#specFor(app)?.runtime.kind;
    const own = kind === undefined ? null : this.#byKind.get(kind) ?? null;
    if (own && own.state(app) !== 'none') return own;
    return this.#all().find((runtime) => runtime.state(app) !== 'none') ?? own;
  }

  #current(app: AppId): Health | null {
    const health = this.#health.get(app);
    const release = this.#specFor(app)?.release;
    if (health && release !== undefined && release !== health.release) {
      this.#health.delete(app);
      return null;
    }
    return health ?? null;
  }

  #admit(spec: RunSpec): void {
    const health = this.#current(spec.app);
    if (!health) return;
    if (health.quarantine) throw new Quarantined(health.quarantine);
    const wait = health.failures.at(-1)! + spec.policy.restart_backoff_seconds * 1000 - this.#now();
    if (wait > 0) throw new Backoff(Math.ceil(wait / 1000));
  }

  #observe(event: LifecycleEvent): void {
    if (event.app === null) return;
    const before = this.#states.get(event.app);
    if (INSTANCE_STATES.has(event.ev)) this.#states.set(event.app, event.ev);
    else if (event.ev === 'removed') this.#states.delete(event.app);
    if (event.ev === 'crashed' || event.ev === 'hung') this.#fail(event.app as AppId, String(event.reason ?? event.ev));
    else if (event.ev === 'asleep' && before === 'waking' && event.error !== undefined) this.#fail(event.app as AppId, String(event.error));
  }

  #fail(app: AppId, reason: string): void {
    const spec = this.#specFor(app);
    if (!spec) return;
    const now = this.#now();
    const health = this.#current(app) ?? { release: spec.release, failures: [], quarantine: null };
    this.#health.set(app, health);
    health.failures = [...health.failures.filter((t) => t > now - spec.policy.failure_window_seconds * 1000), now];
    if (health.quarantine || health.failures.length < spec.policy.max_failures) return;
    health.quarantine = { reason, since: now, failures: health.failures.length };
    this.#log('quarantined', app, { reason, failures: health.failures.length });
  }
}
