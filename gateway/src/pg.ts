import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { connect as tcpConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export type Param = string | number | bigint | boolean | Uint8Array | null;
export type Value = string | number | boolean | Buffer | null;
export type Row = Record<string, Value>;
export type Result = { readonly command: string; readonly count: number; readonly rows: Row[] };
export type Notification = { readonly pid: number; readonly channel: string; readonly payload: string };
export type Isolation = 'read committed' | 'repeatable read' | 'serializable';
/** ReadyForQuery status: idle, in a transaction, in a failed transaction. */
export type TxStatus = 'I' | 'T' | 'E';
export type PgOptions = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /** false is sslmode=disable; an object is verify-full against `caFile`, or the system CAs without one. */
  readonly tls: false | { readonly caFile?: string };
  /** 0 turns it off; absent keeps the server's setting. */
  readonly statementTimeoutMs?: number;
};

export class PgError extends Error {
  readonly code: string;
  readonly severity: string;
  readonly detail: string | undefined;
  readonly constraint: string | undefined;

  constructor(fields: Map<string, string>) {
    super(fields.get('M') ?? 'unknown server error');
    this.name = 'PgError';
    this.code = fields.get('C') ?? '';
    this.severity = fields.get('V') ?? fields.get('S') ?? '';
    this.detail = fields.get('D');
    this.constraint = fields.get('n');
  }
}

/** The libpq URL subset `postgres://user:pass@host:port/db?sslmode=disable|verify-full&sslrootcert=<path>`. */
export function parsePgUrl(url: string): PgOptions {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error(`expected a postgres:// URL, got ${u.protocol}`);
  if (!u.hostname) throw new Error('the PostgreSQL URL names no host');
  let sslmode = 'verify-full';
  let caFile: string | undefined;
  for (const [key, value] of u.searchParams) {
    if (key === 'sslmode') sslmode = value;
    else if (key === 'sslrootcert') caFile = value;
    else throw new Error(`unsupported PostgreSQL URL parameter ${key}; supported: sslmode, sslrootcert`);
  }
  if (sslmode !== 'disable' && sslmode !== 'verify-full') throw new Error(`sslmode=${sslmode} is not supported; use disable or verify-full`);
  const user = decodeURIComponent(u.username);
  return {
    host: u.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: u.port ? Number(u.port) : 5432,
    user,
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)) || user,
    tls: sslmode === 'disable' ? false : caFile ? { caFile } : {},
  };
}

type Field = { readonly name: string; readonly oid: number };
type Handler = (type: string, body: Buffer) => void;

const OID = { bool: 16, bytea: 17, int8: 20, int2: 21, int4: 23, float4: 700, float8: 701 } as const;

function decode(oid: number, text: string): Value {
  switch (oid) {
    case OID.bool: return text === 't';
    case OID.int2: case OID.int4: case OID.int8: case OID.float4: case OID.float8: return Number(text);
    case OID.bytea: return Buffer.from(text.slice(2), 'hex');
    default: return text;
  }
}

function encode(value: Param): Buffer | null {
  if (value === null) return null;
  if (value instanceof Uint8Array) return Buffer.from(`\\x${Buffer.from(value).toString('hex')}`);
  if (typeof value === 'boolean') return Buffer.from(value ? 't' : 'f');
  return Buffer.from(String(value));
}

const int16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstr = (s: string) => Buffer.from(`${s}\0`);

function message(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type, 'latin1'), int32(body.length + 4), body]);
}

function cstrings(body: Buffer, from = 0): string[] {
  const out: string[] = [];
  for (let at = from; at < body.length;) {
    const end = body.indexOf(0, at);
    if (end < 0) break;
    out.push(body.toString('utf8', at, end));
    at = end + 1;
  }
  return out;
}

const errorFields = (body: Buffer) => new Map(cstrings(body).filter((s) => s.length > 0).map((s) => [s[0], s.slice(1)]));
const hmac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest();

const SASLPREP_MAPPED = /[ ­͏ ᠆᠋-᠍ -‍  ⁠　︀-️﻿]/;

function saslPassword(password: string): string {
  // SASLprep is the identity when NFKC is and nothing maps; where it would reject, the server also falls back to the raw password.
  if (password.normalize('NFKC') !== password || SASLPREP_MAPPED.test(password)) {
    throw new Error('the PostgreSQL password needs SASLprep mapping, which the gateway does not implement; choose one that NFKC leaves unchanged');
  }
  return password;
}

