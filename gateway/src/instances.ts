import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppId, AppName, GuardRecord, Instance, Leadership, LeaseTally, ReplicaId, Store } from './model.ts';

const HEARTBEAT_MS = 2000;
/** A replica not seen for this long is dead: the leader sweeps its rows and takes over its transitions. */
export const DEAD_MS = 10_000;
const RESYNC_MS = 30_000;
/** Lease tallies announce nothing (ADR 0020 item 2); other replicas' counts are re-read this often, for display only. */
const TALLY_MS = 5000;
const POLL_MS = 500;

export type InstancesOptions = {
  readonly replica?: ReplicaId;
  /** False keeps this replica from ever asking for the lead; tests run followers on one SQLite file this way. */
  readonly leader?: boolean;
};

/**
 * This replica's mirror of the instance, lease_tally and guard rows (ADR 0020 item 3): every read is zero IO, an `instance/<id>` notice
 * re-reads the app's instance and guard rows, a resync re-reads everything. Correctness never reads it: transactions read rows.
 * Also this replica's id, heartbeat and leadership, and the purge cleanup of these three tables and instance_log (ADR 0020 item 8).
 */
export class Instances {
  readonly replica: ReplicaId;
  readonly store: Store;
  readonly #rows = new Map<AppId, Instance>();
  readonly #tallies = new Map<AppId, readonly LeaseTally[]>();
  readonly #guards = new Map<AppId, GuardRecord>();
  /** Bumped by every local write-through; a re-read that overlapped one reads again. */
  readonly #versions = new Map<AppId, number>();
  /** The newest re-read per app; an older one that finishes later is dropped. */
  readonly #reads = new Map<AppId, number>();
  readonly #waiters = new Map<AppId, PromiseWithResolvers<void>>();
  readonly #listeners: ((app: AppId) => void)[] = [];
  readonly #leaderListeners: ((leading: boolean) => unknown)[] = [];
  readonly #mayLead: boolean;
  #tenure: Leadership | null = null;
  #term = { since: 0 };
  #ready: Promise<void> | null = null;
  #resync: NodeJS.Timeout | null = null;
  #tallyTimer: NodeJS.Timeout | null = null;
  #heartbeat: NodeJS.Timeout | null = null;

