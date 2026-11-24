import { CAPABILITIES, fail, type Capability, type ExecutionScope, type Json, type Manifest, type NativeCommand, type Policy, type SqlStatement, type SqlValue } from './model.ts';
import { boundedBody, id, integer, record, safePath, text } from './util.ts';
import { signR2 } from './s3.ts';

const MAX_RESULT = 256 * 1024;
const PAGE = 100;
const encoder = new TextEncoder();
const size = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
type KvEntry = { value: Json; revision: number; expiresAt: number | null };
type FileEntry = { path: string; body: string; revision: number; bytes: number };
type ObjectEntry = { key: string; r2Key: string; bytes: number; contentType: string; etag: string; uploadedAt: number };
type Upload = { id: string; key: string; r2Key: string; bytes: number; contentType: string; expiresAt: number; complete: boolean };
type ResourceState = { capabilities: Capability[]; suspended: boolean };
export type ResourceHooks = { guard: (scope: ExecutionScope | null, capability: Capability) => void; policy: () => Policy; broadcast: (channel: string, value: Json) => number };
export type SqlResult = { rows: Record<string, SqlValue>[]; columns: string[]; rowsRead: number; rowsWritten: number };

function jsonValue(value: unknown, depth = 0): Json {
  if (depth > 30) fail(400, 'input', 'JSON nesting is too deep.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(v => jsonValue(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonValue(v, depth + 1)]));
  return fail(400, 'input', 'Expected a JSON value.');
}
function sqlStatement(value: unknown): SqlStatement {
  const item = record(value);
  if (typeof item.sql !== 'string' || !item.sql.trim() || item.sql.length > 32 * 1024 || item.sql.includes('\0')) fail(400, 'input', 'Invalid SQL.');
  const sql = item.sql;
  if (!Array.isArray(item.params) || item.params.length > 100) fail(400, 'input', 'Invalid SQL parameters.');
  const params = item.params.map((p): SqlValue => {
    if (p === null || typeof p === 'string' || typeof p === 'number' && Number.isFinite(p)) return p;
    return fail(400, 'input', 'Invalid SQL parameter.');
  });
  // Split only outside SQLite literals and comments; transaction control would escape the fence transaction.
  const stripped = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  if (/\S/.test(stripped.replace(/;\s*$/, '').split(';').slice(1).join(';')) || /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|END)\b/i.test(stripped.split(/\s+/).filter(Boolean)[0] ?? '')) fail(400, 'sql_statement', 'Use a single statement without transaction control.');
  return { sql, params };
}
function optionalRevision(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return integer(value, 'revision', 1, Number.MAX_SAFE_INTEGER);
}
function listOptions(item: Record<string, unknown>): { prefix?: string; cursor?: string } {
  return { prefix: item.prefix === undefined ? undefined : typeof item.prefix === 'string' && item.prefix.length <= 300 ? item.prefix : fail(400, 'input', 'Invalid prefix.'), cursor: item.cursor === undefined ? undefined : text(item.cursor, 'cursor', 600) };
}
export function parseNativeCommand(value: unknown): NativeCommand {
  const item = record(value);
  if (size(item) > MAX_RESULT) fail(413, 'body_limit', 'Command is too large.');
  switch (item.type) {
    case 'db.query': return { type: item.type, ...sqlStatement(item) };
    case 'db.batch': {
      if (!Array.isArray(item.statements) || !item.statements.length || item.statements.length > 32) fail(400, 'input', 'Use one to 32 SQL statements.');
      return { type: item.type, statements: item.statements.map(sqlStatement) };
    }
    case 'kv.get': return { type: item.type, key: text(item.key, 'key', 300) };
    case 'kv.list': case 'files.list': case 'object.list': return { type: item.type, ...listOptions(item) };
    case 'kv.put': return { type: item.type, key: text(item.key, 'key', 300), value: jsonValue(item.value), expected: optionalRevision(item.expected), ttl: item.ttl === undefined ? undefined : integer(item.ttl, 'TTL seconds', 1, 86400 * 365) };
    case 'kv.delete': return { type: item.type, key: text(item.key, 'key', 300), expected: item.expected === undefined ? undefined : integer(item.expected, 'revision', 1, Number.MAX_SAFE_INTEGER) };
    case 'kv.increment': return { type: item.type, key: text(item.key, 'key', 300), amount: integer(item.amount, 'increment', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) };
    case 'kv.publish': return { type: item.type, channel: text(item.channel, 'channel', 200), value: jsonValue(item.value) };
    case 'files.get': return { type: item.type, path: safePath(item.path) };
    case 'files.put': {
      if (typeof item.body !== 'string' || item.body.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.body)) fail(400, 'file_body', 'Expected base64 file data of at most 64 KiB.');
      if (atob(item.body).length > 65536) fail(413, 'file_limit', 'File exceeds 64 KiB.');
      return { type: item.type, path: safePath(item.path), body: item.body, expected: optionalRevision(item.expected) };
    }
    case 'files.delete': return { type: item.type, path: safePath(item.path), expected: item.expected === undefined ? undefined : integer(item.expected, 'revision', 1, Number.MAX_SAFE_INTEGER) };
    case 'object.upload': return { type: item.type, key: safePath(item.key), bytes: integer(item.bytes, 'object bytes', 0, 100 * 1024 * 1024), contentType: text(item.contentType, 'content type', 200).trim() };
    case 'object.complete': return { type: item.type, id: text(item.id, 'upload ID', 100) };
    case 'object.download': case 'object.delete': return { type: item.type, key: safePath(item.key) };
    case 'rtc.credentials': return { type: item.type };
    default: return fail(400, 'command', 'Unknown native command.');
  }
}