async function connectSocket(options: PgOptions): Promise<Socket> {
  const ca = options.tls && options.tls.caFile ? await readFile(options.tls.caFile) : undefined;
  const raw = tcpConnect({ host: options.host, port: options.port, noDelay: true, keepAlive: true, keepAliveInitialDelay: 60_000 });
  try {
    await once(raw, 'connect');
    if (!options.tls) return raw;
    raw.write(Buffer.concat([int32(8), int32(80877103)]));
    const [answer] = (await once(raw, 'data')) as [Buffer];
    if (answer.length !== 1 || answer[0] !== 0x53) throw new Error('the PostgreSQL server refused TLS');
    const secure = tlsConnect({ socket: raw, ca, host: options.host, servername: isIP(options.host) ? undefined : options.host });
    await once(secure, 'secureConnect');
    return secure;
  } catch (error) {
    raw.destroy();
    throw error;
  }
}
export class Session {
  /** Resolves with the reason once the session is gone; it never rejects. */
  readonly closed: Promise<Error>;
  readonly #options: PgOptions;
  readonly #socket: Socket;
  readonly #statements = new Map<string, string>();
  readonly #listeners = new Set<(n: Notification) => void>();
  #ended!: (error: Error) => void;
  #buffer = Buffer.alloc(0);
  #handler: Handler | null = null;
  #reject: ((e: Error) => void) | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #error: Error | null = null;
  #status: TxStatus = 'I';
  #pid = 0;
  #secret = Buffer.alloc(0);