  constructor(store: Store, options: InstancesOptions = {}) {
    this.store = store;
    this.replica = options.replica ?? (hostname() as ReplicaId);
    this.#mayLead = options.leader ?? true;
    store.onChange((change) => {
      if (change.kind === 'instance') void this.refresh(change.app).catch(() => {});
      if (change.kind === 'app') void this.#purged(change.name).catch(() => {});
    });
    store.onResync(() => void this.#load().then(() => this.#converge()).catch(() => {}));
  }

  /** Resolves once the first full read and the purge cleanup are in and the lead was asked for once; the mirror is empty until then. */
  ready(): Promise<void> {
    this.#ready ??= this.#load().then(() => this.#converge()).then(() => this.#lead()).then(() => {
      this.#resync = setInterval(() => void this.#load().catch(() => {}), RESYNC_MS).unref();
      this.#tallyTimer = setInterval(() => void this.#readTallies().catch(() => {}), TALLY_MS).unref();
    });
    return this.#ready;
  }

  row(app: AppId): Instance | null {
    return this.#rows.get(app) ?? null;
  }

  rows(): IterableIterator<Instance> {
    return this.#rows.values();
  }

  tallies(app: AppId): readonly LeaseTally[] {
    return this.#tallies.get(app) ?? [];
  }

  guard(app: AppId): GuardRecord | null {
    return this.#guards.get(app) ?? null;
  }

  /** Called after every change to an app's mirrored rows, local or read. */
  onChange(listener: (app: AppId) => void): void {
    this.#listeners.push(listener);
  }

  /** Resolves on the app's next change, or after a 500 ms poll of its rows when a notice was lost. */
  changed(app: AppId): Promise<void> {
    let waiter = this.#waiters.get(app);
    if (!waiter) this.#waiters.set(app, (waiter = Promise.withResolvers()));
    const poll = new AbortController();
    const fallback = sleep(POLL_MS, undefined, { signal: poll.signal }).then(() => this.refresh(app), () => {});
    return Promise.race([waiter.promise, fallback]).finally(() => poll.abort());
  }

  /** What this replica just committed; applied at once so its own next step reads it. */
  putRow(row: Instance): void {
    this.#bump(row.app);
    this.#rows.set(row.app, row);
    this.#announce(row.app);
  }

  putTally(tally: LeaseTally): void {
    this.#bump(tally.app);
    this.#tallies.set(tally.app, [...this.tallies(tally.app).filter((t) => t.replica !== tally.replica), tally]);
    this.#announce(tally.app);
  }

  /** What this replica just deleted for every replica (ADR 0026 item 3). */
  dropTallies(app: AppId): void {
    this.#bump(app);
    this.#tallies.delete(app);
  }

  async refresh(app: AppId): Promise<void> {
    const read = (this.#reads.get(app) ?? 0) + 1;
    this.#reads.set(app, read);
    const version = this.#versions.get(app) ?? 0;
    const [row, guard] = await Promise.all([this.store.instance(app), this.store.guard(app)]);
    if (this.#reads.get(app) !== read) return;
    if ((this.#versions.get(app) ?? 0) !== version) return this.refresh(app);
    this.#set(app, row, this.tallies(app), guard);
    this.#announce(app);
  }

  async #purged(name: AppName): Promise<void> {
    if (!(await this.store.app(name))) await this.#converge();
  }

  /**
   * Deletes the instance, lease_tally, guard and instance_log rows of every app the library no longer has; idempotent, so every replica may run it.
   * Reads the apps last: a row read before it whose app is missing from it belongs to an app that is gone for good.
   */
  async #converge(): Promise<void> {
    const held = new Set([...this.#rows.keys(), ...this.#tallies.keys(), ...this.#guards.keys(), ...(await this.store.loggedApps())]);
    const live = new Set((await this.store.apps()).map((a) => a.id));
    for (const app of held) {
      if (live.has(app)) continue;
      await this.store.transaction(async (tx) => {
        await tx.deleteInstance(app);
        await tx.deleteGuard(app);
        await tx.deleteInstanceLog(app);
      });
      this.#bump(app);
      this.#set(app, null, [], null);
      this.#announce(app);
    }
  }

  get leading(): boolean {
    return this.#tenure?.held() ?? false;
  }

  /** The tenure this replica leads in, a new object each time it takes the lead; null while it follows. */
  get term(): { readonly since: number } | null {
    return this.leading ? this.#term : null;
  }

  /** Calls `listener` whenever leadership changes, and at once when this replica leads already; resolves with that first call. */
  async onLeader(listener: (leading: boolean) => unknown): Promise<void> {
    this.#leaderListeners.push(listener);
    if (this.leading) await listener(true);
  }

  /** Takes the lead if it is free; the leader loops stop as soon as the tenure is lost (ADR 0020 item 4). */
  async #lead(): Promise<void> {
    if (!this.#mayLead || this.#tenure) return;
    const tenure = await this.store.leader();
    if (!tenure || this.#tenure) return;
    this.#tenure = tenure;
    this.#term = { since: Date.now() };
    tenure.onLost(() => {
      if (this.#tenure !== tenure) return;
      this.#tenure = null;
      this.#tell(false);
    });
    this.#tell(true);
  }

  #tell(leading: boolean): void {
    for (const listener of this.#leaderListeners) {
      void Promise.resolve().then(() => listener(leading)).catch((error: Error) => {
        console.error(JSON.stringify({ ev: 'leader-listener-failed', leading, error: error.message }));
      });
    }
  }

  /**
   * Writes this replica's row now and every 2 s, asking for the lead each time; the leader also sweeps the rows of replicas not seen for 10 s.
   * First deletes what an earlier process under this id left: a fresh process holds no leases.
   */
  async start(): Promise<void> {
    await this.store.deleteReplica(this.replica);
    const startedAt = Date.now();
    const beat = async () => {
      const now = Date.now();
      await this.#lead();
      await this.store.putReplica({ id: this.replica, startedAt, seenAt: now, leading: this.leading });
      if (this.leading) await this.store.sweepReplicas(now - DEAD_MS);
    };
    await beat();
    this.#heartbeat = setInterval(() => void beat().catch(() => {}), HEARTBEAT_MS).unref();
  }

  /** Graceful exit: stops leading and deletes this replica's tally and replica rows (ADR 0020 item 6). */
  async close(): Promise<void> {
    if (this.#resync) clearInterval(this.#resync);
    if (this.#tallyTimer) clearInterval(this.#tallyTimer);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    const tenure = this.#tenure;
    this.#tenure = null;
    if (tenure) {
      for (const listener of this.#leaderListeners) await listener(false);
      await tenure.release();
    }
    await this.store.deleteReplica(this.replica);
  }

  async #load(): Promise<void> {
    const versions = new Map(this.#versions);
    const reads = new Map(this.#reads);
    const [rows, tallies, guards] = await Promise.all([this.store.instances(), this.store.leaseTallies(), this.store.guards()]);
    const apps = new Set([...this.#rows.keys(), ...this.#tallies.keys(), ...this.#guards.keys(), ...rows.map((r) => r.app), ...tallies.map((t) => t.app), ...guards.map((g) => g.app)]);
    for (const app of apps) {
      if (this.#versions.get(app) !== versions.get(app) || this.#reads.get(app) !== reads.get(app)) continue;
      this.#set(app, rows.find((r) => r.app === app) ?? null, tallies.filter((t) => t.app === app), guards.find((g) => g.app === app) ?? null);
      this.#announce(app);
    }
  }

  async #readTallies(): Promise<void> {
    const tallies = await this.store.leaseTallies();
    for (const app of [...this.#tallies.keys()]) if (!tallies.some((t) => t.app === app)) this.#tallies.delete(app);
    for (const app of new Set(tallies.map((t) => t.app))) this.#tallies.set(app, tallies.filter((t) => t.app === app));
  }

  #set(app: AppId, row: Instance | null, tallies: readonly LeaseTally[], guard: GuardRecord | null): void {
    if (row) this.#rows.set(app, row);
    else this.#rows.delete(app);
    if (tallies.length) this.#tallies.set(app, tallies);
    else this.#tallies.delete(app);
    if (guard) this.#guards.set(app, guard);
    else this.#guards.delete(app);
  }

  #bump(app: AppId): void {
    this.#versions.set(app, (this.#versions.get(app) ?? 0) + 1);
  }

  #announce(app: AppId): void {
    const waiter = this.#waiters.get(app);
    this.#waiters.delete(app);
    waiter?.resolve();
    for (const listener of this.#listeners) listener(app);
  }
}
