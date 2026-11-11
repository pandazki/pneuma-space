export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type RecordEntry = { key: string; value: Json; revision: string };
export type RecordChange =
  | { kind: 'put'; key: string; expected: string | null; value: Json }
  | { kind: 'delete'; key: string; expected: string | null };
export type RecordCommit =
  | { ok: true; revisions: string[] }
  | { ok: false; reason: 'conflict' };
export type RecordPage = { items: RecordEntry[]; next: string | null };
export type RecordList = { prefix?: string; after?: string; limit?: number };

export interface Records {
  get(key: string): Promise<RecordEntry | null>;
  list(options?: RecordList): Promise<RecordPage>;
  commit(changes: RecordChange[]): Promise<RecordCommit>;
}

export type RecordsLimits = {
  valueBytes: number;
  totalBytes: number;
  count: number;
  batch: number;
  page: number;
};
export type RecordsAccess = { epoch: number; expiresAt: number };
export type ResourceMode = 'active' | 'suspended' | 'purged';
export type ResourceStatus = {
  mode: ResourceMode;
  sequence: number;
  epoch: number;
  count: number;
  bytes: number;
};
export type RecordsSnapshot = { format: 1; revision: number; records: RecordEntry[] };

export interface RecordsResource {
  transition(mode: ResourceMode, sequence: number): Promise<ResourceStatus>;
  status(): Promise<ResourceStatus>;
  get(access: RecordsAccess, key: string): Promise<RecordEntry | null>;
  list(access: RecordsAccess, options?: RecordList): Promise<RecordPage>;
  commit(access: RecordsAccess, changes: RecordChange[]): Promise<RecordCommit>;
  export(): Promise<RecordsSnapshot>;
  restore(snapshot: RecordsSnapshot, importKey: string): Promise<void>;
}
