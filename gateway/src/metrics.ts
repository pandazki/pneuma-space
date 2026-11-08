import { statfs } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import type { EventLog, LifecycleEvent } from './events.ts';
import { resolvesOnNetwork } from './providers.ts';
import { canConnect } from './runtime.ts';
import {
  USAGE_COUNTERS,
  type AppId, type AppName, type AppStatus, type AppSummary, type Delivery, type DeliveryState, type InstanceState, type LeaseKind, type Policy,
  type ReplicaId, type Stats, type StoreOps, type TenantName, type UsageBucket, type UsageStep,
} from './model.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WINDOW_MINUTES = 24 * 60;
const WAKE_SAMPLES = 10_000;
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
  readonly events: Pick<EventLog, 'onEvent' | 'recent'>;
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
  readonly usage: Pick<StoreOps, 'putUsage' | 'usage' | 'sweepUsage'>;
  readonly policy: () => Pick<Policy, 'usage_retention_days'>;
  readonly view: (name: AppName) => { readonly app: AppId; readonly tenant: TenantName } | null;
  readonly replica: ReplicaId;
  /** Whether this replica leads now; only the leader accrues awake time and sweeps (ADR 0024 item 2). */
  readonly leader?: () => boolean;
  readonly now?: () => number;
};

type Counter = (typeof USAGE_COUNTERS)[number];
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
 * memory counted since, so it never waits on the store.
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
  #wakeSamples: { readonly t: number; readonly ms: number }[] = [];
  readonly #states = new Map<string, InstanceState>();
  readonly #reasons = new Map<string, { readonly reason: unknown; readonly t: number }>();
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
        reason: this.#reasons.get(d.id)?.reason ?? null, at: this.#reasons.get(d.id)?.t ?? d.nextAttemptAt,
      })),
    };
    this.#host = host;
    this.#rssBytes = process.memoryUsage.rss();
    if (this.#deps.leader?.() ?? true) this.#accrueAwake(apps, now);
    await this.#flush(now);
    if ((this.#deps.leader?.() ?? true) && now - this.#sweptAt >= HOUR) await this.#sweep(now);
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
    const wakes = (span: number) => {
      const recent = minutes.slice(-span);
      const ms = this.#wakeSamples.filter((w) => w.t >= now - span * MINUTE).map((w) => w.ms).sort((a, b) => a - b);
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
      wakes: { last1h: wakes(60), last24h: wakes(WINDOW_MINUTES) },
      deliveries: this.#deliveries,
      series: {
        start: first * MINUTE,
        stepMs: MINUTE,
        ...series,
        wakeMeanMs: minutes.map((m) => (m.wakes ? Math.round(m.wakeMs / m.wakes) : null)),
      },
      events: this.#deps.events.recent().map((e) => ({ ...e, app: (e.app && this.#deps.nameOf(e.app as AppId)) ?? e.app })),
    };
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
      await this.#deps.usage.putUsage(dirty.map(([o, counts]) => ({ app: o.app, tenant: o.tenant, step: o.step, start: o.start, replica: this.#writer, ...counts })));
    }
    const minute = bucketStart(now, 60);
    const hour = bucketStart(now, 3600);
    const [minutes, hours] = await Promise.all([
      this.#deps.usage.usage({ step: 60, app: '*', from: minute - (WINDOW_MINUTES - 1) * MINUTE, to: minute + MINUTE }),
      this.#deps.usage.usage({ step: 3600, from: hour - 23 * HOUR, to: hour + HOUR }),
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
    await this.#deps.usage.sweepUsage(3600, now - this.#deps.policy().usage_retention_days * DAY);
    await this.#deps.usage.sweepUsage(60, now - DAY);
    this.#sweptAt = now;
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
    const app = e.app as AppId | null;
    if (app !== null && isInstanceState(e.ev)) {
      const before = this.#states.get(app);
      this.#states.set(app, e.ev);
      if (e.ev === 'awake' && typeof e.ms === 'number') {
        this.#count(app, 'wakes');
        this.#count(app, 'wakeMs', e.ms);
        const t = this.#now();
        this.#wakeSamples.push({ t, ms: e.ms });
        const old = this.#wakeSamples.findIndex((w) => w.t >= t - DAY);
        this.#wakeSamples.splice(0, Math.max(old, this.#wakeSamples.length - WAKE_SAMPLES));
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
