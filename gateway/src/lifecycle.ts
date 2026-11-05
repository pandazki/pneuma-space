import { setTimeout as sleep } from 'node:timers/promises';
import { emit, type Emit } from './events.ts';
import {
  canonicalHash, NotFound,
  type AppId, type HealthCheck, type InstanceState, type Lease, type LeaseKind, type Runtime, type RunSpec, type RuntimeKind,
} from './model.ts';

const MAX_TICK_SECONDS = 10;

/** What a driver realized for an instance: `handle` survives sleep when the driver keeps it (a stopped container). */
export type Slot<S extends RunSpec, H> = { spec: S; handle: H | null };

/** An instance found at startup; `address` null means it exists but is not running. */
export type Adopted<H> = { readonly app: AppId; readonly handle: H; readonly release: string; readonly spec: string; readonly address: string | null };

/** How a running instance ended without the lifecycle asking; null failure means it was stopped from outside. */
export type Failure = { readonly ev: 'crashed' | 'hung'; readonly reason: string } | null;
export type Gone<H> = (app: AppId, handle: H, failure: Failure) => void;

/** How one runtime starts, stops and observes instances; the lifecycle owns states, leases and the reaper. */
export interface Driver<S extends RunSpec, H> {
  readonly kind: RuntimeKind;
  /** The key a handle is logged under in lifecycle events. */
  readonly handleKey: string;
  accepts(spec: RunSpec): spec is S;
  /** Starts `spec`, keeping `slot.handle` current as it goes; resolves with the address once ready, else cleans up and throws. */
  start(slot: Slot<S, H>, spec: S): Promise<string>;
  /** Idle stop; the driver may keep the handle for the next start. */
  sleep(app: AppId, slot: Slot<S, H>): Promise<void>;
  remove(app: AppId, handle: H): Promise<void>;
  adopt(): Promise<readonly Adopted<H>[]>;
  /** Reports instances that end on their own until `signal` aborts. */
  follow(gone: Gone<H>, signal: AbortSignal): void;
  logs(app: AppId, handle: H | null, tail: number): Promise<string>;
  health(): readonly HealthCheck[];
  destroyStorage(app: AppId, id: string): Promise<void>;
}

type Instance<S extends RunSpec, H> = Slot<S, H> & {
  readonly app: AppId;
  state: InstanceState;
  address: string;
  readonly leases: Map<Lease, LeaseRecord>;
  lastReleaseAt: number;
  since: number;
  wake: Promise<void>;
  changed: PromiseWithResolvers<void>;
};

/** `onRetire` is set only for a channel. */
type LeaseRecord = { readonly kind: LeaseKind; readonly onRetire: (() => void) | null };

export type LifecycleOptions = {
  /** The Registry's runSpec; re-read on every wake and reaper tick so policy changes apply without a publish. Specs of other runtimes read as none. */
  readonly specFor: (app: AppId) => RunSpec | null;
  readonly log?: Emit;
};

export const specHash = (spec: RunSpec): string => canonicalHash(spec.injection);

// JavaScript runs each synchronous stretch to completion, so the code between two awaits is the per-instance lock;
// `changed` is its condition variable.
export class Lifecycle<S extends RunSpec, H> implements Runtime {
  readonly kind: RuntimeKind;
  readonly #driver: Driver<S, H>;
  readonly #specFor: (app: AppId) => S | null;
  readonly #log: Emit;
  readonly #instances = new Map<AppId, Instance<S, H>>();
  readonly #awake = new Set<Instance<S, H>>();
  readonly #events = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #due = 0;
  #following = false;

