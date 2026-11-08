import { setTimeout as sleep } from 'node:timers/promises';
import { emit, type Emit } from './events.ts';
import { DEAD_MS, type Instances } from './instances.ts';
import {
  canonicalHash, DEFAULT_POLICY, NotFound,
  type AppId, type HealthCheck, type Instance, type InstanceState, type Lease, type LeaseKind, type LeaseTally, type Policy, type ReleaseNumber,
  type Runtime, type RunSpec, type RuntimeKind, type StoreOps,
} from './model.ts';
import { AppGuard, instanceShape, Unavailable } from './runtimes.ts';

const MAX_TICK_SECONDS = 10;
/** A release that leaves the tally at 0, or changes its kinds, is written at most this much later (ADR 0020 item 4). */
const FLUSH_MS = 1000;
const TAKEOVER_MS = 5000;
/** How long a wake waits for the Registry to catch up with a newer app row before reading the RunSpec again. */
const STALE_MS = 50;

/** What a driver realized for an instance, persisted in its row: `handle` survives sleep when the driver keeps it (a stopped container), with the release and spec hash it was made for. */
export type Slot<H extends string> = { handle: H | null; release: ReleaseNumber; specHash: string };

/** An instance found at startup; `address` null means it exists but is not running. */
export type Adopted<H> = { readonly app: AppId; readonly handle: H; readonly release: string; readonly spec: string; readonly address: string | null };

/**
 * How a running instance ended without the lifecycle asking: a failure the Guard counts, a stop from outside,
 * or its runtime no longer answering, which is the platform's fault and not the app's.
 */
export type Ending = { readonly ev: 'crashed' | 'hung'; readonly reason: string } | { readonly ev: 'stopped' } | { readonly ev: 'unavailable' };
export type Gone<H> = (app: AppId, handle: H, ending: Ending) => void;

/** How one runtime starts, stops and observes instances; the lifecycle owns states, leases and the reaper. Throws Unavailable when its service cannot be reached. */
export interface Driver<S extends RunSpec, H extends string> {
  readonly kind: RuntimeKind;
  /** The key a handle is logged under in lifecycle events. */
  readonly handleKey: string;
  accepts(spec: RunSpec): spec is S;
  /** Starts `spec`, keeping `slot` current as it goes; resolves with the address once ready, else cleans up and throws. */
  start(slot: Slot<H>, spec: S): Promise<string>;
  /** Idle stop; the driver may keep the handle for the next start. */
  sleep(app: AppId, slot: Slot<H>): Promise<void>;
  remove(app: AppId, handle: H): Promise<void>;
  /** Removes an instance reconcile found stale; false when the driver deferred it to its own retry instead of failing the gateway's start. */
  discard(app: AppId, handle: H): Promise<boolean>;
  /** Null when the runtime's service could not be asked, so nothing it holds is known to be gone. */
  adopt(): Promise<readonly Adopted<H>[] | null>;
  /** Reports instances that end on their own until `signal` aborts. */
  follow(gone: Gone<H>, signal: AbortSignal): void;
  logs(app: AppId, handle: H | null, tail: number): Promise<string>;
  health(): readonly HealthCheck[];
  destroyStorage(app: AppId, id: string): Promise<void>;
}

type Counts = Record<LeaseKind, number>;
/** `onRetire` is set only for a channel. */
type LeaseRecord = { readonly kind: LeaseKind; readonly onRetire: (() => void) | null };

/** This replica's leases on one app and its queue of lease_tally writes. */
type Local = {
  readonly leases: Map<Lease, LeaseRecord>;
  /** The count of the last tally write committed or queued, recorded at enqueue time; the fast path needs it above 0 for the row's epoch. */
  queued: { readonly epoch: number; readonly total: number } | null;
  queue: Promise<unknown>;
  lastReleaseAt: number | null;
  dirty: boolean;
  flush: NodeJS.Timeout | null;
  /** The epoch whose drain already closed this replica's channels. */
  retired: number;
  /** The epoch whose handle the driver reported gone; the fast path stops at once, before the CAS lands. */
  ended: number;
  /** Resolved on every release here, so a drain this replica runs sees its own leases end at once. */
  changed: PromiseWithResolvers<void>;
};

