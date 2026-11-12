import { conflict, forbidden, invalid, quota } from './errors.ts';
import type {
  Json, RecordChange, RecordCommit, RecordEntry, RecordList, RecordPage,
  RecordsAccess, RecordsLimits, RecordsResource, RecordsSnapshot, ResourceMode, ResourceStatus,
} from './records-contract.ts';
import type { SqlDatabase, SqlRow } from './sql.ts';

type Metadata = ResourceStatus & {
  revision: number;
  fresh: boolean;
  imported: { key: string; fingerprint: string } | null;
};
type StoredRecord = RecordEntry & { bytes: number };
type PreparedChange =
  | { kind: 'put'; key: string; expected: string | null; encoded: string; bytes: number }
  | { kind: 'delete'; key: string; expected: string | null };
type PreparedSnapshot = { revision: number; records: (StoredRecord & { encoded: string })[]; bytes: number };

const encoder = new TextEncoder();

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(`Invalid ${name}.`);
  return value;
}

function key(value: unknown, empty = false): string {
  if (typeof value !== 'string' || !value.isWellFormed() || /\p{Cc}/u.test(value)) invalid('Invalid record key.');
  const bytes = encoder.encode(value).byteLength;
  if (bytes > 200 || (!empty && bytes === 0)) invalid('Record keys must contain 1 to 200 UTF-8 bytes.');
  return value;
}

function json(value: unknown, ancestors = new Set<unknown>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) invalid('Record values must be finite JSON.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: Json[] = [];
      for (const item of value) items.push(json(item, ancestors));
      return items;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      invalid('Record values must be finite JSON.');
    }
    if (Object.getOwnPropertySymbols(value).length) invalid('Record values must be finite JSON.');
    const entries = Object.entries(value).map(([name, item]) => [name, json(item, ancestors)]);
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function encodedValue(value: unknown, limits: RecordsLimits): { encoded: string; bytes: number } {
  const encoded = JSON.stringify(json(value));
  const bytes = encoder.encode(encoded).byteLength;
  if (bytes > limits.valueBytes) quota('Record value exceeds the byte limit.');
  return { encoded, bytes };
}

function record(row: SqlRow): StoredRecord {
  if (typeof row.key !== 'string' || typeof row.value !== 'string' || typeof row.revision !== 'string'
    || typeof row.bytes !== 'number') throw new Error('Invalid stored record.');
  return { key: row.key, value: json(JSON.parse(row.value)), revision: row.revision, bytes: row.bytes };
}

function entry(stored: StoredRecord): RecordEntry {
  return { key: stored.key, value: stored.value, revision: stored.revision };
}

function status(metadata: Metadata): ResourceStatus {
  return {
    mode: metadata.mode, sequence: metadata.sequence, epoch: metadata.epoch,
    count: metadata.count, bytes: metadata.bytes,
  };
}

function prepareSnapshot(snapshot: RecordsSnapshot, limits: RecordsLimits): PreparedSnapshot {
  if (!snapshot || snapshot.format !== 1 || !Array.isArray(snapshot.records)) invalid('Invalid records snapshot.');
  const revision = integer(snapshot.revision, 'snapshot revision');
  if (snapshot.records.length > limits.count) quota('Records count exceeds the limit.');
  const keys = new Set<string>();
  const revisions = new Set<string>();
  let bytes = 0;
  const records: PreparedSnapshot['records'] = [];
  for (const item of snapshot.records) {
    if (!item || typeof item !== 'object') invalid('Invalid snapshot record.');
    const name = key(item.key);
    if (keys.has(name)) invalid('Snapshot record keys must be distinct.');
    keys.add(name);
    if (typeof item.revision !== 'string' || !/^[1-9][0-9]*$/.test(item.revision)) invalid('Invalid record revision.');
    const current = integer(Number(item.revision), 'record revision');
    if (current > revision || revisions.has(item.revision)) invalid('Invalid snapshot revision watermark.');
    revisions.add(item.revision);
    const value = encodedValue(item.value, limits);
    const liveBytes = value.bytes + encoder.encode(name).byteLength;
    bytes += liveBytes;
    if (bytes > limits.totalBytes) quota('Records bytes exceed the limit.');
    records.push({ key: name, value: json(JSON.parse(value.encoded)), revision: item.revision, bytes: liveBytes, encoded: value.encoded });
  }
  return { revision, records, bytes };
}

export function validateRecordsSnapshot(raw: unknown, limits: RecordsLimits): RecordsSnapshot {
  if (!raw || typeof raw !== 'object' || !('format' in raw) || raw.format !== 1
    || !('revision' in raw) || typeof raw.revision !== 'number' || !('records' in raw) || !Array.isArray(raw.records)) {
    invalid('Invalid records snapshot.');
  }
  const snapshot: RecordsSnapshot = { format: 1, revision: raw.revision, records: raw.records };
  const prepared = prepareSnapshot(snapshot, limits);
  return { format: 1, revision: prepared.revision, records: prepared.records.map(entry) };
}

