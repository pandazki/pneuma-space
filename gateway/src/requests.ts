import type { AppId } from './model.ts';

export type RequestKind = 'request' | 'static' | 'ws' | 'trigger';

/** One finished exchange (ADR 0016). `t` is when it ended; `ms` is its whole duration, for ws the time the tunnel stayed open. */
export type RequestRecord = {
  readonly seq: number;
  readonly t: number;
  readonly app: AppId;
  readonly kind: RequestKind;
  readonly method: string;
  readonly path: string;
  /** 0 when the app could not be reached. */
  readonly status: number;
  readonly ms: number;
  /** Until the upstream accepted the connection, wake included; null where nothing was acquired. */
  readonly waitMs: number | null;
  readonly cold: boolean;
  readonly subject: string | null;
  readonly error: string | null;
};

export const RING = 1000;
const PATH_MAX = 200;

/** The request ring: seqs are contiguous, so slot `seq % RING` holds the record with that seq while it is still kept. */
export class RequestLog {
  readonly #ring: RequestRecord[] = [];
  #seq = 0;

  record(entry: Omit<RequestRecord, 'seq' | 't'>): void {
    const seq = ++this.#seq;
    this.#ring[seq % RING] = { ...entry, seq, t: Date.now(), path: entry.path.slice(0, PATH_MAX), ms: Math.round(entry.ms), waitMs: entry.waitMs === null ? null : Math.round(entry.waitMs) };
  }

  /** Oldest first: the kept records with a seq greater than `seq`, at most `limit`. */
  after(seq: number, limit: number): RequestRecord[] {
    const out: RequestRecord[] = [];
    for (let s = Math.max(seq + 1, this.#seq - RING + 1, 1); s <= this.#seq && out.length < limit; s++) out.push(this.#ring[s % RING]);
    return out;
  }
}

export const requests = new RequestLog();
