import { resolve4 } from 'node:dns/promises';
import { get } from 'node:http';
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

/**
 * The request ring: seqs are contiguous, so slot `seq % RING` holds the record with that seq while it is still kept.
 * Each record is also one JSON line on stdout, the cluster log's copy (ADR 0024 item 5); `type` tells it from an event line.
 */
export class RequestLog {
  readonly #ring: RequestRecord[] = [];
  readonly #write: (line: string) => void;
  #seq = 0;

  constructor(write: (line: string) => void = console.log) {
    this.#write = write;
  }

  record(entry: Omit<RequestRecord, 'seq' | 't'>): void {
    const seq = ++this.#seq;
    const record = { seq, t: Date.now(), ...entry, path: entry.path.slice(0, PATH_MAX), ms: Math.round(entry.ms), waitMs: entry.waitMs === null ? null : Math.round(entry.waitMs) };
    this.#ring[seq % RING] = record;
    this.#write(JSON.stringify({ type: 'request', ...record }));
  }

  /** Oldest first: the kept records with a seq greater than `seq`, at most `limit`. A seq beyond the newest was issued before this process restarted, and starts over. */
  after(seq: number, limit: number): RequestRecord[] {
    const from = seq > this.#seq ? 0 : seq;
    const out: RequestRecord[] = [];
    for (let s = Math.max(from + 1, this.#seq - RING + 1, 1); s <= this.#seq && out.length < limit; s++) out.push(this.#ring[s % RING]);
    return out;
  }
}

export const requests = new RequestLog();

/** A record as the admin API answers it: the app by name while it has one. */
export type NamedRecord = Omit<RequestRecord, 'app'> & { readonly app: string };
export type ReplicaRecord = NamedRecord & { readonly replica: ReplicaId };
/** One replica's records after its seq in the cursor. */
export type Page = { readonly replica: ReplicaId; readonly records: readonly NamedRecord[] };
/** `name` labels the source in `missing` when it does not answer. */
export type Source = { readonly name: string; readonly page: (cursor: string, limit: number) => Promise<Page> };
export type Feed = { readonly records: readonly ReplicaRecord[]; readonly cursor: string; readonly missing: readonly string[] };

/** `<replica>:<seq>,...`; an entry that does not parse is left out, so that replica starts from its oldest record. */
function parseCursor(cursor: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of cursor.split(',')) {
    const at = entry.lastIndexOf(':');
    const seq = Number(entry.slice(at + 1));
    if (at > 0 && Number.isSafeInteger(seq) && seq >= 0) out.set(entry.slice(0, at), seq);
  }
  return out;
}

export const seqIn = (cursor: string, replica: ReplicaId): number => parseCursor(cursor).get(replica) ?? 0;

/**
 * Merges every source's page by `t` and keeps the oldest `limit`, so each replica's part is a prefix of its page and
 * its cursor entry moves to the last record kept. While a source is missing the cursor keeps every entry it had, so the
 * source resumes where it stopped; otherwise it keeps only the replicas that answered.
 */
export async function gather(cursor: string, limit: number, sources: readonly Source[]): Promise<Feed> {
  const before = parseCursor(cursor);
  const pages = await Promise.allSettled(sources.map((s) => s.page(cursor, limit)));
  const missing = sources.filter((_, i) => pages[i]!.status === 'rejected').map((s) => s.name);
  const answered = pages.flatMap((p) => (p.status === 'fulfilled' ? [p.value] : []));
  const records = answered.flatMap((p) => p.records.map((r) => ({ ...r, replica: p.replica })))
    .sort((a, b) => a.t - b.t || a.seq - b.seq)
    .slice(0, limit);
  const next = new Map(missing.length ? before : answered.map((p) => [p.replica, before.get(p.replica) ?? 0]));
  for (const r of records) next.set(r.replica, r.seq);
  return { records, cursor: [...next].map(([replica, seq]) => `${replica}:${seq}`).join(','), missing };
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
      // Node fetch replaces Host, which changes the origin of a forwarded hosted session.
      const page = await new Promise<Page>((resolve, reject) => {
        const request = get(`http://${address}:${port}/api/requests?local=1&limit=${limit}&after=${encodeURIComponent(cursor)}`, {
          headers, signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
        }, (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`${address} answered ${response.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Page); }
            catch (error) { reject(error); }
          });
        });
        request.on('error', reject);
      });
      known.set(address, page.replica);
      return page;
    },
  }));
}
