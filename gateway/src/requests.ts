import { resolve4 } from 'node:dns/promises';
import type { AppId, ReplicaId } from './model.ts';

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
const PEER_TIMEOUT_MS = 1000;

/** A replica's place in the cursor; `generation` is null in an entry written before ADR 0031 or by hand. */
type Position = { readonly generation: number | null; readonly seq: number };

/**
 * The request ring: seqs are contiguous, so slot `seq % RING` holds the record with that seq while it is still kept.
 * Each record is also one JSON line on stdout, the cluster log's copy (ADR 0024 item 5); `type` tells it from an event line.
 * `generation` tells this process's seqs from those of an earlier start under the same replica name (ADR 0031).
 */
export class RequestLog {
  readonly generation: number;
  readonly #ring: RequestRecord[] = [];
  readonly #write: (line: string) => void;
  #seq = 0;

  constructor(write: (line: string) => void = console.log, generation = Date.now()) {
    this.#write = write;
    this.generation = generation;
  }

  record(entry: Omit<RequestRecord, 'seq' | 't'>): void {
    const seq = ++this.#seq;
    const record = { seq, t: Date.now(), ...entry, path: entry.path.slice(0, PATH_MAX), ms: Math.round(entry.ms), waitMs: entry.waitMs === null ? null : Math.round(entry.waitMs) };
    this.#ring[seq % RING] = record;
    this.#write(JSON.stringify({ type: 'request', ...record }));
  }

  /** Oldest first: the kept records with a seq greater than `seq`, at most `limit`. */
  after(seq: number, limit: number): RequestRecord[] {
    const out: RequestRecord[] = [];
    for (let s = Math.max(seq + 1, this.#seq - RING + 1, 1); s <= this.#seq && out.length < limit; s++) out.push(this.#ring[s % RING]);
    return out;
  }

  /** This replica's page for its entry in `cursor`: an entry of another generation, or past the newest seq, resets to the oldest record kept. */
  page(cursor: string, replica: ReplicaId, limit: number): Omit<Page, 'records'> & { readonly records: RequestRecord[] } {
    const at = parseCursor(cursor).get(replica);
    const reset = at !== undefined && (at.generation !== this.generation || at.seq > this.#seq);
    return { replica, generation: this.generation, reset, records: this.after(reset ? 0 : at?.seq ?? 0, limit) };
  }
}

export const requests = new RequestLog();

/** A record as the admin API answers it: the app by name while it has one. */
export type NamedRecord = Omit<RequestRecord, 'app'> & { readonly app: string };
export type ReplicaRecord = NamedRecord & { readonly replica: ReplicaId };
/** One replica's records after its entry in the cursor; `reset` when that entry belongs to an earlier start of the replica. */
export type Page = { readonly replica: ReplicaId; readonly generation: number; readonly reset: boolean; readonly records: readonly NamedRecord[] };
/** `name` labels the source in `missing` when it does not answer. */
export type Source = { readonly name: string; readonly page: (cursor: string, limit: number) => Promise<Page> };
/** `reset` names the replicas that restarted since the cursor was issued. */
export type Feed = { readonly records: readonly ReplicaRecord[]; readonly cursor: string; readonly missing: readonly string[]; readonly reset: readonly ReplicaId[] };

/** `<replica>:<seq>@<generation>,...`; an entry that does not parse is left out, so that replica starts from its oldest record. */
function parseCursor(cursor: string): Map<string, Position> {
  const out = new Map<string, Position>();
  for (const entry of cursor.split(',')) {
    const at = entry.lastIndexOf(':');
    const [seqText, generationText] = entry.slice(at + 1).split('@');
    const seq = Number(seqText);
    const generation = Number(generationText);
    if (at > 0 && Number.isSafeInteger(seq) && seq >= 0) out.set(entry.slice(0, at), { seq, generation: Number.isSafeInteger(generation) ? generation : null });
  }
  return out;
}

const entry = (replica: string, { seq, generation }: Position) => (generation === null ? `${replica}:${seq}` : `${replica}:${seq}@${generation}`);

/**
 * Merges every source's page by `t` and keeps the oldest `limit`, so each replica's part is a prefix of its page and
 * its cursor entry moves to the last record kept, in the generation that answered. While a source is missing the cursor
 * keeps every entry it had, so the source resumes where it stopped; otherwise it keeps only the replicas that answered.
 */
export async function gather(cursor: string, limit: number, sources: readonly Source[]): Promise<Feed> {
  const before = parseCursor(cursor);
  const pages = await Promise.allSettled(sources.map((s) => s.page(cursor, limit)));
  const missing = sources.filter((_, i) => pages[i]!.status === 'rejected').map((s) => s.name);
  const answered = pages.flatMap((p) => (p.status === 'fulfilled' ? [p.value] : []));
  const records = answered.flatMap((p) => p.records.map((r) => ({ ...r, replica: p.replica })))
    .sort((a, b) => a.t - b.t || a.seq - b.seq)
    .slice(0, limit);
  const next = new Map<string, Position>(missing.length ? before : []);
  for (const p of answered) next.set(p.replica, { generation: p.generation, seq: p.reset ? 0 : before.get(p.replica)?.seq ?? 0 });
  for (const r of records) next.set(r.replica, { ...next.get(r.replica)!, seq: r.seq });
  return { records, cursor: [...next].map(([replica, at]) => entry(replica, at)).join(','), missing, reset: answered.filter((p) => p.reset).map((p) => p.replica) };
}

/**
 * One source per A record of `host`, the headless Service naming every replica (ADR 0024 item 5). Each is asked with
 * the caller's own credential headers; `known` remembers which replica answered at an address, to name it while it is missing.
 */
export async function peerSources(host: string, port: number, headers: Readonly<Record<string, string>>, known: Map<string, ReplicaId>): Promise<Source[]> {
  const addresses = await resolve4(host).catch(() => null);
  if (addresses === null) return [{ name: host, page: () => Promise.reject(new Error(`${host} does not resolve`)) }];
  return addresses.map((address) => ({
    name: known.get(address) ?? address,
    page: async (cursor, limit) => {
      const response = await fetch(`http://${address}:${port}/api/requests?local=1&limit=${limit}&after=${encodeURIComponent(cursor)}`, {
        headers, signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`${address} answered ${response.status}`);
      const page = (await response.json()) as Page;
      known.set(address, page.replica);
      return page;
    },
  }));
}
