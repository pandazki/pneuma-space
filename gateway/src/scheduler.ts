import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { hostname } from 'node:os';
import { emit, type Emit } from './events.ts';
import { DEAD_MS } from './instances.ts';
import { requests } from './requests.ts';
import { QUOTA_RETRY_SECONDS } from './runtimes.ts';
import {
  HEADERS, MAX_ATTEMPTS, NotFound, QuotaExceeded, TRIGGER_PATH,
  type AppId, type CronExpr, type Delivery, type DeliveryId, type InvokeRequest, type Lease, type ReplicaId,
  type Runtime, type Scheduler, type SchedulerView, type Store, type TriggerName,
} from './model.ts';

export type SchedulerDeps = {
  readonly store: Pick<Store, 'apps' | 'insertDelivery' | 'updateDelivery' | 'claimDelivery' | 'deliveries' | 'lastScheduledFor' | 'deleteDeliveries' | 'replicas'>;
  readonly runtime: Pick<Runtime, 'acquire' | 'release' | 'state'>;
  readonly view: (app: AppId) => SchedulerView | null;
  readonly now?: () => number;
  readonly log?: Emit;
  /** This replica, named in the deliveries it claims. */
  readonly replica?: ReplicaId;
};

const TICK_MS = 1000;
const BACKOFF_MS = 10_000;

/** `refused`: the tenant's quota turned the wake away; the attempt does not count (ADR 0023 item 5). */
type Outcome = { readonly ok: boolean; readonly cancel: boolean; readonly refused?: boolean; readonly reason?: string };

