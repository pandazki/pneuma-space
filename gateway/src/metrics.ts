import { statfs } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import type { EventLog, LifecycleEvent } from './events.ts';
import { resolvesOnNetwork } from './providers.ts';
import { canConnect } from './runtime.ts';
import {
  EVENT_SETTLE_MS, USAGE_COUNTERS,
  type AppId, type AppName, type AppStatus, type AppSummary, type Delivery, type DeliveryState, type EventRecord, type InstanceState, type LeaseKind,
  type Policy, type ReplicaId, type Stats, type StoreOps, type TenantName, type UsageBucket, type UsageStep,
} from './model.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WINDOW_MINUTES = 24 * 60;
const EVENT_BATCH = 100;
const EVENT_FLUSH_MS = 1000;
/** Events kept for a store that does not answer; they are on stdout either way. */
const EVENT_BACKLOG = 10_000;
const EVENT_TAIL = 100;
const EVENT_TAIL_MS = 1000;
/** A tail nobody asked for in this long is read afresh instead of by cursor, so the read stays one tail long. */
const EVENT_TAIL_STALE_MS = MINUTE;
const PROBE_TIMEOUT_MS = 1000;
const RECENT_FAILURES = 20;

export type ServiceName = 'redis' | 'object' | 'postgres' | 'coturn' | 'runner';
export type ServiceStatus = 'up' | 'down' | 'off';
export type Probe = () => Promise<ServiceStatus>;
type ServiceSample = { readonly status: ServiceStatus; readonly latencyMs: number | null };
export type HostSample = {
  readonly cpus: number;
  readonly load: readonly number[];
  readonly memory: { readonly totalBytes: number; readonly freeBytes: number };
  /** The filesystem holding the platform data directory. */
  readonly data: { readonly totalBytes: number; readonly freeBytes: number } | null;
};

export type MetricsDeps = {
  readonly events: Pick<EventLog, 'onEvent'>;
  /** Ingress counters, read from memory. */
  readonly stats: () => readonly Stats[];
  readonly apps: () => Promise<readonly AppSummary[]>;
  readonly deliveries: {
    counts(): Promise<Readonly<Record<DeliveryState, number>>>;
    failed(limit: number): Promise<readonly Delivery[]>;
  };
  readonly nameOf: (app: AppId) => AppName | null;
  readonly probes: Readonly<Record<ServiceName, Probe>>;
  readonly host: () => Promise<HostSample>;
  readonly store: Pick<StoreOps, 'putUsage' | 'usage' | 'sweepUsage' | 'insertEvents' | 'events' | 'sweepEvents'>;
  readonly policy: () => Pick<Policy, 'usage_retention_days' | 'events_retention_days' | 'events_max_rows'>;
  readonly view: (name: AppName) => { readonly app: AppId; readonly tenant: TenantName } | null;
  readonly replica: ReplicaId;
  /** Only the leader accrues awake time and sweeps (ADR 0024 items 2 and 4). */
  readonly leader?: boolean;
  readonly now?: () => number;
};

type Counter = (typeof USAGE_COUNTERS)[number];
type NewEvent = Omit<EventRecord, 'id' | 'at'>;
/** An event as `/api/metrics` answers it: the stdout line's fields with the store's id, and the app's name where it still has one. */
export type EventView = { readonly id: number; readonly t: number; readonly ev: string; readonly app: string | null; readonly replica: ReplicaId; readonly [field: string]: unknown };
type Counts = Record<Counter, number>;
/** One of this process's buckets: `live` counts in memory, `written` is what the store holds for it. */
type Own = { readonly app: AppId | '*'; readonly tenant: TenantName | null; readonly step: UsageStep; readonly start: number; readonly live: Counts; written: Counts };
const SERIES = ['requests', 'errors', 'wakes', 'wakeFailures', 'sleeps', 'deliveriesDone', 'deliveriesFailed', 'deliveriesRetried'] as const;

const INSTANCE_STATES: readonly InstanceState[] = ['asleep', 'waking', 'awake', 'draining', 'stopping'];
const RUNNING: readonly (InstanceState | 'none')[] = ['waking', 'awake', 'draining', 'stopping'];
const isInstanceState = (ev: string): ev is InstanceState => (INSTANCE_STATES as readonly string[]).includes(ev);

const count = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const bucketStart = (t: number, step: UsageStep) => t - (t % (step * 1000));
const ownKey = (app: AppId | '*', step: UsageStep, start: number) => `${app} ${step} ${start}`;

