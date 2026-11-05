import { statfs } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import type { EventLog, LifecycleEvent } from './events.ts';
import { resolvesOnNetwork } from './providers.ts';
import { canConnect } from './runtime.ts';
import type { AppId, AppName, AppStatus, AppSummary, Delivery, DeliveryState, InstanceState, LeaseKind, Stats } from './model.ts';

const MINUTE = 60_000;
const WINDOW_MINUTES = 24 * 60;
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
  readonly now?: () => number;
};

const COUNTERS = ['requests', 'errors', 'wakes', 'wakeFailures', 'sleeps', 'deliveriesDone', 'deliveriesFailed', 'deliveriesRetried'] as const;
type Counter = (typeof COUNTERS)[number];
type Bucket = Record<Counter, number> & { readonly wakeMs: number[] };

const INSTANCE_STATES: readonly InstanceState[] = ['asleep', 'waking', 'awake', 'draining', 'stopping'];
const isInstanceState = (ev: string): ev is InstanceState => (INSTANCE_STATES as readonly string[]).includes(ev);

const count = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const emptyFleet = () => ({
  apps: count<AppStatus>(['registered', 'removed', 'purging']),
  instances: count(INSTANCE_STATES),
  leases: count<LeaseKind>(['request', 'channel', 'trigger']),
  activeLast24h: 0,
});

function percentile(sorted: readonly number[], p: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null;
}

/** Gateway-memory observation (ADR 0014): minute buckets for 24 h, fed by lifecycle events and a 10 s sampler. */
export class Metrics {
  readonly #deps: MetricsDeps;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #buckets = new Map<number, Bucket>();
  readonly #states = new Map<string, InstanceState>();
  readonly #reasons = new Map<string, { readonly reason: unknown; readonly t: number }>();
  #counters: Map<AppId, { readonly requests: number; readonly errors: number }> | null = null;
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
    deps.events.onEvent((event) => this.#record(event));
  }

  /** The 10 s sampler; probes and Docker-free store reads happen only here. Each probe bounds its own wait. */
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
      if (app.lastAccessAt !== null && now - app.lastAccessAt < WINDOW_MINUTES * MINUTE) fleet.activeLast24h++;
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
    this.#lastFlushAt = now;
  }

  /** Memory only: safe on the request path. */
  snapshot() {
    this.#absorbStats();
    const current = Math.floor(this.#now() / MINUTE);
    const first = current - WINDOW_MINUTES + 1;
    const minutes = Array.from({ length: WINDOW_MINUTES }, (_, i) => this.#buckets.get(first + i));
    const series = Object.fromEntries(COUNTERS.map((c) => [c, minutes.map((b) => b?.[c] ?? 0)]));
    const wakes = (span: number) => {
      const recent = minutes.slice(-span);
      const ms = recent.flatMap((b) => b?.wakeMs ?? []).sort((a, b) => a - b);
      return {
        count: ms.length,
        failures: recent.reduce((sum, b) => sum + (b?.wakeFailures ?? 0), 0),
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
        wakeP50Ms: minutes.map((b) => percentile([...(b?.wakeMs ?? [])].sort((x, y) => x - y), 50)),
      },
      events: this.#deps.events.recent().map((e) => ({ ...e, app: (e.app && this.#deps.nameOf(e.app as AppId)) ?? e.app })),
    };
  }

  #bucket(): Bucket {
    const minute = Math.floor(this.#now() / MINUTE);
    let bucket = this.#buckets.get(minute);
    if (!bucket) {
      bucket = { ...count(COUNTERS), wakeMs: [] };
      this.#buckets.set(minute, bucket);
      for (const old of this.#buckets.keys()) if (old <= minute - WINDOW_MINUTES) this.#buckets.delete(old);
    }
    return bucket;
  }

  /** Ingress counters only grow, so the difference since the last read is this minute's traffic; the first read is the baseline. */
  #absorbStats(): void {
    const next = new Map(this.#deps.stats().map(({ app, requests, errors }) => [app, { requests, errors }]));
    if (this.#counters) {
      const bucket = this.#bucket();
      for (const [app, s] of next) {
        const before = this.#counters.get(app);
        bucket.requests += Math.max(0, s.requests - (before?.requests ?? 0));
        bucket.errors += Math.max(0, s.errors - (before?.errors ?? 0));
      }
    }
    this.#counters = next;
  }

  #record(e: LifecycleEvent): void {
    if (e.app !== null && isInstanceState(e.ev)) {
      const before = this.#states.get(e.app);
      this.#states.set(e.app, e.ev);
      if (e.ev === 'awake' && typeof e.ms === 'number') {
        const bucket = this.#bucket();
        bucket.wakes++;
        bucket.wakeMs.push(e.ms);
      } else if (e.ev === 'asleep' && before === 'waking' && e.error !== undefined) this.#bucket().wakeFailures++;
      else if (e.ev === 'asleep' && before === 'stopping' && e.error === undefined) this.#bucket().sleeps++;
    } else if (e.ev === 'removed' && e.app !== null) this.#states.delete(e.app);
    else if (e.ev === 'delivery.done') this.#bucket().deliveriesDone++;
    else if (e.ev === 'delivery.failed') {
      this.#bucket().deliveriesFailed++;
      this.#reasons.set(String(e.delivery), { reason: e.reason ?? null, t: e.t });
      if (this.#reasons.size > RECENT_FAILURES) this.#reasons.delete(this.#reasons.keys().next().value!);
    } else if (e.ev === 'delivery.due' && Number(e.attempt) > 0) this.#bucket().deliveriesRetried++;
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