export class DeliveryScheduler implements Scheduler {
  readonly #store: SchedulerDeps['store'];
  readonly #runtime: SchedulerDeps['runtime'];
  readonly #view: SchedulerDeps['view'];
  readonly #now: () => number;
  readonly #log: Emit;
  readonly #replica: ReplicaId;
  readonly #inFlight = new Set<AppId>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SchedulerDeps) {
    this.#store = deps.store;
    this.#runtime = deps.runtime;
    this.#view = deps.view;
    this.#now = deps.now ?? Date.now;
    this.#log = deps.log ?? emit;
    this.#replica = deps.replica ?? (hostname() as ReplicaId);
  }

  async invoke(req: InvokeRequest): Promise<DeliveryId> {
    if (!declares(this.#view(req.app), req.trigger)) {
      throw new NotFound(`trigger "${req.trigger}" is not declared by the app's current release`);
    }
    return (await this.#insert({
      app: req.app, trigger: req.trigger, scheduledFor: null, caller: req.caller,
      idempotencyKey: req.idempotencyKey, body: req.body,
    })).id;
  }

  async reload(app: AppId): Promise<void> {
    const view = this.#view(app);
    if (view === null) return this.#store.deleteDeliveries(app);
    for (const d of await this.#store.deliveries({ app, state: 'due' })) {
      if (!declares(view, d.trigger)) await this.#write({ ...d, state: 'cancelled' }, 'trigger not declared or app not registered');
    }
  }

  /** On taking leadership: deliveries claimed by a dead replica, or by this one before it restarted, go back to due (ADR 0020 item 4). */
  async resume(): Promise<void> {
    const seen = Date.now() - DEAD_MS;
    const live = new Set((await this.#store.replicas()).filter((r) => r.seenAt >= seen && r.id !== this.#replica).map((r) => r.id));
    for (const d of await this.#store.deliveries({ state: 'delivering' })) {
      if (d.replica && live.has(d.replica)) continue;
      await this.#write({ ...d, state: 'due', nextAttemptAt: this.#now() }, 'gateway restarted mid-delivery');
    }
    this.#timer ??= setInterval(() => void this.tick(), TICK_MS).unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Materializes due cron slots, then starts at most one delivery per app; resolves when the started ones settle. Never rejects. */
  async tick(): Promise<void> {
    try {
      const now = this.#now();
      await this.#materialize(now);
      const started: Promise<void>[] = [];
      const due = (await this.#store.deliveries({ state: 'due', dueBefore: now }))
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt);
      for (const d of due) {
        if (this.#inFlight.has(d.app)) continue;
        this.#inFlight.add(d.app);
        started.push(this.#deliver(d).finally(() => this.#inFlight.delete(d.app)));
      }
      await Promise.all(started);
    } catch (error) {
      this.#log('tick-failed', null, { error: String(error) });
    }
  }

  async #materialize(now: number): Promise<void> {
    for (const app of await this.#store.apps()) {
      const view = this.#view(app.id);
      if (view?.status !== 'registered') continue;
      for (const trigger of view.triggers) {
        if (trigger.schedule === null) continue;
        const after = Math.max((await this.#store.lastScheduledFor(app.id, trigger.name)) ?? view.publishedAt, view.publishedAt);
        const slot = latestSlot(trigger.schedule, after, now, view.policy.timezone);
        if (slot === null) continue;
        await this.#insert({
          app: app.id, trigger: trigger.name, scheduledFor: slot, caller: null, idempotencyKey: null, body: new Uint8Array(),
        });
      }
    }
  }

  async #insert(fields: Pick<Delivery, 'app' | 'trigger' | 'scheduledFor' | 'caller' | 'idempotencyKey' | 'body'>): Promise<Delivery> {
    const now = this.#now();
    const fresh: Delivery = {
      ...fields, id: randomUUID() as DeliveryId, state: 'due', attempts: 0, nextAttemptAt: now, createdAt: now,
    };
    const stored = await this.#store.insertDelivery(fresh);
    if (stored.id === fresh.id) this.#emit(stored);
    return stored;
  }

  async #deliver(due: Delivery): Promise<void> {
    const view = this.#view(due.app);
    if (!declares(view, due.trigger)) {
      return this.#write({ ...due, state: 'cancelled' }, 'trigger not declared or app not registered');
    }
    const d: Delivery = { ...due, state: 'delivering', attempts: due.attempts + 1, replica: this.#replica };
    if (!(await this.#store.claimDelivery(d.id, this.#replica, d.attempts))) return;
    this.#emit(d);
    const outcome = await this.#attempt(d, view.policy.trigger_timeout_seconds * 1000);
    if (outcome.ok) await this.#write({ ...d, state: 'done' });
    else if (outcome.refused) await this.#write({ ...d, state: 'due', attempts: due.attempts, nextAttemptAt: this.#now() + QUOTA_RETRY_SECONDS * 1000 }, 'refused');
    else if (outcome.cancel || !declares(this.#view(d.app), d.trigger)) await this.#write({ ...d, state: 'cancelled' }, outcome.reason);
    else if (d.attempts >= MAX_ATTEMPTS) await this.#write({ ...d, state: 'failed' }, outcome.reason);
    else await this.#write({ ...d, state: 'due', nextAttemptAt: this.#now() + BACKOFF_MS * 2 ** (d.attempts - 1) }, outcome.reason);
  }

  async #attempt(d: Delivery, timeoutMs: number): Promise<Outcome> {
    const started = performance.now();
    const cold = this.#runtime.state(d.app) !== 'awake';
    let waitMs = 0;
    const record = (status: number, error: string | null) => requests.record({
      app: d.app, kind: 'trigger', method: 'POST', path: `${TRIGGER_PATH}${d.trigger}`, status,
      ms: performance.now() - started, waitMs, cold, subject: d.caller, error,
    });
    let lease: Lease;
    try {
      lease = await this.#runtime.acquire(d.app, 'trigger');
    } catch (error) {
      const reason = `wake failed: ${(error as Error).message}`;
      waitMs = performance.now() - started;
      record(0, reason);
      return { ok: false, cancel: error instanceof NotFound, refused: error instanceof QuotaExceeded, reason };
    }
    waitMs = performance.now() - started;
    try {
      const status = await post(`http://${lease.address}${TRIGGER_PATH}${d.trigger}`, headersFor(d), d.body, timeoutMs);
      record(status, null);
      return status >= 200 && status < 300 ? { ok: true, cancel: false } : { ok: false, cancel: false, reason: `HTTP ${status}` };
    } catch (error) {
      record(0, (error as Error).message);
      return { ok: false, cancel: false, reason: (error as Error).message };
    } finally {
      this.#runtime.release(lease);
    }
  }

  async #write(d: Delivery, reason?: string): Promise<void> {
    await this.#store.updateDelivery(d);
    this.#emit(d, reason);
  }

  #emit(d: Delivery, reason?: string): void {
    this.#log(`delivery.${d.state}`, d.app, { trigger: d.trigger, delivery: d.id, attempt: d.attempts, reason });
  }
}

function declares(view: SchedulerView | null, trigger: TriggerName): view is SchedulerView {
  return view?.status === 'registered' && view.triggers.some((t) => t.name === trigger);
}

function headersFor(d: Delivery): Record<string, string> {
  const headers: Record<string, string> = {
    [HEADERS.delivery]: d.id,
    [HEADERS.attempt]: String(d.attempts),
    'content-length': String(d.body.byteLength),
  };
  if (d.scheduledFor !== null) headers[HEADERS.scheduledFor] = new Date(d.scheduledFor).toISOString();
  if (d.caller !== null) headers[HEADERS.subject] = d.caller;
  return headers;
}

/** Resolves with the status once the whole response is read; the timeout covers the exchange and closes the connection. */
function post(url: string, headers: Record<string, string>, body: Uint8Array, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers, agent: false });
    const timer = setTimeout(() => req.destroy(new Error(`no response within ${timeoutMs} ms`)), timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    req.on('error', fail);
    req.on('response', (res) => {
      res.on('error', fail);
      res.on('end', () => {
        clearTimeout(timer);
        resolve(res.statusCode ?? 0);
      });
      res.resume();
    });
    req.end(body);
  });
}