const emptyFleet = () => ({
  apps: count<AppStatus>(['registered', 'removed', 'purging']),
  instances: count(INSTANCE_STATES),
  leases: count<LeaseKind>(['request', 'channel', 'trigger']),
  activeLast24h: 0,
});

function percentile(sorted: readonly number[], p: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null;
}

/**
 * Observation (ADR 0014, 0024): lifecycle events and the ingress counters land in this process's usage buckets, which the
 * 10 s sampler writes as absolute values and reads back summed over replicas. `snapshot()` merges that read with what
 * memory counted since, so it never waits on the store. Every lifecycle event is also batched into the `events` table,
 * which `events()` reads back by cursor for every replica's console.
 */
export class Metrics {
  readonly #deps: MetricsDeps;
  readonly #now: () => number;
  readonly #startedAt: number;
  /** A restarted replica keeps its name but not its memory; its own rows must not overwrite the ones it wrote before. */
  readonly #writer: ReplicaId;
  readonly #own = new Map<string, Own>();
  #stored = new Map<number, UsageBucket>();
  #last24h = new Map<AppId, { readonly requests: number; readonly errors: number }>();
  #wakeMsDay: number[] = [];
  #wakeMsHour: number[] = [];
  #eventsReadAt = -Infinity;
  readonly #states = new Map<string, InstanceState>();
  readonly #reasons = new Map<string, { readonly reason: unknown; readonly t: number }>();
  #storedReasons = new Map<string, { readonly reason: unknown; readonly t: number }>();
  #batch: NewEvent[] = [];
  #flushedAt = -Infinity;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #inserting: Promise<void> = Promise.resolve();
  #tail: EventRecord[] = [];
  #tailAt = -Infinity;
  #tailing: Promise<void> | null = null;
  #counters = new Map<AppId, { readonly requests: number; readonly errors: number }>();
  #awakeSampledAt: number | null = null;
  #sweptAt = -Infinity;
  #lastFlushAt: number | null = null;
  #rssBytes = process.memoryUsage.rss();
  #host: HostSample | null = null;
  #services: Readonly<Record<string, ServiceSample>> = {};
  #fleet = emptyFleet();
  #deliveries = { due: 0, delivering: 0, failed: 0, recentFailures: [] as unknown[] };