export class SqlRecordsResource implements RecordsResource {
  readonly #database: SqlDatabase;
  readonly #limits: RecordsLimits;
  readonly #now: () => number;

  constructor(database: SqlDatabase, limits: RecordsLimits, now: () => number = Date.now) {
    for (const [name, value] of Object.entries(limits)) integer(value, `${name} limit`);
    this.#database = database;
    this.#limits = { ...limits };
    this.#now = now;
    database.query(`CREATE TABLE IF NOT EXISTS pneuma_space_records_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, sequence INTEGER NOT NULL,
      epoch INTEGER NOT NULL, count INTEGER NOT NULL, bytes INTEGER NOT NULL, revision INTEGER NOT NULL,
      fresh INTEGER NOT NULL, import_key TEXT, import_fingerprint TEXT
    )`);
    database.query(`CREATE TABLE IF NOT EXISTS pneuma_space_records (
      key TEXT PRIMARY KEY COLLATE BINARY, value TEXT NOT NULL, revision TEXT NOT NULL, bytes INTEGER NOT NULL
    )`);
  }

  #metadata(): Metadata {
    const row = this.#database.query('SELECT * FROM pneuma_space_records_state WHERE id = 1')[0];
    if (!row) return { mode: 'suspended', sequence: 0, epoch: 0, count: 0, bytes: 0, revision: 0, fresh: true, imported: null };
    if ((row.mode !== 'active' && row.mode !== 'suspended' && row.mode !== 'purged')
      || typeof row.sequence !== 'number' || typeof row.epoch !== 'number' || typeof row.count !== 'number'
      || typeof row.bytes !== 'number' || typeof row.revision !== 'number' || typeof row.fresh !== 'number') {
      throw new Error('Invalid records resource state.');
    }
    let imported: Metadata['imported'] = null;
    if (row.import_key !== null || row.import_fingerprint !== null) {
      if (typeof row.import_key !== 'string' || typeof row.import_fingerprint !== 'string') throw new Error('Invalid records import state.');
      imported = { key: row.import_key, fingerprint: row.import_fingerprint };
    }
    return {
      mode: row.mode, sequence: row.sequence, epoch: row.epoch, count: row.count,
      bytes: row.bytes, revision: row.revision, fresh: row.fresh === 1, imported,
    };
  }

  #save(metadata: Metadata): void {
    this.#database.query(`INSERT OR REPLACE INTO pneuma_space_records_state
      (id, mode, sequence, epoch, count, bytes, revision, fresh, import_key, import_fingerprint)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    metadata.mode, metadata.sequence, metadata.epoch, metadata.count, metadata.bytes,
    metadata.revision, metadata.fresh ? 1 : 0, metadata.imported?.key ?? null, metadata.imported?.fingerprint ?? null);
  }

  #access(access: RecordsAccess): Metadata {
    const metadata = this.#metadata();
    if (metadata.mode !== 'active' || access.epoch !== metadata.epoch
      || !Number.isFinite(access.expiresAt) || access.expiresAt <= this.#now()) forbidden('Records access has expired or been suspended.');
    return metadata;
  }

  async transition(mode: ResourceMode, sequence: number): Promise<ResourceStatus> {
    if (mode !== 'active' && mode !== 'suspended' && mode !== 'purged') invalid('Invalid resource mode.');
    integer(sequence, 'resource sequence');
    return this.#database.transaction(() => {
      const metadata = this.#metadata();
      if (sequence < metadata.sequence) return status(metadata);
      if (sequence === metadata.sequence && metadata.epoch !== 0) {
        if (mode !== metadata.mode) conflict('A lifecycle sequence cannot have conflicting modes.');
        return status(metadata);
      }
      if (metadata.mode === 'purged' && mode !== 'purged') conflict('A purged resource cannot be revived.');
      if (metadata.mode === 'active' && mode === 'purged') conflict('Suspend the resource before purging it.');
      const epoch = metadata.epoch + (mode !== metadata.mode || metadata.epoch === 0 ? 1 : 0);
      integer(epoch, 'resource epoch');
      if (mode === 'purged') this.#database.query('DELETE FROM pneuma_space_records');
      const next: Metadata = {
        ...metadata, mode, sequence, epoch,
        fresh: metadata.fresh && mode === 'suspended',
        count: mode === 'purged' ? 0 : metadata.count,
        bytes: mode === 'purged' ? 0 : metadata.bytes,
        imported: mode === 'purged' ? null : metadata.imported,
      };
      this.#save(next);
      return status(next);
    });
  }

  async status(): Promise<ResourceStatus> {
    return this.#database.transaction(() => status(this.#metadata()));
  }

  async get(access: RecordsAccess, name: string): Promise<RecordEntry | null> {
    key(name);
    return this.#database.transaction(() => {
      this.#access(access);
      const row = this.#database.query('SELECT * FROM pneuma_space_records WHERE key = ?', name)[0];
      return row ? entry(record(row)) : null;
    });
  }

  async list(access: RecordsAccess, options: RecordList = {}): Promise<RecordPage> {
    const prefix = key(options.prefix ?? '', true);
    const after = options.after === undefined ? null : key(options.after);
    const limit = integer(options.limit ?? this.#limits.page, 'page limit');
    if (limit === 0 || limit > this.#limits.page) invalid('Invalid page limit.');
    return this.#database.transaction(() => {
      this.#access(access);
      const rows = this.#database.query(`SELECT * FROM pneuma_space_records
        WHERE substr(key, 1, length(?)) = ? AND (? IS NULL OR key > ?)
        ORDER BY key COLLATE BINARY LIMIT ?`, prefix, prefix, after, after, limit + 1);
      const items = rows.slice(0, limit).map(row => entry(record(row)));
      return { items, next: rows.length > limit ? items.at(-1)?.key ?? null : null };
    });
  }

  async commit(access: RecordsAccess, changes: RecordChange[]): Promise<RecordCommit> {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > this.#limits.batch) invalid('Invalid records batch size.');
    const keys = new Set<string>();
    const prepared: PreparedChange[] = changes.map(change => {
      if (!change || (change.kind !== 'put' && change.kind !== 'delete')) invalid('Invalid record change.');
      const name = key(change.key);
      if (keys.has(name)) invalid('Commit keys must be distinct.');
      keys.add(name);
      if (change.expected !== null && typeof change.expected !== 'string') invalid('Invalid expected revision.');
      if (change.kind === 'delete') return { kind: 'delete', key: name, expected: change.expected };
      const value = encodedValue(change.value, this.#limits);
      return { kind: 'put', key: name, expected: change.expected, encoded: value.encoded, bytes: value.bytes + encoder.encode(name).byteLength };
    });
    return this.#database.transaction(() => {
      const metadata = this.#access(access);
      let count = metadata.count;
      let bytes = metadata.bytes;
      for (const change of prepared) {
        const row = this.#database.query('SELECT * FROM pneuma_space_records WHERE key = ?', change.key)[0];
        const current = row ? record(row) : null;
        if ((current?.revision ?? null) !== change.expected) return { ok: false, reason: 'conflict' };
        count += (change.kind === 'put' ? 1 : 0) - (current ? 1 : 0);
        bytes += (change.kind === 'put' ? change.bytes : 0) - (current?.bytes ?? 0);
      }
      if (count > this.#limits.count) quota('Records count exceeds the limit.');
      if (bytes > this.#limits.totalBytes) quota('Records bytes exceed the limit.');
      const watermark = integer(metadata.revision + prepared.length, 'revision watermark');
      const revisions = prepared.map((change, index) => {
        const revision = String(metadata.revision + index + 1);
        if (change.kind === 'delete') this.#database.query('DELETE FROM pneuma_space_records WHERE key = ?', change.key);
        else this.#database.query('INSERT OR REPLACE INTO pneuma_space_records (key, value, revision, bytes) VALUES (?, ?, ?, ?)',
          change.key, change.encoded, revision, change.bytes);
        return revision;
      });
      this.#save({ ...metadata, count, bytes, revision: watermark, fresh: false });
      return { ok: true, revisions };
    });
  }

  async export(): Promise<RecordsSnapshot> {
    return this.#database.transaction(() => {
      const metadata = this.#metadata();
      if (metadata.mode !== 'suspended') conflict('Suspend the resource before exporting it.');
      const records = this.#database.query('SELECT * FROM pneuma_space_records ORDER BY key COLLATE BINARY').map(row => entry(record(row)));
      return { format: 1, revision: metadata.revision, records };
    });
  }

  async restore(snapshot: RecordsSnapshot, importKey: string): Promise<void> {
    if (typeof importKey !== 'string' || importKey.length === 0 || encoder.encode(importKey).byteLength > 200) invalid('Invalid import key.');
    const prepared = prepareSnapshot(snapshot, this.#limits);
    const content = JSON.stringify({ revision: prepared.revision, records: prepared.records.map(entry) });
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content));
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    this.#database.transaction(() => {
      const metadata = this.#metadata();
      if (metadata.imported?.key === importKey) {
        if (metadata.imported.fingerprint !== fingerprint) conflict('The import key was used with different records.');
        return;
      }
      if (metadata.mode !== 'suspended' || !metadata.fresh || metadata.count !== 0 || metadata.revision !== 0
        || this.#database.query('SELECT key FROM pneuma_space_records LIMIT 1').length) {
        conflict('Restore requires a fresh empty suspended resource.');
      }
      for (const item of prepared.records) {
        this.#database.query('INSERT INTO pneuma_space_records (key, value, revision, bytes) VALUES (?, ?, ?, ?)',
          item.key, item.encoded, item.revision, item.bytes);
      }
      this.#save({ ...metadata, fresh: false, count: prepared.records.length, bytes: prepared.bytes,
        revision: prepared.revision, imported: { key: importKey, fingerprint } });
    });
  }
}