  private constructor(options: PgOptions, socket: Socket) {
    this.#options = options;
    this.#socket = socket;
    this.closed = new Promise((resolve) => (this.#ended = resolve));
    socket.on('data', (chunk: Buffer) => this.#read(chunk));
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('PostgreSQL connection closed')));
  }

  static async open(options: PgOptions): Promise<Session> {
    const password = saslPassword(options.password);
    const session = new Session(options, await connectSocket(options));
    try {
      await session.#startup(password);
    } catch (error) {
      session.#socket.destroy();
      throw error;
    }
    return session;
  }

  get alive(): boolean {
    return this.#error === null;
  }

  get status(): TxStatus {
    return this.#status;
  }

  get pid(): number {
    return this.#pid;
  }
  query(sql: string, params: readonly Param[] = []): Promise<Result> {
    return this.#serial(async () => {
      try {
        return await this.#extended(sql, params, false);
      } catch (error) {
        if (!(error instanceof PgError && error.code === '0A000' && this.#status === 'I')) throw error;
        return this.#extended(sql, params, true);
      }
    });
  }
  simple(sql: string): Promise<Result[]> {
    return this.#serial(() => this.#run(message('Q', cstr(sql))));
  }

  onNotification(listener: (n: Notification) => void): void {
    this.#listeners.add(listener);
  }
  async cancel(): Promise<void> {
    const socket = await connectSocket(this.#options);
    socket.end(Buffer.concat([int32(12 + this.#secret.length), int32(80877102), int32(this.#pid), this.#secret]));
    await once(socket, 'close');
  }

  async close(): Promise<void> {
    if (this.#error === null) this.#socket.end(message('X'));
    await this.closed;
  }

  #startup(password: string): Promise<void> {
    const params: Record<string, string> = { user: this.#options.user, database: this.#options.database, client_encoding: 'UTF8', application_name: 'pneuma-space' };
    if (this.#options.statementTimeoutMs !== undefined) params.options = `-c statement_timeout=${this.#options.statementTimeoutMs}`;
    const body = Buffer.concat([int32(196608), ...Object.entries(params).flatMap(([k, v]) => [cstr(k), cstr(v)]), Buffer.from([0])]);
    return this.#exchange(Buffer.concat([int32(body.length + 4), body]), (resolve, reject) => {
      const nonce = randomBytes(18).toString('base64');
      const clientFirstBare = `n=,r=${nonce}`;
      let expectedServerSignature: Buffer | null = null;
      return (type, msg) => {
        if (type === 'E') return reject(new PgError(errorFields(msg)));
        if (type === 'Z') return resolve();
        if (type !== 'R') return;
        const code = msg.readInt32BE(0);
        if (code === 0) return;
        if (code === 10) {
          if (!cstrings(msg, 4).includes('SCRAM-SHA-256')) return reject(new Error('the PostgreSQL server offers no SCRAM-SHA-256'));
          const first = Buffer.from(`n,,${clientFirstBare}`);
          this.#socket.write(message('p', cstr('SCRAM-SHA-256'), int32(first.length), first));
          return;
        }
        if (code === 11) {
          const serverFirst = msg.toString('utf8', 4);
          const attrs = new Map(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
          const serverNonce = attrs.get('r') ?? '';
          if (!serverNonce.startsWith(nonce)) return reject(new Error('SCRAM nonce mismatch'));
          pbkdf2(password, Buffer.from(attrs.get('s') ?? '', 'base64'), Number(attrs.get('i')), 32, 'sha256', (error, salted) => {
            if (error) return reject(error);
            const clientFinalBare = `c=biws,r=${serverNonce}`;
            const auth = `${clientFirstBare},${serverFirst},${clientFinalBare}`;
            const clientKey = hmac(salted, 'Client Key');
            const signature = hmac(createHash('sha256').update(clientKey).digest(), auth);
            const proof = Buffer.from(clientKey.map((byte, i) => byte ^ signature[i])).toString('base64');
            expectedServerSignature = hmac(hmac(salted, 'Server Key'), auth);
            this.#socket.write(message('p', Buffer.from(`${clientFinalBare},p=${proof}`)));
          });
          return;
        }
        if (code === 12) {
          const v = Buffer.from(msg.toString('utf8', 4).replace(/^v=/, ''), 'base64');
          if (!expectedServerSignature || v.length !== 32 || !timingSafeEqual(v, expectedServerSignature)) {
            return reject(new Error('SCRAM server signature mismatch'));
          }
          return;
        }
        reject(new Error(`PostgreSQL asked for authentication method ${code}; the gateway speaks SCRAM-SHA-256 only`));
      };
    });
  }

  async #extended(sql: string, params: readonly Param[], reparse: boolean): Promise<Result> {
    const cached = this.#statements.get(sql);
    const name = cached ?? `s${this.#statements.size}`;
    const values = params.map(encode);
    const out = [
      ...(reparse ? [message('C', Buffer.from('S'), cstr(name))] : []),
      ...(reparse || cached === undefined ? [message('P', cstr(name), cstr(sql), int16(0))] : []),
      message('B', cstr(''), cstr(name), int16(0), int16(values.length),
        ...values.flatMap((v) => (v === null ? [int32(-1)] : [int32(v.length), v])), int16(0)),
      message('D', Buffer.from('P'), cstr('')),
      message('E', cstr(''), int32(0)),
      message('S'),
    ];
    const [result] = await this.#run(Buffer.concat(out), () => this.#statements.set(sql, name));
    return result;
  }

  #run(out: Buffer, parsed?: () => void): Promise<Result[]> {
    return this.#exchange(out, (resolve, reject) => {
      const results: Result[] = [];
      let fields: Field[] = [];
      let rows: Row[] = [];
      let error: PgError | null = null;
      return (type, body) => {
        switch (type) {
          case '1': return parsed?.();
          case 'T': {
            fields = [];
            for (let i = 0, at = 2; i < body.readInt16BE(0); i++) {
              const end = body.indexOf(0, at);
              fields.push({ name: body.toString('utf8', at, end), oid: body.readInt32BE(end + 7) });
              at = end + 19;
            }
            return;
          }
          case 'D': {
            const row: Row = {};
            for (let i = 0, at = 2; i < fields.length; i++) {
              const length = body.readInt32BE(at);
              at += 4;
              row[fields[i].name] = length < 0 ? null : decode(fields[i].oid, body.toString('utf8', at, (at += length)));
            }
            rows.push(row);
            return;
          }
          case 'C': {
            const command = body.toString('utf8', 0, body.length - 1);
            const count = Number(command.slice(command.lastIndexOf(' ') + 1));
            results.push({ command, count: Number.isInteger(count) ? count : 0, rows });
            rows = [];
            fields = [];
            return;
          }
          case 'I': results.push({ command: '', count: 0, rows: [] }); return;
          case 'E': error ??= new PgError(errorFields(body)); return;
          case 'Z': return error ? reject(error) : resolve(results);
        }
      };
    });
  }

  #exchange<T>(out: Buffer, start: (resolve: (v: T) => void, reject: (e: Error) => void) => Handler): Promise<T> {
    if (this.#error) return Promise.reject(this.#error);
    return new Promise<T>((resolve, reject) => {
      const done = (fn: () => void) => { this.#handler = null; this.#reject = null; fn(); };
      this.#reject = (e) => done(() => reject(e));
      this.#handler = start((v) => done(() => resolve(v)), this.#reject);
      this.#socket.write(out);
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #read(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    while (this.#buffer.length >= 5) {
      const length = this.#buffer.readInt32BE(1);
      if (this.#buffer.length < length + 1) return;
      const type = String.fromCharCode(this.#buffer[0]);
      const body = this.#buffer.subarray(5, length + 1);
      this.#buffer = this.#buffer.subarray(length + 1);
      if (type === 'A') {
        const [channel, payload] = cstrings(body, 4);
        for (const listener of this.#listeners) listener({ pid: body.readInt32BE(0), channel, payload });
      } else if (type === 'K') {
        this.#pid = body.readInt32BE(0);
        this.#secret = Buffer.from(body.subarray(4));
      } else if (type !== 'N' && type !== 'S') {
        if (type === 'Z') this.#status = body.toString('latin1', 0, 1) as TxStatus;
        this.#handler?.(type, body);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#error) return;
    this.#error = error;
    this.#socket.destroy();
    this.#reject?.(error);
    this.#ended(error);
  }
}

type Waiter = { readonly resolve: (s: Session) => void; readonly reject: (e: Error) => void; readonly timer: NodeJS.Timeout };
export class Pool {
  readonly #options: PgOptions;
  readonly #size: number;
  readonly #waitMs: number;
  readonly #idle: Session[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #closing: Promise<void>[] = [];
  #opened = 0;
  #drained: (() => void) | null = null;
  #closed: Promise<void> | null = null;

  constructor(options: PgOptions, size: number, waitMs = 10_000) {
    this.#options = options;
    this.#size = size;
    this.#waitMs = waitMs;
  }

  query(sql: string, params: readonly Param[] = []): Promise<Result> {
    return this.with((s) => s.query(sql, params));
  }

  simple(sql: string): Promise<Result[]> {
    return this.with((s) => s.simple(sql));
  }
  transaction<T>(fn: (s: Session) => Promise<T>, isolation?: Isolation): Promise<T> {
    return this.with(async (s) => {
      await s.simple(isolation ? `BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}` : 'BEGIN');
      try {
        const result = await fn(s);
        const [commit] = await s.simple('COMMIT');
        // COMMIT of a transaction that already failed answers ROLLBACK, not an error.
        if (commit.command === 'ROLLBACK') throw new Error('the transaction had failed; COMMIT rolled it back');
        return result;
      } catch (error) {
        if (s.alive && s.status !== 'I') await s.simple('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async with<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    const session = await this.#acquire();
    try {
      return await fn(session);
    } finally {
      this.#release(session);
    }
  }
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = new Promise((resolve) => (this.#drained = resolve));
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('the PostgreSQL pool is closed'));
      }
      for (const session of this.#idle.splice(0)) this.#drop(session);
      this.#settle();
    }
    return this.#closed;
  }

  #acquire(): Promise<Session> {
    if (this.#closed) return Promise.reject(new Error('the PostgreSQL pool is closed'));
    for (let s = this.#idle.pop(); s; s = this.#idle.pop()) {
      if (s.alive) return Promise.resolve(s);
      this.#opened--;
    }
    if (this.#opened < this.#size) return this.#open();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          reject(new Error(`no PostgreSQL session came free within ${this.#waitMs} ms`));
        }, this.#waitMs),
      };
      this.#waiters.push(waiter);
    });
  }

  async #open(): Promise<Session> {
    this.#opened++;
    try {
      return await Session.open(this.#options);
    } catch (error) {
      this.#opened--;
      this.#handoff();
      throw error;
    }
  }

  #release(session: Session): void {
    if (this.#closed || !session.alive || session.status !== 'I') return this.#drop(session);
    const waiter = this.#waiters.shift();
    if (!waiter) return void this.#idle.push(session);
    clearTimeout(waiter.timer);
    waiter.resolve(session);
  }

  #drop(session: Session): void {
    this.#opened--;
    const closing = session.close();
    if (this.#closed) this.#closing.push(closing);
    this.#handoff();
  }

  #handoff(): void {
    if (this.#closed) return this.#settle();
    if (this.#waiters.length === 0 || this.#opened >= this.#size) return;
    const waiter = this.#waiters.shift()!;
    clearTimeout(waiter.timer);
    this.#open().then(waiter.resolve, waiter.reject);
  }

  #settle(): void {
    if (this.#opened === 0) void Promise.all(this.#closing).then(() => this.#drained?.());
  }
}