export type LifecycleOptions = {
  /** The Registry's runSpec; re-read on every wake and reaper tick so policy changes apply without a publish. Specs of other runtimes read as none. */
  readonly specFor: (app: AppId) => RunSpec | null;
  readonly instances: Instances;
  /** Shared by every runtime in the gateway; one over `instances` when absent. */
  readonly guard?: AppGuard;
  readonly log?: Emit;
};

/** Covers what changes the instance's shape (ADR 0023 item 1). */
export const specHash = (spec: RunSpec): string =>
  canonicalHash({ injection: spec.injection, cpu_millis: spec.policy.cpu_millis, memory_mb: spec.policy.memory_mb });

/** Why an instance fell back to asleep: an Unavailable runtime carries no error, so neither the Guard nor the metrics count it. */
const cause = (error: unknown): Record<string, unknown> => (error instanceof Unavailable ? { unavailable: true } : { error: String(error) });
const total = (c: Counts): number => c.request + c.channel + c.trigger;

/**
 * Instance state lives in the `instance` row, written only by CAS on (runtime, state, epoch) (ADR 0020); this replica holds a mirror
 * of the rows and its own leases, so a warm acquire and every listing read are zero IO. Events are emitted after commit.
 */
export class Lifecycle<S extends RunSpec, H extends string> implements Runtime {
  readonly kind: RuntimeKind;
  readonly #driver: Driver<S, H>;
  readonly #anySpec: (app: AppId) => RunSpec | null;
  readonly #specFor: (app: AppId) => S | null;
  readonly #instances: Instances;
  readonly #guard: AppGuard;
  readonly #log: Emit;
  readonly #local = new Map<AppId, Local>();
  /** This replica's wakes in flight; its own waiters share the outcome, as a failed wake fails every request waiting on it. */
  readonly #wakes = new Map<AppId, Promise<void>>();
  readonly #events = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #due = 0;
  #takeover: NodeJS.Timeout | null = null;
  #following = false;