  constructor(driver: Driver<S, H>, options: LifecycleOptions) {
    this.kind = driver.kind;
    this.#driver = driver;
    this.#specFor = (app) => {
      const spec = options.specFor(app);
      return spec && driver.accepts(spec) ? spec : null;
    };
    this.#log = options.log ?? emit;
  }

  async acquire(app: AppId, kind: 'request' | 'trigger'): Promise<Lease> {
    for (;;) {
      const spec = this.#specFor(app);
      if (!spec) throw new NotFound(`app ${app} has no registered release for runtime ${this.kind}`);
      let inst = this.#instances.get(app);
      if (!inst) {
        inst = { app, state: 'asleep', spec, handle: null, address: '', leases: new Map(), lastReleaseAt: 0, since: Date.now(), wake: Promise.resolve(), changed: Promise.withResolvers() };
        this.#instances.set(app, inst);
      }
      switch (inst.state) {
        case 'awake': {
          const lease: Lease = { app, address: inst.address };
          inst.leases.set(lease, { kind, onRetire: null });
          return lease;
        }
        case 'asleep':
          this.#transition(inst, 'waking');
          inst.wake = this.#wake(inst, spec);
          await inst.wake;
          break;
        case 'waking':
          await inst.wake;
          break;
        default:
          await inst.changed.promise;
      }
    }
  }

  release(lease: Lease): void {
    const inst = this.#instances.get(lease.app);
    if (!inst?.leases.delete(lease)) return;
    if (inst.leases.size === 0) {
      inst.lastReleaseAt = Date.now();
      this.#notify(inst);
    }
  }

  channel(lease: Lease, onRetire: () => void): void {
    const inst = this.#instances.get(lease.app);
    if (!inst?.leases.has(lease)) return;
    inst.leases.set(lease, { kind: 'channel', onRetire });
    if (inst.state === 'draining') onRetire();
  }

  async retire(app: AppId): Promise<void> {
    for (;;) {
      const inst = this.#instances.get(app);
      if (!inst) return;
      switch (inst.state) {
        case 'awake':
          return this.#drain(inst);
        case 'asleep':
          this.#transition(inst, 'stopping');
          return this.#remove(inst);
        case 'waking':
          await inst.wake.catch(() => {});
          break;
        default:
          await inst.changed.promise;
      }
    }
  }

  async reconcile(): Promise<void> {
    for (const found of await this.#driver.adopt()) {
      const { app, handle } = found;
      if (this.#instances.get(app)?.handle === handle) continue;
      const spec = this.#specFor(app);
      if (!spec || this.#instances.has(app) || found.release !== String(spec.release) || found.spec !== specHash(spec)) {
        await this.#driver.remove(app, handle);
        this.#emit('removed', app, { [this.#driver.handleKey]: handle });
        continue;
      }
      const inst: Instance<S, H> = {
        app, state: 'asleep', spec, handle, address: found.address ?? '',
        leases: new Map(), lastReleaseAt: Date.now(), since: Date.now(), wake: Promise.resolve(), changed: Promise.withResolvers(),
      };
      this.#instances.set(app, inst);
      this.#transition(inst, found.address !== null ? 'awake' : 'asleep', { adopted: true });
    }
    if (!this.#following) {
      this.#following = true;
      this.#driver.follow(this.#gone, this.#events.signal);
    }
  }

  state(app: AppId): InstanceState | 'none' {
    return this.#instances.get(app)?.state ?? 'none';
  }

  since(app: AppId): number | null {
    return this.#instances.get(app)?.since ?? null;
  }

  leases(app: AppId): Record<LeaseKind, number> {
    const counts = { request: 0, channel: 0, trigger: 0 };
    for (const { kind } of this.#instances.get(app)?.leases.values() ?? []) counts[kind]++;
    return counts;
  }

  sleepsAt(app: AppId): number | null {
    const inst = this.#instances.get(app);
    if (inst?.state !== 'awake' || inst.leases.size > 0) return null;
    return inst.lastReleaseAt + this.#policy(inst).idle_seconds * 1000;
  }

  async logs(app: AppId, tail: number): Promise<string> {
    const inst = this.#instances.get(app);
    return inst ? this.#driver.logs(app, inst.handle, tail) : '';
  }

  health(): readonly HealthCheck[] {
    return this.#driver.health();
  }

  destroyStorage(app: AppId, id: string): Promise<void> {
    return this.#driver.destroyStorage(app, id);
  }

  /** Stops the reaper and the driver's event subscription; instances keep running for the next reconcile to adopt. */
  close(): void {
    this.#events.abort();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #policy(inst: Instance<S, H>) {
    return (this.#specFor(inst.app) ?? inst.spec).policy;
  }

  async #wake(inst: Instance<S, H>, spec: S): Promise<void> {
    const started = performance.now();
    try {
      inst.address = await this.#driver.start(inst, spec);
      inst.lastReleaseAt = Date.now();
      this.#transition(inst, 'awake', { ms: Math.round(performance.now() - started) });
    } catch (error) {
      this.#transition(inst, 'asleep', { error: String(error) });
      throw error;
    }
  }

  async #drain(inst: Instance<S, H>): Promise<void> {
    this.#transition(inst, 'draining');
    for (const { onRetire } of inst.leases.values()) {
      try {
        onRetire?.();
      } catch (error) {
        this.#emit('retire-error', inst.app, { error: String(error) });
      }
    }
    const seconds = this.#policy(inst).drain_timeout_seconds;
    const timer = new AbortController();
    const timeout = sleep(seconds * 1000, undefined, { signal: timer.signal }).then(() => true, () => true);
    let expired = false;
    while (inst.leases.size > 0 && !expired) expired = await Promise.race([timeout, inst.changed.promise.then(() => false)]);
    timer.abort();
    this.#transition(inst, 'stopping', { leases: inst.leases.size });
    await this.#remove(inst);
  }

  async #remove(inst: Instance<S, H>): Promise<void> {
    try {
      if (inst.handle !== null) await this.#driver.remove(inst.app, inst.handle);
    } catch (error) {
      this.#transition(inst, 'asleep', { error: String(error) });
      throw error;
    }
    this.#instances.delete(inst.app);
    this.#awake.delete(inst);
    this.#notify(inst);
    this.#emit('removed', inst.app, { [this.#driver.handleKey]: inst.handle });
  }

  async #sleep(inst: Instance<S, H>): Promise<void> {
    this.#transition(inst, 'stopping');
    try {
      await this.#driver.sleep(inst.app, inst);
      this.#transition(inst, 'asleep');
    } catch (error) {
      inst.lastReleaseAt = Date.now();
      this.#transition(inst, 'awake', { error: String(error) });
    }
  }

  readonly #gone: Gone<H> = (app, handle, failure) => {
    const inst = this.#instances.get(app);
    if (inst?.state !== 'awake' || inst.handle !== handle) return;
    inst.address = '';
    if (failure) this.#emit(failure.ev, app, { reason: failure.reason });
    this.#transition(inst, 'asleep', { external: true });
  };

  readonly #tick = (): void => {
    this.#timer = null;
    const now = Date.now();
    let next = MAX_TICK_SECONDS;
    for (const inst of this.#awake) {
      const idle = this.#policy(inst).idle_seconds;
      next = Math.min(next, idle);
      if (inst.leases.size === 0 && now - inst.lastReleaseAt >= idle * 1000) void this.#sleep(inst);
    }
    if (this.#awake.size > 0) this.#arm(next);
  };

  #arm(seconds: number): void {
    if (this.#events.signal.aborted) return;
    const due = Date.now() + seconds * 1000;
    if (this.#timer && this.#due <= due) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#due = due;
    this.#timer = setTimeout(this.#tick, seconds * 1000);
    this.#timer.unref();
  }

  #transition(inst: Instance<S, H>, state: InstanceState, extra: Record<string, unknown> = {}): void {
    inst.state = state;
    inst.since = Date.now();
    if (state === 'awake') {
      this.#awake.add(inst);
      this.#arm(Math.min(MAX_TICK_SECONDS, this.#policy(inst).idle_seconds));
    } else {
      this.#awake.delete(inst);
    }
    this.#notify(inst);
    this.#emit(state, inst.app, extra);
  }

  #notify(inst: Instance<S, H>): void {
    const { resolve } = inst.changed;
    inst.changed = Promise.withResolvers();
    resolve();
  }

  #emit(ev: string, app: AppId, extra: Record<string, unknown>): void {
    this.#log(ev, app, extra);
  }
}