interface Provider { ensure(): void; inject(): { available: boolean }; suspend(): void; destroy(): void }
class NativeProvider implements Provider {
  private kv: SyncKvStorage;
  private capability: Capability;
  constructor(kv: SyncKvStorage, capability: Capability) { this.kv = kv; this.capability = capability; }
  ensure(): void { this.kv.put('resource:provider:' + this.capability, { available: true }); }
  inject(): { available: boolean } { return this.kv.get<{ available: boolean }>('resource:provider:' + this.capability) ?? { available: false }; }
  suspend(): void { this.kv.put('resource:provider:' + this.capability, { available: false }); }
  destroy(): void { this.kv.delete('resource:provider:' + this.capability); }
}
export class NativeResources {
  private providers: Map<Capability, Provider>;
  private storage: DurableObjectStorage;
  private env: Env;
  private appId: string;
  private hooks: ResourceHooks;
  constructor(storage: DurableObjectStorage, env: Env, appId: string, hooks: ResourceHooks) {
    this.storage = storage; this.env = env; this.appId = appId; this.hooks = hooks;
    this.providers = new Map(Object.keys(CAPABILITIES).map(name => {
      const capability = name as Capability;
      return [capability, new NativeProvider(storage.kv, capability)];
    }));
  }
  ensure(manifest: Manifest): void {
    this.storage.transactionSync(() => {
      if (this.storage.kv.get('resource:purging')) fail(410, 'purged', 'Application data is terminal.');
      if (manifest.capabilities.rtc && (!this.env.PNEUMA_SPACE_TURN_KEY_ID || !this.env.PNEUMA_SPACE_TURN_API_TOKEN)) fail(503, 'unconfigured', 'TURN is not configured.');
      const capabilities = Array.from(this.providers.keys()).filter(cap => manifest.capabilities[cap] !== undefined);
      for (const [cap, provider] of this.providers) { if (capabilities.includes(cap)) provider.ensure(); else provider.suspend(); }
      this.storage.kv.put<ResourceState>('resource:state', { capabilities, suspended: false });
    });
  }
  suspend(): void {
    this.storage.transactionSync(() => {
      const state = this.storage.kv.get<ResourceState>('resource:state');
      if (state) this.storage.kv.put('resource:state', { ...state, suspended: true });
      for (const provider of this.providers.values()) provider.suspend();
    });
  }
  private guard(scope: ExecutionScope | null, capability: Capability): void {
    this.hooks.guard(scope, capability);
    if (this.storage.kv.get('resource:purging')) fail(410, 'purged', 'Application data is terminal.');
    const state = this.storage.kv.get<ResourceState>('resource:state');
    if (state?.suspended) fail(409, 'removed', 'Application resources are suspended.');
    if (!state?.capabilities.includes(capability)) fail(403, 'capability', 'Capability is not declared.');
  }
  private nextRevision(): number {
    const revision = (this.storage.kv.get<number>('resource:revision') ?? 0) + 1;
    this.storage.kv.put('resource:revision', revision);
    return revision;
  }
  private kvGet(key: string): KvEntry | null {
    const entry = this.storage.kv.get<KvEntry>('kv:' + key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) { this.storage.kv.delete('kv:' + key); return null; }
    return entry ?? null;
  }
  private expected(entry: { revision: number } | null | undefined, expected: number | null | undefined): void {
    if (expected !== undefined && (entry?.revision ?? null) !== expected) fail(409, 'revision', 'Revision does not match.');
  }
  private accounting(): { nativeBytes: number; objectBytes: number } {
    let nativeBytes = 0;
    const objects = new Map<string, number>();
    for (const [, entry] of this.storage.kv.list<KvEntry>({ prefix: 'kv:' })) {
      if (entry.expiresAt === null || entry.expiresAt > Date.now()) nativeBytes += size(entry);
    }
    for (const [, entry] of this.storage.kv.list<FileEntry>({ prefix: 'file:' })) nativeBytes += size(entry);
    for (const prefix of ['object:data:', 'object:garbage:']) {
      for (const [, entry] of this.storage.kv.list<ObjectEntry>({ prefix })) objects.set(entry.r2Key, entry.bytes);
    }
    for (const [, upload] of this.storage.kv.list<Upload>({ prefix: 'object:upload:' })) objects.set(upload.r2Key, upload.bytes);
    return { nativeBytes, objectBytes: Array.from(objects.values()).reduce((sum, bytes) => sum + bytes, 0) };
  }
  private bytes(): number {
    const { nativeBytes, objectBytes } = this.accounting();
    return Math.max(nativeBytes, this.storage.sql.databaseSize) + objectBytes;
  }
  private quota(): void {
    if (this.bytes() > this.hooks.policy().storageBytes) fail(429, 'storage_quota', 'Application storage quota exceeded.');
  }
  private sql(statement: SqlStatement): SqlResult {
    try { return this.executeSql(statement); }
    catch (error) {
      if (error instanceof Error) {
        if (/: SQLITE_AUTH$/.test(error.message)) fail(403, 'sql_access', 'SQL cannot access platform storage.');
        if (/: SQLITE_(?:ERROR|CONSTRAINT(?:_\w+)?|MISMATCH|RANGE)$/.test(error.message)) fail(400, 'sql_statement', error.message);
      }
      throw error;
    }
  }
  private executeSql(statement: SqlStatement): SqlResult {
    const beforeBytes = this.storage.sql.databaseSize;
    const cursor = this.storage.sql.exec(statement.sql, ...statement.params);
    const rows: Record<string, SqlValue>[] = [];
    let bytes = size(cursor.columnNames);
    for (const row of cursor) {
      const result = Object.fromEntries(Object.entries(row).map(([key, value]): [string, SqlValue] => {
        if (!(value instanceof ArrayBuffer)) return [key, value];
        if (value.byteLength > MAX_RESULT) fail(413, 'result_limit', 'SQL blob exceeds its result limit.');
        let binary = '';
        for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
        return [key, btoa(binary)];
      }));
      bytes += size(result);
      if (rows.length >= 1000 || bytes > MAX_RESULT) fail(413, 'result_limit', 'SQL result exceeds its limit.');
      rows.push(result);
    }
    if (cursor.rowsWritten || this.storage.sql.databaseSize > beforeBytes) this.quota();
    return { rows, columns: cursor.columnNames, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
  }
  private list<T>(prefix: string, options: { prefix?: string; cursor?: string }, visible: (value: T) => boolean = () => true): { items: T[]; nextCursor?: string } {
    const start = prefix + (options.prefix ?? '');
    if (options.cursor !== undefined && !options.cursor.startsWith(start)) fail(400, 'cursor', 'Cursor does not match this listing.');
    const items: T[] = [];
    let bytes = 0;
    let nextCursor: string | undefined;
    for (const [key, value] of this.storage.kv.list<T>({ prefix: start, startAfter: options.cursor })) {
      if (!visible(value)) continue;
      const entryBytes = size(value);
      if (entryBytes > MAX_RESULT) fail(413, 'result_limit', 'Listing entry exceeds its result limit.');
      if (items.length === PAGE || bytes + entryBytes > MAX_RESULT) return { items, nextCursor };
      items.push(value); bytes += entryBytes; nextCursor = key;
    }
    return { items };
  }
  async perform(value: unknown, scope: ExecutionScope | null): Promise<unknown> {
    const command = parseNativeCommand(value);
    const capability = command.type.split('.')[0] === 'object' ? 'object' : command.type.split('.')[0] as Capability;
    if (capability === 'object') return this.object(command, scope);
    if (command.type === 'rtc.credentials') return this.rtc(scope);
    return this.storage.transactionSync(() => {
      this.guard(scope, capability);
      switch (command.type) {
        case 'db.query': return this.sql(command);
        case 'db.batch': { const results = command.statements.map(statement => this.sql(statement)); if (size(results) > MAX_RESULT) fail(413, 'result_limit', 'SQL batch result exceeds its limit.'); return { results }; }
        case 'kv.get': return this.kvGet(command.key);
        case 'kv.list': return this.list<KvEntry & { key: string }>('kv:', command, item => item.expiresAt === null || item.expiresAt > Date.now());
        case 'kv.put': {
          this.expected(this.kvGet(command.key), command.expected);
          const entry = { key: command.key, value: command.value, revision: this.nextRevision(), expiresAt: command.ttl === undefined ? null : Date.now() + command.ttl * 1000 };
          this.storage.kv.put('kv:' + command.key, entry); this.quota();
          return { value: entry.value, revision: entry.revision };
        }
        case 'kv.increment': {
          const old = this.kvGet(command.key);
          if (old && typeof old.value !== 'number') fail(409, 'value_type', 'The value is not numeric.');
          const value = (typeof old?.value === 'number' ? old.value : 0) + command.amount;
          if (!Number.isSafeInteger(value)) fail(409, 'value_range', 'The increment exceeds the integer range.');
          const entry = { key: command.key, value, revision: this.nextRevision(), expiresAt: old?.expiresAt ?? null };
          this.storage.kv.put('kv:' + command.key, entry); this.quota(); return { value, revision: entry.revision };
        }
        case 'kv.delete': this.expected(this.kvGet(command.key), command.expected); return { deleted: this.storage.kv.delete('kv:' + command.key) };
        case 'kv.publish': return { subscribers: this.hooks.broadcast(command.channel, command.value) };
        case 'files.get': return this.storage.kv.get<FileEntry>('file:' + command.path) ?? null;
        case 'files.list': return this.list<FileEntry>('file:', command);
        case 'files.put': {
          this.expected(this.storage.kv.get<FileEntry>('file:' + command.path), command.expected);
          const entry = { path: command.path, body: command.body, revision: this.nextRevision(), bytes: atob(command.body).length };
          this.storage.kv.put('file:' + command.path, entry); this.quota(); return entry;
        }
        case 'files.delete': this.expected(this.storage.kv.get<FileEntry>('file:' + command.path), command.expected); return { deleted: this.storage.kv.delete('file:' + command.path) };
        default: return fail(400, 'command', 'Unsupported command.');
      }
    });
  }
  private async object(command: NativeCommand, scope: ExecutionScope | null): Promise<unknown> {
    this.storage.transactionSync(() => this.guard(scope, 'object'));
    await this.cleanupObjects(scope);
    this.storage.transactionSync(() => this.guard(scope, 'object'));
    const bucket = this.env.PNEUMA_SPACE_OBJECTS;
    switch (command.type) {
      case 'object.upload': {
        const uploadId = id('upload');
        const r2Key = 'apps/' + this.appId + '/objects/' + uploadId;
        const ticket = await signR2(this.env, this.env.PNEUMA_SPACE_OBJECT_BUCKET, r2Key, 'PUT', { contentType: command.contentType, contentLength: command.bytes });
        this.storage.transactionSync(() => {
          this.guard(scope, 'object');
          this.storage.kv.put<Upload>('object:upload:' + uploadId, { id: uploadId, key: command.key, r2Key, bytes: command.bytes, contentType: command.contentType, expiresAt: ticket.expiresAt, complete: false });
          this.quota();
        });
        return { id: uploadId, ...ticket };
      }
      case 'object.complete': {
        const upload = this.storage.kv.get<Upload>('object:upload:' + command.id);
        if (!upload) fail(404, 'upload', 'Upload does not exist.');
        if (upload.expiresAt <= Date.now()) fail(410, 'upload_expired', 'Upload has expired.');
        const head = await bucket.head(upload.r2Key);
        return this.storage.transactionSync(() => {
          this.guard(scope, 'object');
          if (!head) fail(409, 'upload_missing', 'Upload has not reached R2.');
          if (head.size !== upload.bytes || head.httpMetadata?.contentType !== upload.contentType) fail(409, 'upload_metadata', 'Upload size or content type does not match.');
          const currentUpload = this.storage.kv.get<Upload>('object:upload:' + upload.id);
          if (!currentUpload || currentUpload.expiresAt <= Date.now()) fail(410, 'upload_expired', 'Upload has expired.');
          const previous = this.storage.kv.get<ObjectEntry>('object:data:' + upload.key);
          if (currentUpload.complete) {
            if (previous?.r2Key !== upload.r2Key) fail(409, 'upload_replaced', 'Upload was replaced or deleted.');
            return this.publicObject(previous);
          }
          const entry: ObjectEntry = { key: upload.key, r2Key: upload.r2Key, bytes: upload.bytes, contentType: upload.contentType, etag: head.etag, uploadedAt: head.uploaded.getTime() };
          if (previous) this.storage.kv.put('object:garbage:' + previous.r2Key, previous);
          this.storage.kv.put('object:data:' + upload.key, entry);
          this.storage.kv.put('object:upload:' + upload.id, { ...upload, complete: true });
          this.quota();
          return this.publicObject(entry);
        });
      }
      case 'object.download': {
        const entry = this.storage.kv.get<ObjectEntry>('object:data:' + command.key);
        if (!entry) fail(404, 'object', 'Object does not exist.');
        const ticket = await signR2(this.env, this.env.PNEUMA_SPACE_OBJECT_BUCKET, entry.r2Key, 'GET');
        this.storage.transactionSync(() => this.guard(scope, 'object'));
        return { id: command.key, ...ticket };
      }
      case 'object.list': return this.storage.transactionSync(() => {
        this.guard(scope, 'object');
        const result = this.list<ObjectEntry>('object:data:', command);
        return { ...result, items: result.items.map(item => this.publicObject(item)) };
      });
      case 'object.delete': {
        const entry = this.storage.transactionSync(() => {
          this.guard(scope, 'object');
          const entry = this.storage.kv.get<ObjectEntry>('object:data:' + command.key);
          if (entry) {
            this.storage.kv.delete('object:data:' + command.key);
            this.storage.kv.put('object:garbage:' + entry.r2Key, entry);
          }
          return entry;
        });
        if (!entry) return { deleted: false };
        await bucket.delete(entry.r2Key);
        this.storage.transactionSync(() => { this.guard(scope, 'object'); this.storage.kv.delete('object:garbage:' + entry.r2Key); });
        return { deleted: true };
      }
      default: return fail(400, 'command', 'Unsupported object command.');
    }
  }
  private async cleanupObjects(scope: ExecutionScope | null): Promise<void> {
    const expired = Array.from(this.storage.kv.list<Upload>({ prefix: 'object:upload:' })).filter(([, upload]) => upload.expiresAt + 1000 <= Date.now());
    for (const [key, upload] of expired) {
      const current = this.storage.kv.get<ObjectEntry>('object:data:' + upload.key);
      if (current?.r2Key !== upload.r2Key) {
        this.storage.transactionSync(() => this.guard(scope, 'object'));
        await this.env.PNEUMA_SPACE_OBJECTS.delete(upload.r2Key);
      }
      this.storage.transactionSync(() => {
        this.guard(scope, 'object');
        this.storage.kv.delete(key);
        this.storage.kv.delete('object:garbage:' + upload.r2Key);
      });
    }
  }
  private publicObject(entry: ObjectEntry): Omit<ObjectEntry, 'r2Key'> {
    const { r2Key, ...metadata } = entry;
    return metadata;
  }
  private async rtc(scope: ExecutionScope | null): Promise<unknown> {
    this.storage.transactionSync(() => this.guard(scope, 'rtc'));
    if (!this.env.PNEUMA_SPACE_TURN_KEY_ID || !this.env.PNEUMA_SPACE_TURN_API_TOKEN) fail(503, 'unconfigured', 'TURN is not configured.');
    const response = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(this.env.PNEUMA_SPACE_TURN_KEY_ID) + '/credentials/generate-ice-servers', {
      method: 'POST', headers: { authorization: 'Bearer ' + this.env.PNEUMA_SPACE_TURN_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 600 }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { await response.body?.cancel(); fail(502, 'turn_provider', 'TURN provider refused credentials.'); }
    const data = record(JSON.parse(new TextDecoder().decode(await boundedBody(new Request('https://internal', { method: 'POST', body: response.body }), 32 * 1024))));
    if (!Array.isArray(data.iceServers) || !data.iceServers.length || data.iceServers.length > 10) fail(502, 'turn_provider', 'TURN provider returned invalid credentials.');
    const iceServers = data.iceServers.map(value => {
      const item = record(value);
      const urls = Array.isArray(item.urls) ? item.urls.map(url => text(url, 'TURN URL', 500)) : [text(item.urls, 'TURN URL', 500)];
      if (!urls.length || urls.some(url => !/^(?:stun|turn|turns):/.test(url))) fail(502, 'turn_provider', 'TURN provider returned invalid URLs.');
      return { urls, ...(item.username === undefined ? {} : { username: text(item.username, 'TURN username', 1000) }), ...(item.credential === undefined ? {} : { credential: text(item.credential, 'TURN credential', 1000) }) };
    });
    this.storage.transactionSync(() => this.guard(scope, 'rtc'));
    return { iceServers, expiresAt: Date.now() + 600000 };
  }
  inventory(): unknown {
    return this.storage.transactionSync(() => {
      const kv = Array.from(this.storage.kv.list<KvEntry>({ prefix: 'kv:' })).filter(([, entry]) => entry.expiresAt === null || entry.expiresAt > Date.now());
      const files = Array.from(this.storage.kv.list<FileEntry>({ prefix: 'file:' }));
      const objects = Array.from(this.storage.kv.list<ObjectEntry>({ prefix: 'object:data:' }));
      const tables = this.storage.sql.exec<{ name: string; type: string }>("SELECT name,type FROM sqlite_schema WHERE substr(lower(name),1,7) <> 'sqlite_' AND substr(lower(name),1,4) <> '_cf_' AND lower(name) <> '__cf_kv' AND type IN ('table','view') ORDER BY name").toArray();
      return { capabilities: Object.fromEntries(Array.from(this.providers, ([cap, provider]) => [cap, provider.inject()])), db: { tables, databaseBytes: this.storage.sql.databaseSize }, kv: { keys: kv.length, bytes: kv.reduce((sum, [, entry]) => sum + size(entry.value), 0) }, files: { count: files.length, bytes: files.reduce((sum, [, entry]) => sum + entry.bytes, 0) }, objects: { count: objects.length, bytes: objects.reduce((sum, [, entry]) => sum + entry.bytes, 0) }, storageBytes: this.bytes(), limitBytes: this.hooks.policy().storageBytes };
    });
  }
  async destroy(): Promise<{ retryAt: number | null }> {
    const retryAt = this.storage.transactionSync(() => {
      let retryAt = this.storage.kv.get<number>('resource:purging') ?? Date.now();
      for (const [, upload] of this.storage.kv.list<Upload>({ prefix: 'object:upload:' })) retryAt = Math.max(retryAt, upload.expiresAt + 1000);
      this.storage.kv.put('resource:purging', retryAt);
      return retryAt;
    });
    let cursor: string | undefined;
    do {
      const result = await this.env.PNEUMA_SPACE_OBJECTS.list({ prefix: 'apps/' + this.appId + '/objects/', limit: 1000, cursor });
      if (result.objects.length) await this.env.PNEUMA_SPACE_OBJECTS.delete(result.objects.map(object => object.key));
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
    if (retryAt > Date.now()) return { retryAt };
    this.storage.transactionSync(() => {
      const schema = this.storage.sql.exec<{ name: string; type: string }>("SELECT name,type FROM sqlite_schema WHERE substr(lower(name),1,7) <> 'sqlite_' AND substr(lower(name),1,4) <> '_cf_' AND lower(name) <> '__cf_kv' AND type IN ('table','view') ORDER BY type DESC").toArray();
      this.storage.sql.exec('PRAGMA defer_foreign_keys = ON');
      for (const { name, type } of schema) this.storage.sql.exec('DROP ' + (type === 'view' ? 'VIEW' : 'TABLE') + ' IF EXISTS "' + name.replaceAll('"', '""') + '"');
      for (const [key] of this.storage.kv.list()) if (key.startsWith('kv:') || key.startsWith('file:') || key.startsWith('object:')) this.storage.kv.delete(key);
      for (const provider of this.providers.values()) provider.destroy();
      this.storage.kv.delete('resource:state');
      this.storage.kv.delete('resource:revision');
    });
    return { retryAt: null };
  }
}