  constructor(driver: Driver<S, H>, options: LifecycleOptions) {
    this.kind = driver.kind;
    this.#driver = driver;
    this.#anySpec = options.specFor;
    this.#specFor = (app) => {
      const spec = options.specFor(app);
      return spec && driver.accepts(spec) ? spec : null;
    };
    this.#instances = options.instances;
    this.#guard = options.guard ?? new AppGuard({ instances: options.instances, specFor: options.specFor, log: options.log });
    this.#log = options.log ?? emit;
    this.#instances.onChange((app) => this.#observe(app));
  }

  get #me() {
    return this.#instances.replica;
  }

  get #store() {
    return this.#instances.store;
  }

  async acquire(app: AppId, kind: 'request' | 'trigger'): Promise<Lease> {
    await this.#instances.ready();
    for (;;) {
      const spec = this.#specFor(app);
      if (!spec) throw new NotFound(`app ${app} has no registered release for runtime ${this.kind}`);
      const row = this.#instances.row(app);
      const local = this.#localOf(app);
      if (row?.runtime === this.kind && row.state === 'awake' && local.ended !== row.epoch) {
        if (local.queued?.epoch === row.epoch && local.queued.total > 0) return this.#lease(local, row, kind);
        const lease = await this.#slow(app, row, kind);
        if (lease) return lease;
        continue;
      }
      const waking = this.#wakes.get(app);
      if (waking) {
        await waking;
        continue;
      }
      if (!row || row.state === 'asleep') {
        const wake = this.#wake(app, spec, kind);
        const settled = wake.then(() => {});
        settled.catch(() => {});
        this.#wakes.set(app, settled);
        try {
          const lease = await wake;
          if (lease) return lease;
        } finally {
          this.#wakes.delete(app);
        }
        continue;
      }
      await this.#instances.changed(app);
    }
  }

  release(lease: Lease): void {
    const local = this.#local.get(lease.app);
    const record = local?.leases.get(lease);
    if (!local || !record) return;
    local.leases.delete(lease);
    if (local.leases.size === 0) local.lastReleaseAt = Date.now();
    if (local.leases.size === 0 || record.kind !== 'request') this.#dirty(lease.app, local);
    this.#touched(local);
  }

  channel(lease: Lease, onRetire: () => void): void {
    const local = this.#local.get(lease.app);
    if (!local?.leases.has(lease)) return;
    local.leases.set(lease, { kind: 'channel', onRetire });
    this.#dirty(lease.app, local);
    if (this.#mine(lease.app)?.state === 'draining') onRetire();
  }

  async retire(app: AppId): Promise<void> {
    await this.#instances.ready();
    for (;;) {
      const row = this.#mine(app);
      if (!row) return;
      switch (row.state) {
        case 'awake': {
          const draining = await this.#cas(row, { ...row, state: 'draining', actor: this.#me });
          if (draining) return this.#drain(draining);
          break;
        }
        case 'asleep':
          if (row.handle === null) {
            if (this.#instances.guard(app)) {
              await this.#store.transaction((tx) => this.#guard.clear(tx, app));
              await this.#instances.refresh(app);
            }
            return;
          }
          {
            const stopping = await this.#cas(row, { ...row, state: 'stopping', actor: this.#me });
            if (stopping) return this.#remove(stopping);
          }
          break;
        default: {
          const waking = this.#wakes.get(app);
          await (waking ? waking.catch(() => {}) : this.#instances.changed(app));
        }
      }
    }
  }

  /** Startup: load the mirror, compare it with what the driver reports, take over transitions left by a dead replica, then follow the driver. */
  async reconcile(): Promise<void> {
    await this.#instances.ready();
    if (this.#instances.leading) await this.#adopt();
    if (!this.#following) {
      this.#following = true;
      this.#driver.follow(this.#gone, this.#events.signal);
      void this.#instances.onLeader((leading) => this.#lead(leading));
    }
  }

  state(app: AppId): InstanceState | 'none' {
    return this.#mine(app)?.state ?? 'none';
  }

  since(app: AppId): number | null {
    return this.#mine(app)?.since ?? null;
  }

  /** This replica's live counts plus the other replicas' counts as last read. */
  leases(app: AppId): Record<LeaseKind, number> {
    const counts = this.#counts(this.#local.get(app));
    const row = this.#mine(app);
    for (const tally of row ? this.#others(row) : []) {
      counts.request += tally.request;
      counts.channel += tally.channel;
      counts.trigger += tally.trigger;
    }
    return counts;
  }

  sleepsAt(app: AppId): number | null {
    const row = this.#mine(app);
    if (row?.state !== 'awake' || total(this.leases(app)) > 0) return null;
    const releases = this.#others(row).map((t) => t.releasedAt ?? 0);
    const idleSince = Math.max(row.awakeAt ?? row.since, this.#local.get(app)?.lastReleaseAt ?? 0, ...releases);
    return idleSince + this.#policy(app).idle_seconds * 1000;
  }

  async logs(app: AppId, tail: number): Promise<string> {
    const row = this.#mine(app);
    return row ? this.#driver.logs(app, row.handle as H | null, tail) : '';
  }

  health(): readonly HealthCheck[] {
    return this.#driver.health();
  }

  destroyStorage(app: AppId, id: string): Promise<void> {
    return this.#driver.destroyStorage(app, id);
  }

  /** Stops the reaper, the takeover loop and the driver's event subscription; instances keep running for the next reconcile. */
  close(): void {
    this.#events.abort();
    this.#lead(false);
  }

  #mine(app: AppId): Instance | null {
    const row = this.#instances.row(app);
    return row?.runtime === this.kind ? row : null;
  }

  #others(row: Instance): LeaseTally[] {
    return this.#instances.tallies(row.app).filter((t) => t.replica !== this.#me && t.epoch === row.epoch);
  }

  #policy(app: AppId): Policy {
    return this.#anySpec(app)?.policy ?? DEFAULT_POLICY;
  }

  #localOf(app: AppId): Local {
    let local = this.#local.get(app);
    if (!local) {
      local = { leases: new Map(), queued: null, queue: Promise.resolve(), lastReleaseAt: null, dirty: false, flush: null, retired: -1, ended: -1, changed: Promise.withResolvers() };
      this.#local.set(app, local);
    }
    return local;
  }

  #counts(local: Local | undefined): Counts {
    const counts = { request: 0, channel: 0, trigger: 0 };
    for (const { kind } of local?.leases.values() ?? []) counts[kind]++;
    return counts;
  }

  #tally(app: AppId, epoch: number, counts: Counts, local: Local): LeaseTally {
    return { app, replica: this.#me, epoch, ...counts, releasedAt: local.lastReleaseAt };
  }

  #lease(local: Local, row: Instance, kind: LeaseKind): Lease {
    const lease: Lease = { app: row.app, address: row.address! };
    local.leases.set(lease, { kind, onRetire: null });
    return lease;
  }

  /** Every tally write of an app goes through this one queue, with the count recorded when it is queued (ADR 0020 item 4). */
  #enqueue<T>(local: Local, epoch: number, counts: Counts, write: () => Promise<T>): Promise<T> {
    local.queued = { epoch, total: total(counts) };
    const run = local.queue.then(write);
    local.queue = run.catch(() => {});
    return run;
  }

  /** The 0 to >0 edge of this replica's tally: one transaction that sees the row awake under a share lock (ADR 0020 item 4). */
  async #slow(app: AppId, row: Instance, kind: LeaseKind): Promise<Lease | null> {
    const local = this.#localOf(app);
    const lease = this.#lease(local, row, kind);
    const tally = this.#tally(app, row.epoch, this.#counts(local), local);
    const ok = await this.#enqueue(local, row.epoch, tally, () => this.#store.transaction(async (tx) => {
      const current = await tx.instance(app, 'share');
      if (current?.runtime !== this.kind || current.state !== 'awake' || current.epoch !== row.epoch) return false;
      await tx.putLeaseTally(tally);
      return true;
    })).catch((error: unknown) => {
      local.leases.delete(lease);
      throw error;
    });
    if (ok) {
      this.#instances.putTally(tally);
      return lease;
    }
    local.leases.delete(lease);
    if (local.queued?.epoch === row.epoch) local.queued = { epoch: row.epoch, total: 0 };
    await this.#instances.refresh(app);
    return null;
  }

  async #wake(app: AppId, spec: S, kind: LeaseKind): Promise<Lease | null> {
    const local = this.#localOf(app);
    const slot: Slot<H> = { handle: null, release: spec.release, specHash: specHash(spec) };
    const outcome = await this.#store.transaction(async (tx): Promise<Instance | 'lost' | 'stale' | 'gone'> => {
      const appRow = await tx.app(spec.name);
      if (!appRow || appRow.id !== app || appRow.status !== 'registered') return 'gone';
      if (spec.version < appRow.version) return 'stale';
      let current = await tx.instance(app, 'update');
      if (!current) {
        current = {
          app, runtime: this.kind, release: spec.release, specHash: slot.specHash, epoch: 0, state: 'asleep', actor: null, handle: null,
          address: null, node: null, home: null, since: Date.now(), awakeAt: null, cpuMillis: 0, memoryMb: 0,
        };
        await tx.insertInstance(current);
      }
      if (current.state !== 'asleep') return 'lost';
      await this.#guard.admit(tx, spec);
      const own = current.runtime === this.kind;
      slot.handle = own ? (current.handle as H | null) : null;
      slot.release = own ? current.release : spec.release;
      slot.specHash = own ? current.specHash : specHash(spec);
      const waking: Instance = {
        ...current, ...instanceShape(spec), runtime: this.kind, release: spec.release, specHash: specHash(spec), epoch: current.epoch + 1,
        state: 'waking', actor: this.#me, handle: slot.handle, address: null, since: Date.now(), awakeAt: null,
      };
      return (await tx.casInstance(current, waking)) ? waking : 'lost';
    });
    if (outcome === 'gone') throw new NotFound(`app ${app} is not registered`);
    if (outcome === 'stale') {
      await sleep(STALE_MS);
      return null;
    }
    if (outcome === 'lost') {
      await this.#instances.refresh(app);
      return null;
    }
    const claimed = outcome;
    this.#instances.putRow(claimed);
    this.#emit('waking', app);
    const started = performance.now();
    let address: string;
    try {
      address = await this.#driver.start(slot, spec);
    } catch (error) {
      const asleep: Instance = { ...claimed, state: 'asleep', actor: null, handle: slot.handle, release: slot.release, specHash: slot.specHash, since: Date.now() };
      const reason = error instanceof Unavailable ? null : String(error);
      const settled = await this.#store.transaction(async (tx) => {
        if (!(await tx.casInstance(claimed, asleep))) return null;
        return { quarantine: reason === null ? null : await this.#guard.fail(tx, spec, reason) };
      });
      if (settled) {
        this.#instances.putRow(asleep);
        if (reason !== null) await this.#instances.refresh(app);
        this.#emit('asleep', app, { ...cause(error), runtime: this.kind, tenant: spec.tenant });
        if (settled.quarantine) this.#guard.announce(app, settled.quarantine);
      }
      throw error;
    }
    const now = Date.now();
    const awake: Instance = { ...claimed, state: 'awake', actor: null, handle: slot.handle, release: slot.release, specHash: slot.specHash, address, since: now, awakeAt: now };
    const lease = this.#lease(local, awake, kind);
    const tally = this.#tally(app, awake.epoch, this.#counts(local), local);
    const ok = await this.#enqueue(local, awake.epoch, tally, () => this.#store.transaction(async (tx) => {
      if (!(await tx.casInstance(claimed, awake))) return false;
      await tx.putLeaseTally(tally);
      return true;
    })).catch((error: unknown) => {
      local.leases.delete(lease);
      throw error;
    });
    if (!ok) {
      // Taken over while starting: what this replica started belongs to no row.
      local.leases.delete(lease);
      if (slot.handle !== null) await this.#driver.remove(app, slot.handle).catch(() => {});
      await this.#instances.refresh(app);
      return null;
    }
    this.#instances.putTally(tally);
    this.#instances.putRow(awake);
    this.#emit('awake', app, { ms: Math.round(performance.now() - started), runtime: this.kind, tenant: spec.tenant });
    return lease;
  }

  /** Marks this replica's tally stale; written within FLUSH_MS, at once while the instance drains. */
  #dirty(app: AppId, local: Local): void {
    local.dirty = true;
    if (this.#mine(app)?.state === 'draining') {
      void this.#flush(app, local);
      return;
    }
    local.flush ??= setTimeout(() => void this.#flush(app, local), FLUSH_MS).unref();
  }

  #flush(app: AppId, local: Local): Promise<void> {
    if (local.flush) clearTimeout(local.flush);
    local.flush = null;
    const row = this.#instances.row(app);
    if (!local.dirty || !row) return local.queue.then(() => {});
    local.dirty = false;
    const tally = this.#tally(app, row.epoch, this.#counts(local), local);
    return this.#enqueue(local, row.epoch, tally, () => this.#store.putLeaseTally(tally)).then(
      () => this.#instances.putTally(tally),
      (error: Error) => {
        this.#emit('tally-failed', app, { error: error.message });
        this.#dirty(app, local);
      },
    );
  }

  #touched(local: Local): void {
    const { resolve } = local.changed;
    local.changed = Promise.withResolvers();
    resolve();
  }

  /** Reacts to a row change from any replica: a drain closes this replica's channels and writes its tally at once; an awake row arms the reaper. */
  #observe(app: AppId): void {
    const row = this.#mine(app);
    const local = this.#local.get(app);
    if (!this.#instances.row(app) && local && local.leases.size === 0) {
      if (local.flush) clearTimeout(local.flush);
      this.#local.delete(app);
      return;
    }
    if (!row) return;
    if (row.state === 'awake' && this.#instances.leading) this.#arm(Math.min(MAX_TICK_SECONDS, this.#policy(app).idle_seconds));
    if (row.state !== 'draining' || !local || local.retired === row.epoch) return;
    local.retired = row.epoch;
    for (const { onRetire } of local.leases.values()) {
      try {
        onRetire?.();
      } catch (error) {
        this.#emit('retire-error', app, { error: String(error) });
      }
    }
    local.dirty = true;
    void this.#flush(app, local);
  }

  /** Waits until no replica holds a lease or drain_timeout_seconds passes, then removes the instance. */
  async #drain(draining: Instance): Promise<void> {
    const { app } = draining;
    const local = this.#localOf(app);
    const deadline = Date.now() + this.#policy(app).drain_timeout_seconds * 1000;
    let held = await this.#held(draining, local);
    while (held > 0 && Date.now() < deadline) {
      const timer = new AbortController();
      // Other replicas' tallies announce nothing, so they are polled; this replica's own releases wake the wait at once.
      await Promise.race([local.changed.promise, sleep(Math.min(500, deadline - Date.now()), undefined, { signal: timer.signal }).catch(() => {})]);
      timer.abort();
      held = await this.#held(draining, local);
    }
    const stopping = await this.#cas(draining, { ...draining, state: 'stopping' }, { leases: held });
    if (stopping) await this.#remove(stopping);
  }

  async #held(row: Instance, local: Local): Promise<number> {
    const others = (await this.#store.leaseTallies(row.app)).filter((t) => t.replica !== this.#me && t.epoch === row.epoch);
    return local.leases.size + others.reduce((sum, t) => sum + total(t), 0);
  }

  async #remove(stopping: Instance): Promise<void> {
    const { app } = stopping;
    try {
      if (stopping.handle !== null) await this.#driver.remove(app, stopping.handle as H);
    } catch (error) {
      await this.#cas(stopping, { ...stopping, state: 'asleep', actor: null }, cause(error));
      throw error;
    }
    const asleep: Instance = { ...stopping, state: 'asleep', actor: null, handle: null, address: null, since: Date.now() };
    const ok = await this.#store.transaction(async (tx) => {
      if (!(await tx.casInstance(stopping, asleep))) return false;
      await this.#guard.clear(tx, app);
      return true;
    });
    if (!ok) return;
    this.#instances.putRow(asleep);
    await this.#instances.refresh(app);
    this.#emit('removed', app, { [this.#driver.handleKey]: stopping.handle });
  }

  /** The reaper's idle stop, confirmed under the row lock against every replica's tally (ADR 0020 item 4). */
  async #sleep(row: Instance): Promise<void> {
    const { app } = row;
    const local = this.#localOf(app);
    if (local.dirty) await this.#flush(app, local);
    const idleMs = this.#policy(app).idle_seconds * 1000;
    const stopping = await this.#store.transaction(async (tx) => {
      const current = await tx.instance(app, 'update');
      if (current?.runtime !== this.kind || current.state !== 'awake' || current.epoch !== row.epoch) return null;
      const tallies = (await tx.leaseTallies(app)).filter((t) => t.epoch === current.epoch);
      if (tallies.some((t) => total(t) > 0)) return null;
      if (Date.now() - Math.max(current.awakeAt ?? current.since, ...tallies.map((t) => t.releasedAt ?? 0)) < idleMs) return null;
      const next: Instance = { ...current, state: 'stopping', actor: this.#me, since: Date.now() };
      return (await tx.casInstance(current, next)) ? next : null;
    });
    if (!stopping || local.leases.size > 0) {
      if (stopping) await this.#cas(stopping, { ...stopping, state: 'awake', actor: null, awakeAt: Date.now() });
      return;
    }
    this.#instances.putRow(stopping);
    this.#emit('stopping', app);
    const slot: Slot<H> = { handle: stopping.handle as H | null, release: stopping.release, specHash: stopping.specHash };
    try {
      await this.#driver.sleep(app, slot);
      await this.#cas(stopping, { ...stopping, state: 'asleep', actor: null, handle: slot.handle, address: null });
    } catch (error) {
      if (error instanceof Unavailable) {
        await this.#cas(stopping, { ...stopping, state: 'asleep', actor: null, address: null }, cause(error));
        return;
      }
      await this.#cas(stopping, { ...stopping, state: 'awake', actor: null, awakeAt: Date.now() }, { error: String(error) });
    }
  }

  /** One CAS, then the mirror and the event; null when the row moved on. `since` is stamped here. */
  async #cas(expected: Instance, next: Instance, extra: Record<string, unknown> = {}): Promise<Instance | null> {
    const stamped: Instance = { ...next, since: Date.now() };
    if (!(await this.#store.casInstance(expected, stamped))) {
      await this.#instances.refresh(expected.app);
      return null;
    }
    this.#instances.putRow(stamped);
    this.#emit(stamped.state, stamped.app, extra);
    return stamped;
  }

  readonly #gone: Gone<H> = (app, handle, ending) => {
    const row = this.#mine(app);
    if (row?.state !== 'awake' || row.handle !== handle) return;
    this.#localOf(app).ended = row.epoch;
    void this.#ended(row, ending).catch((error: Error) => this.#emit('end-failed', app, { error: error.message }));
  };

  /** Every replica that sees the end races this CAS; only the winner records the failure and emits (ADR 0020 item 4). */
  async #ended(row: Instance, ending: Ending): Promise<void> {
    const { app } = row;
    const asleep: Instance = { ...row, state: 'asleep', actor: null, address: null, since: Date.now() };
    const spec = this.#anySpec(app);
    const failure = ending.ev === 'crashed' || ending.ev === 'hung' ? ending : null;
    const settled = await this.#store.transaction(async (tx) => {
      if (!(await tx.casInstance(row, asleep))) return null;
      return { quarantine: failure && spec ? await this.#guard.fail(tx, spec, failure.reason) : null };
    });
    if (!settled) return;
    this.#instances.putRow(asleep);
    if (failure) await this.#instances.refresh(app);
    if (failure) this.#emit(failure.ev, app, { reason: failure.reason });
    if (settled.quarantine) this.#guard.announce(app, settled.quarantine);
    this.#emit('asleep', app, ending.ev === 'unavailable' ? { unavailable: true } : { external: true });
  }

  /**
   * Leader at startup: an instance the driver reports without a matching row, or for another release or spec, is removed;
   * an awake row whose instance is gone goes asleep as crashed; transitions this replica left before it restarted are taken over.
   */
  async #adopt(): Promise<void> {
    const found = await this.#driver.adopt();
    const matched = new Set<AppId>();
    const discarded = new Set<string>();
    for (const instance of found ?? []) {
      const { app, handle } = instance;
      const row = this.#mine(app);
      const spec = this.#specFor(app);
      const fits = row !== null && row.handle === handle && spec !== null && !matched.has(app)
        && instance.release === String(spec.release) && instance.spec === specHash(spec) && row.release === spec.release && row.specHash === specHash(spec);
      if (!fits) {
        discarded.add(handle);
        if (await this.#driver.discard(app, handle)) this.#emit('removed', app, { [this.#driver.handleKey]: handle });
        continue;
      }
      matched.add(app);
      if (row.state === 'awake' && instance.address === null) await this.#ended(row, { ev: 'crashed', reason: 'the instance stopped while the gateway was down' });
      else if (row.state === 'awake' && row.address !== instance.address) await this.#cas(row, { ...row, address: instance.address }, { adopted: true });
    }
    for (const row of [...this.#instances.rows()]) {
      if (row.runtime !== this.kind || matched.has(row.app)) continue;
      if (row.state === 'awake') {
        if (found === null) await this.#ended(row, { ev: 'unavailable' });
        else if (row.handle !== null && discarded.has(row.handle)) await this.#ended(row, { ev: 'stopped' });
        else await this.#ended(row, { ev: 'crashed', reason: 'the instance was gone when the gateway started' });
      } else if (row.state === 'asleep' && row.handle !== null && found !== null) {
        await this.#cas(row, { ...row, handle: null }, { adopted: true });
      }
    }
    await this.#takeOver(true);
  }

  /**
   * Leader, every 5 s: a waking or stopping row whose actor is dead loses its handle and goes asleep; a draining one is drained here.
   * At startup this replica's own earlier transitions count as dead too.
   */
  async #takeOver(startup = false): Promise<void> {
    const stuck = [...this.#instances.rows()].filter((r) => r.runtime === this.kind && (r.state === 'waking' || r.state === 'stopping' || r.state === 'draining'));
    if (stuck.length === 0) return;
    const now = Date.now();
    const live = new Set((await this.#store.replicas()).filter((r) => r.seenAt >= now - DEAD_MS).map((r) => r.id));
    for (const row of stuck) {
      const mine = row.actor === this.#me;
      if (row.actor !== null && live.has(row.actor) && !(mine && startup)) continue;
      if (mine && !startup) continue;
      if (row.state === 'draining') {
        const taken = await this.#cas(row, { ...row, actor: this.#me }, { takeover: row.actor });
        if (taken) void this.#drain(taken).catch((error: Error) => this.#emit('drain-failed', row.app, { error: error.message }));
        continue;
      }
      try {
        if (row.handle !== null) await this.#driver.remove(row.app, row.handle as H);
      } catch (error) {
        this.#emit('takeover-failed', row.app, { error: String(error) });
        continue;
      }
      await this.#cas(row, { ...row, state: 'asleep', actor: null, handle: null, address: null }, { takeover: row.actor });
    }
  }

  #lead(leading: boolean): void {
    if (!leading || this.#events.signal.aborted) {
      if (this.#timer) clearTimeout(this.#timer);
      if (this.#takeover) clearInterval(this.#takeover);
      this.#timer = this.#takeover = null;
      return;
    }
    this.#takeover ??= setInterval(() => void this.#takeOver().catch(() => {}), TAKEOVER_MS).unref();
    if ([...this.#instances.rows()].some((r) => r.runtime === this.kind && r.state === 'awake')) this.#arm(1);
  }

  readonly #tick = (): void => {
    this.#timer = null;
    if (!this.#instances.leading) return;
    const now = Date.now();
    let next = MAX_TICK_SECONDS;
    let awake = false;
    for (const row of this.#instances.rows()) {
      if (row.runtime !== this.kind || row.state !== 'awake') continue;
      awake = true;
      next = Math.min(next, this.#policy(row.app).idle_seconds);
      const at = this.sleepsAt(row.app);
      if (at !== null && now >= at) void this.#sleep(row).catch((error: Error) => this.#emit('sleep-failed', row.app, { error: error.message }));
    }
    if (awake) this.#arm(next);
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

  #emit(ev: string, app: AppId, extra: Record<string, unknown> = {}): void {
    this.#log(ev, app, extra);
  }
}