  constructor(deps: MetricsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#startedAt = this.#now();
    this.#writer = `${deps.replica}@${this.#startedAt}` as ReplicaId;
    deps.events.onEvent((event) => this.#record(event));
  }

  /** The 10 s sampler; probes and store reads and writes happen only here. Each probe bounds its own wait. */
  async sample(): Promise<void> {
    const now = this.#now();
    this.#absorbStats();
    const probe = async ([name, run]: [string, Probe]) => {
      const started = performance.now();
      const status = await run().catch((): ServiceStatus => 'down');
      const sample: ServiceSample = { status, latencyMs: status === 'up' ? Math.round(performance.now() - started) : null };
      return [name, sample] as const;
    };
    const [services, apps, counts, failed, host] = await Promise.all([
      Promise.all(Object.entries(this.#deps.probes).map(probe)),
      this.#deps.apps(),
      this.#deps.deliveries.counts(),
      this.#deps.deliveries.failed(RECENT_FAILURES),
      this.#deps.host(),
    ]);
    this.#services = Object.fromEntries(services);
    const fleet = emptyFleet();
    for (const app of apps) {
      fleet.apps[app.status]++;
      if (app.instance !== 'none') fleet.instances[app.instance]++;
      for (const kind of Object.keys(fleet.leases) as LeaseKind[]) fleet.leases[kind] += app.leases[kind];
      if (app.lastAccessAt !== null && now - app.lastAccessAt < DAY) fleet.activeLast24h++;
    }
    this.#fleet = fleet;
    this.#deliveries = {
      due: counts.due, delivering: counts.delivering, failed: counts.failed,
      recentFailures: failed.map((d) => ({
        app: this.#deps.nameOf(d.app) ?? d.app, trigger: d.trigger, attempts: d.attempts,
        reason: this.#reasonOf(d.id)?.reason ?? null, at: this.#reasonOf(d.id)?.t ?? d.nextAttemptAt,
      })),
    };
    this.#host = host;
    this.#rssBytes = process.memoryUsage.rss();
    if (this.#deps.leader ?? true) this.#accrueAwake(apps, now);
    if (now - this.#eventsReadAt >= MINUTE) await this.#readEvents(now);
    await this.#flush(now);
    if ((this.#deps.leader ?? true) && now - this.#sweptAt >= HOUR) await this.#sweep(now);
    this.#lastFlushAt = now;
  }

  /** Memory only: safe on the request path. */
  snapshot() {
    this.#absorbStats();
    const now = this.#now();
    const current = Math.floor(now / MINUTE);
    const first = current - WINDOW_MINUTES + 1;
    const minutes = Array.from({ length: WINDOW_MINUTES }, (_, i) => this.#merged((first + i) * MINUTE));
    const series = Object.fromEntries(SERIES.map((c) => [c, minutes.map((m) => m[c])])) as Record<(typeof SERIES)[number], number[]>;
    const wakes = (span: number, ms: readonly number[]) => {
      const recent = minutes.slice(-span);
      return {
        count: recent.reduce((sum, m) => sum + m.wakes, 0),
        failures: recent.reduce((sum, m) => sum + m.wakeFailures, 0),
        p50Ms: percentile(ms, 50),
        p95Ms: percentile(ms, 95),
      };
    };
    return {
      gateway: { startedAt: this.#startedAt, rssBytes: this.#rssBytes, lastFlushAt: this.#lastFlushAt },
      host: this.#host,
      services: this.#services,
      fleet: this.#fleet,
      wakes: { last1h: wakes(60, this.#wakeMsHour), last24h: wakes(WINDOW_MINUTES, this.#wakeMsDay) },
      deliveries: this.#deliveries,
      series: {
        start: first * MINUTE,
        stepMs: MINUTE,
        ...series,
        wakeMeanMs: minutes.map((m) => (m.wakes ? Math.round(m.wakeMs / m.wakes) : null)),
      },
    };
  }

  /** The newest settled events, oldest first, read from the store at most once a second (ADR 0024 item 4). */
  async events(): Promise<EventView[]> {
    if (this.#now() - this.#tailAt >= EVENT_TAIL_MS) await (this.#tailing ??= this.#readTail().finally(() => (this.#tailing = null)));
    return this.#tail.map((e) => ({ ...e.body, id: e.id, t: typeof e.body.t === 'number' ? e.body.t : e.at, ev: e.ev, app: (e.app && this.#deps.nameOf(e.app as AppId)) ?? e.app, replica: e.replica }));
  }

  /** Inserts the waiting events now; resolves once every event recorded before the call is in the store or back in the batch. */
  flushEvents(): Promise<void> {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    // One insert at a time keeps this replica's ids in the order its events happened.
    this.#inserting = this.#inserting.then(async () => {
      const batch = this.#batch.splice(0);
      if (!batch.length) return;
      this.#flushedAt = this.#now();
      try {
        await this.#deps.store.insertEvents(batch);
      } catch {
        this.#batch.unshift(...batch);
        this.#batch.splice(0, Math.max(0, this.#batch.length - EVENT_BACKLOG));
        this.#scheduleEvents();
      }
    });
    return this.#inserting;
  }

  /** Memory only. Per app: requests and errors over the last 24 hourly buckets, and this replica's last access. */
  stats(): Stats[] {
    this.#absorbStats();
    const from = bucketStart(this.#now(), 3600) - 23 * HOUR;
    const out = new Map<AppId, { requests: number; errors: number; lastAccessAt: number | null }>();
    const at = (app: AppId) => out.get(app) ?? out.set(app, { requests: 0, errors: 0, lastAccessAt: null }).get(app)!;
    for (const [app, c] of this.#last24h) Object.assign(at(app), c);
    for (const own of this.#own.values()) {
      if (own.app === '*' || own.start < from) continue;
      at(own.app).requests += own.live.requests - own.written.requests;
      at(own.app).errors += own.live.errors - own.written.errors;
    }
    for (const s of this.#deps.stats()) at(s.app).lastAccessAt = s.lastAccessAt;
    return [...out].map(([app, s]) => ({ app, ...s }));
  }

  /** The platform minute at `start`: every replica's stored counts plus what this process counted since its last read. */
  #merged(start: number): Counts {
    const stored = this.#stored.get(start);
    const own = this.#own.get(ownKey('*', 60, start));
    const out = count(USAGE_COUNTERS);
    for (const c of USAGE_COUNTERS) out[c] = (stored?.[c] ?? 0) + (own ? own.live[c] - own.written[c] : 0);
    return out;
  }

  /** `written` moves only after the read that includes the write, so a snapshot between the two neither drops nor doubles a count. */
  async #flush(now: number): Promise<void> {
    const dirty = [...this.#own.values()].filter((o) => USAGE_COUNTERS.some((c) => o.live[c] !== o.written[c])).map((o) => [o, { ...o.live }] as const);
    if (dirty.length) {
      await this.#deps.store.putUsage(dirty.map(([o, counts]) => ({ app: o.app, tenant: o.tenant, step: o.step, start: o.start, replica: this.#writer, ...counts })));
    }
    const minute = bucketStart(now, 60);
    const hour = bucketStart(now, 3600);
    const [minutes, hours] = await Promise.all([
      this.#deps.store.usage({ step: 60, app: '*', from: minute - (WINDOW_MINUTES - 1) * MINUTE, to: minute + MINUTE }),
      this.#deps.store.usage({ step: 3600, from: hour - 23 * HOUR, to: hour + HOUR }),
    ]);
    this.#stored = new Map(minutes.map((b) => [b.start, b]));
    const last24h = new Map<AppId, { requests: number; errors: number }>();
    for (const b of hours) {
      if (b.app === '*') continue;
      const sum = last24h.get(b.app) ?? { requests: 0, errors: 0 };
      last24h.set(b.app, { requests: sum.requests + b.requests, errors: sum.errors + b.errors });
    }
    this.#last24h = last24h;
    for (const [o, counts] of dirty) o.written = counts;
    for (const [key, o] of this.#own) {
      if (o.start + o.step * 1000 <= now && USAGE_COUNTERS.every((c) => o.live[c] === o.written[c])) this.#own.delete(key);
    }
  }

  async #sweep(now: number): Promise<void> {
    const policy = this.#deps.policy();
    await this.#deps.store.sweepUsage(3600, now - policy.usage_retention_days * DAY);
    await this.#deps.store.sweepUsage(60, now - DAY);
    await this.#deps.store.sweepEvents(now - policy.events_retention_days * DAY, policy.events_max_rows);
    this.#sweptAt = now;
  }

  /** Wake latencies over every replica's `awake` events, and the reasons of failed deliveries (ADR 0024 item 3). */
  async #readEvents(now: number): Promise<void> {
    const [awake, failed] = await Promise.all([
      this.#deps.store.events({ ev: 'awake', since: now - DAY }),
      this.#deps.store.events({ ev: 'delivery.failed', since: now - DAY }),
    ]);
    const timed = awake.filter((e) => typeof e.body.ms === 'number');
    const sorted = (rows: readonly EventRecord[]) => rows.map((e) => e.body.ms as number).sort((a, b) => a - b);
    this.#wakeMsDay = sorted(timed);
    this.#wakeMsHour = sorted(timed.filter((e) => e.at >= now - HOUR));
    this.#storedReasons = new Map(failed.map((e) => [String(e.body.delivery), { reason: e.body.reason ?? null, t: typeof e.body.t === 'number' ? e.body.t : e.at }]));
    this.#eventsReadAt = now;
  }

  #reasonOf(delivery: string) {
    return this.#reasons.get(delivery) ?? this.#storedReasons.get(delivery);
  }

  async #readTail(): Promise<void> {
    const now = this.#now();
    const fresh = now - this.#tailAt >= EVENT_TAIL_STALE_MS || this.#tail.length === 0;
    const after = fresh ? Math.max(0, (await newestEventId(this.#deps.store)) - EVENT_TAIL) : this.#tail.at(-1)!.id;
    const rows = await this.#deps.store.events({ after, settleMs: EVENT_SETTLE_MS });
    this.#tail = (fresh ? rows : [...this.#tail, ...rows]).slice(-EVENT_TAIL);
    this.#tailAt = now;
  }

  /** At most one insert a second, at once when the last was longer ago, and at once when 100 are waiting. */
  #queueEvent(e: LifecycleEvent): void {
    const { seq: _, ev, app, ...body } = e;
    this.#batch.push({ replica: this.#deps.replica, ev, app, tenant: app === null ? null : this.#tenantOf(app as AppId), body });
    this.#scheduleEvents(this.#batch.length >= EVENT_BATCH);
  }

  #scheduleEvents(now = false): void {
    const wait = this.#flushedAt + EVENT_FLUSH_MS - this.#now();
    if (now || wait <= 0) void this.flushEvents();
    else this.#flushTimer ??= setTimeout(() => void this.flushEvents(), wait);
    this.#flushTimer?.unref?.();
  }

  /** Every running instance adds the time since the previous sample, so the precision is one sampling interval. */
  #accrueAwake(apps: readonly AppSummary[], now: number): void {
    const since = this.#awakeSampledAt;
    this.#awakeSampledAt = now;
    if (since === null) return;
    for (const a of apps) {
      const app = RUNNING.includes(a.instance) ? this.#deps.view(a.name)?.app : undefined;
      if (app) this.#count(app, 'awakeMs', now - since);
    }
  }

  /** Into the platform's minute and hour and, for an app, its hour. */
  #count(app: AppId | null, counter: Counter, n = 1): void {
    const now = this.#now();
    const targets: [AppId | '*', UsageStep][] = [['*', 60], ['*', 3600]];
    if (app !== null) targets.push([app, 3600]);
    for (const [target, step] of targets) {
      const start = bucketStart(now, step);
      const key = ownKey(target, step, start);
      let own = this.#own.get(key);
      if (!own) {
        const tenant = target === '*' ? null : this.#tenantOf(target);
        own = { app: target, tenant, step, start, live: count(USAGE_COUNTERS), written: count(USAGE_COUNTERS) };
        this.#own.set(key, own);
      }
      own.live[counter] += n;
    }
  }

  #tenantOf(app: AppId): TenantName | null {
    const name = this.#deps.nameOf(app);
    return (name && this.#deps.view(name)?.tenant) ?? null;
  }

  /** Ingress counters only grow from zero at boot, so the growth since the last read is new traffic. */
  #absorbStats(): void {
    const next = new Map(this.#deps.stats().map(({ app, requests, errors }) => [app, { requests, errors }]));
    for (const [app, s] of next) {
      const before = this.#counters.get(app);
      const requests = Math.max(0, s.requests - (before?.requests ?? 0));
      const errors = Math.max(0, s.errors - (before?.errors ?? 0));
      if (requests) this.#count(app, 'requests', requests);
      if (errors) this.#count(app, 'errors', errors);
    }
    this.#counters = next;
  }

  #record(e: LifecycleEvent): void {
    this.#queueEvent(e);
    const app = e.app as AppId | null;
    if (app !== null && isInstanceState(e.ev)) {
      const before = this.#states.get(app);
      this.#states.set(app, e.ev);
      if (e.ev === 'awake' && typeof e.ms === 'number') {
        this.#count(app, 'wakes');
        this.#count(app, 'wakeMs', e.ms);
      } else if (e.ev === 'asleep' && before === 'waking' && e.error !== undefined) this.#count(app, 'wakeFailures');
      else if (e.ev === 'asleep' && before === 'stopping' && e.error === undefined) this.#count(app, 'sleeps');
    } else if (e.ev === 'removed' && app !== null) this.#states.delete(app);
    else if (e.ev === 'delivery.done') this.#count(app, 'deliveriesDone');
    else if (e.ev === 'delivery.failed') {
      this.#count(app, 'deliveriesFailed');
      this.#reasons.set(String(e.delivery), { reason: e.reason ?? null, t: e.t });
      if (this.#reasons.size > RECENT_FAILURES) this.#reasons.delete(this.#reasons.keys().next().value!);
    } else if (e.ev === 'delivery.due' && Number(e.attempt) > 0) this.#count(app, 'deliveriesRetried');
  }
}

/**
 * The frozen EventFilter reads oldest first only, so the newest id is found by doubling then halving `after` with limit 1:
 * about 2 log2(id) reads on the primary key, however many rows the table holds.
 */
async function newestEventId(store: Pick<StoreOps, 'events'>): Promise<number> {
  const beyond = async (id: number) => (await store.events({ after: id, limit: 1 })).length > 0;
  if (!(await beyond(0))) return 0;
  let low = 0;
  let high = 1;
  while (await beyond(high)) [low, high] = [high, high * 2];
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await beyond(mid)) low = mid;
    else high = mid;
  }
  return high;
}

export const tcpProbe = (host: string, port: number): Probe => async () => ((await canConnect(host, port)) ? 'up' : 'down');

export const httpProbe = (url: string): Probe => async () =>
  ((await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).ok ? 'up' : 'down');

/** A profile service that is not running has no DNS name on the platform network: off, not down. */
export const profileProbe = (service: 'postgres' | 'coturn' | 'runner', port: number): Probe => async () =>
  ((await resolvesOnNetwork(service)) ? tcpProbe(service, port)() : 'off');

export async function hostSample(dataDir: string): Promise<HostSample> {
  const fs = await statfs(dataDir).catch(() => null);
  return {
    cpus: availableParallelism(),
    load: loadavg(),
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    data: fs && { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize },
  };
}