// Cron. A slot is an instant at which the wall clock in `tz` shows a matching minute, so a wall time skipped by a
// DST jump never fires and one repeated by a fall-back fires twice; every real minute is still covered exactly once.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SEARCH_DAYS = 8 * 366;

type Cron = {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  /** Vixie rule: when both day fields are restricted (neither starts with `*`) a day matches either; otherwise both. */
  readonly eitherDay: boolean;
};

const cronCache = new Map<CronExpr, Cron>();

function parseCron(expr: CronExpr): Cron {
  let cron = cronCache.get(expr);
  if (cron) return cron;
  const [minute, hour, day, month, weekday] = expr.split(' ');
  cron = {
    minutes: expand(minute, 0, 59),
    hours: expand(hour, 0, 23),
    days: new Set(expand(day, 1, 31)),
    months: new Set(expand(month, 1, 12)),
    weekdays: new Set(expand(weekday, 0, 7).map((d) => d % 7)),
    eitherDay: !day.startsWith('*') && !weekday.startsWith('*'),
  };
  cronCache.set(expr, cron);
  return cron;
}

function expand(field: string, low: number, high: number): number[] {
  const values = new Set<number>();
  for (const item of field.split(',')) {
    const [range, step] = item.split('/');
    const [from, to] = range === '*' ? [low, high] : range.split('-').map(Number);
    const end = to ?? (step === undefined ? from : high);
    for (let v = from; v <= end; v += Number(step ?? 1)) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Milliseconds to add to an instant to get its wall clock in `tz`, read as if UTC. */
function offset(tz: string, instant: number): number {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, format);
  }
  const part = Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, Number(p.value)]));
  const second = instant - (((instant % 1000) + 1000) % 1000);
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - second;
}

/** The first slot strictly after `after`, or null when the expression never matches (like `0 0 31 2 *`). */
export function nextSlot(expr: CronExpr, after: number, tz: string): number | null {
  const cron = parseCron(expr);
  const first = Math.floor((after + offset(tz, after)) / DAY) * DAY - DAY;
  for (let day = first; day < first + SEARCH_DAYS * DAY; day += DAY) {
    const found = earliestOnDay(cron, day, after, tz);
    if (found === null) continue;
    // A fall-back overlap can put the next day's first slot before this day's repeated hour.
    const next = earliestOnDay(cron, day + DAY, after, tz);
    return next === null ? found : Math.min(found, next);
  }
  return null;
}

function earliestOnDay(cron: Cron, day: number, after: number, tz: string): number | null {
  const date = new Date(day);
  const dayMatch = cron.days.has(date.getUTCDate());
  const weekdayMatch = cron.weekdays.has(date.getUTCDay());
  if (!cron.months.has(date.getUTCMonth() + 1) || !(cron.eitherDay ? dayMatch || weekdayMatch : dayMatch && weekdayMatch)) {
    return null;
  }
  const offsets = [...new Set([offset(tz, day - DAY), offset(tz, day + DAY / 2), offset(tz, day + 2 * DAY)])];
  let best: number | null = null;
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) {
      const wall = day + hour * HOUR + minute * MINUTE;
      for (const o of offsets) {
        const instant = wall - o;
        if (instant <= after || (best !== null && instant >= best)) continue;
        if (offsets.length === 1) return instant;
        if (offset(tz, instant) === o) best = instant;
      }
    }
  }
  return best;
}

/** The latest slot in (after, until]: at most one slot is caught up however many were missed (INV-4). */
export function latestSlot(expr: CronExpr, after: number, until: number, tz: string): number | null {
  const first = nextSlot(expr, after, tz);
  if (first === null || first > until) return null;
  const second = nextSlot(expr, first, tz);
  if (second === null || second > until) return first;
  // Scanning only the last two periods keeps a long outage cheap; an irregular schedule may need the full scan.
  return lastIn(expr, Math.max(after, until - 2 * (second - first)), until, tz) ?? lastIn(expr, after, until, tz);
}

function lastIn(expr: CronExpr, after: number, until: number, tz: string): number | null {
  let latest: number | null = null;
  for (let t = nextSlot(expr, after, tz); t !== null && t <= until; t = nextSlot(expr, t, tz)) latest = t;
  return latest;
}
