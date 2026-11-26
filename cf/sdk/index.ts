import type { Json, NativeCommand, SqlStatement, SqlValue } from '../src/model.ts';

export type Revisioned = { value: Json; revision: number };
export type KvRecord = Revisioned & { key: string; expiresAt: number | null };
export type FileRecord = { path: string; body: string; revision: number; bytes: number };
export type ObjectRecord = { key: string; bytes: number; contentType: string; etag: string; uploadedAt: number };
export type Ticket = { id: string; url: string; headers: Record<string, string>; expiresAt: number };
export type List<T> = { items: T[]; nextCursor?: string };
export type SqlResult = { rows: Record<string, string | number | null>[]; columns: string[]; rowsRead: number; rowsWritten: number };
export type IceConfiguration = { iceServers: { urls: string[]; username?: string; credential?: string }[]; expiresAt: number };
export class SpaceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
async function command<T>(body: NativeCommand): Promise<T> {
  const response = await fetch('http://pneuma-space.internal/broker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const data: unknown = await response.json();
    if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' && 'message' in data.error && typeof data.error.message === 'string' && 'code' in data.error && typeof data.error.code === 'string') throw new SpaceError(response.status, data.error.code, data.error.message);
    throw new SpaceError(response.status, 'broker', 'The capability request failed.');
  }
  return response.json();
}
function base64(bytes: Uint8Array): string {
  if (bytes.byteLength > 65536) throw new RangeError('Files are limited to 64 KiB.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export const space = {
  db: {
    query: (sql: string, params: SqlValue[] = []) => command<SqlResult>({ type: 'db.query', sql, params }),
    batch: (statements: SqlStatement[]) => command<{ results: SqlResult[] }>({ type: 'db.batch', statements }),
  },
  kv: {
    get: (key: string) => command<KvRecord | null>({ type: 'kv.get', key }),
    put: (key: string, value: Json, options: { expected?: number | null; ttl?: number } = {}) => command<Revisioned>({ type: 'kv.put', key, value, ...options }),
    delete: (key: string, options: { expected?: number } = {}) => command<{ deleted: boolean }>({ type: 'kv.delete', key, ...options }),
    list: (options: { prefix?: string; cursor?: string } = {}) => command<List<KvRecord>>({ type: 'kv.list', ...options }),
    increment: (key: string, amount = 1) => command<Revisioned>({ type: 'kv.increment', key, amount }),
    publish: (channel: string, value: Json) => command<{ subscribers: number }>({ type: 'kv.publish', channel, value }),
  },
  files: {
    get: (path: string) => command<FileRecord | null>({ type: 'files.get', path }),
    put: (path: string, body: Uint8Array, options: { expected?: number | null } = {}) => command<FileRecord>({ type: 'files.put', path, body: base64(body), ...options }),
    delete: (path: string, options: { expected?: number } = {}) => command<{ deleted: boolean }>({ type: 'files.delete', path, ...options }),
    list: (options: { prefix?: string; cursor?: string } = {}) => command<List<FileRecord>>({ type: 'files.list', ...options }),
    bytes: (file: FileRecord): Uint8Array => Uint8Array.from(atob(file.body), char => char.charCodeAt(0)),
  },
  objects: {
    upload: (options: { key: string; bytes: number; contentType: string }) => command<Ticket>({ type: 'object.upload', ...options }),
    complete: (id: string) => command<ObjectRecord>({ type: 'object.complete', id }),
    download: (key: string) => command<Ticket>({ type: 'object.download', key }),
    list: (options: { prefix?: string; cursor?: string } = {}) => command<List<ObjectRecord>>({ type: 'object.list', ...options }),
    delete: (key: string) => command<{ deleted: boolean }>({ type: 'object.delete', key }),
  },
  rtc: { credentials: () => command<IceConfiguration>({ type: 'rtc.credentials' }) },
  subscribe: (channel: string): WebSocket => new WebSocket('ws://pneuma-space.internal/subscribe/' + encodeURIComponent(channel)),
};
