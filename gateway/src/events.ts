import type { QuotaExceeded } from './model.ts';

export type LifecycleEvent = { readonly seq: number; readonly t: number; readonly ev: string; readonly app: string | null; readonly [field: string]: unknown };
export type Emit = (ev: string, app?: string | null, extra?: Record<string, unknown>) => void;

const RING = 100;

/** The gateway's lifecycle log: each event is one JSON line on stdout, kept in a ring and passed to subscribers. */
export class EventLog {
  readonly #ring: LifecycleEvent[] = [];
  readonly #subscribers = new Set<(event: LifecycleEvent) => void>();
  readonly #write: (line: string) => void;
  #seq = 0;

  constructor(write: (line: string) => void = console.log) {
    this.#write = write;
  }

  readonly emit: Emit = (ev, app = null, extra = {}) => {
    const event: LifecycleEvent = { seq: ++this.#seq, t: Date.now(), ev, app, ...extra };
    this.#write(JSON.stringify(event));
    this.#ring.push(event);
    if (this.#ring.length > RING) this.#ring.shift();
    for (const subscriber of this.#subscribers) subscriber(event);
  };

  onEvent(subscriber: (event: LifecycleEvent) => void): void {
    this.#subscribers.add(subscriber);
  }

  /** Oldest first. */
  recent(): readonly LifecycleEvent[] {
    return this.#ring;
  }
}

export const events = new EventLog();
export const emit = events.emit;

const QUOTA_EVENT_MS = 60_000;

export type QuotaRefused = (refused: QuotaExceeded, app: string, action: 'publish' | 'policy' | 'wake') => void;

/** `quota-refused` at most once a minute per (tenant, resource) on this replica (ADR 0023 item 5). */
export function quotaRefusals(log: Emit = emit, now: () => number = Date.now): QuotaRefused {
  const last = new Map<string, number>();
  return ({ tenant, refusal: { resource, used, limit } }, app, action) => {
    const key = `${tenant}/${resource}`;
    const at = now();
    if (at - (last.get(key) ?? -Infinity) < QUOTA_EVENT_MS) return;
    last.set(key, at);
    log('quota-refused', app, { tenant, resource, used, limit, action });
  };
}

/** Shared by every admission: publish, a switch to SQLite, and wake. */
export const quotaRefused = quotaRefusals();
