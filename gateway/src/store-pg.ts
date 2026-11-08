import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_TENANT, QUOTA_RESOURCES, parseChange, type AppName, type Change, type Leadership, type Store, type StoreOps } from './model.ts';
import { parsePgUrl, PgError, Pool, Session, type Param, type PgOptions, type Result } from './pg.ts';
import { POSTGRES, STORE_OPS, SqlOps, wrap, type Row, type Session as SqlSession } from './sql.ts';

const CHANNEL = 'pneuma_space';
const POOL_SIZE = 8;
const RETRIES = 5;
const PROBE_MS = 2000;
const PROBE_TIMEOUT_MS = 3000;
const RECONNECT_MS = 1000;
/** Serialization failure and deadlock: `fn` runs again (ADR 0025 item 3). */
const RETRYABLE = new Set(['40001', '40P01']);
/** Advisory lock classes: migrations, commands by name, leadership. */
const LOCK = { migrate: 0, command: 1, leader: 2 } as const;

const UNLIMITED = JSON.stringify(Object.fromEntries(QUOTA_RESOURCES.map((resource) => [resource, null])));
const changed = (table: string) => `CREATE TRIGGER ${table}_changed AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION pneuma_space_changed();`;

/** Append only; `schema_migration` records the steps applied. Step 1 is the whole M2 schema (ADR 0025 item 8). */
export const PG_MIGRATIONS = [
  `CREATE TABLE app (
     name TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
     access TEXT NOT NULL DEFAULT 'org' CHECK (access IN ('tenant', 'org', 'public')), owner TEXT NOT NULL, status TEXT NOT NULL,
     current BIGINT, policy_override TEXT NOT NULL, registered_at BIGINT NOT NULL DEFAULT 0, version BIGINT NOT NULL DEFAULT 0);
   CREATE INDEX app_tenant ON app (tenant);
   CREATE TABLE release (
     app TEXT NOT NULL, number BIGINT NOT NULL, image TEXT, manifest TEXT NOT NULL, bundle TEXT, runtime TEXT,
     release_key TEXT NOT NULL, published_at BIGINT NOT NULL, PRIMARY KEY (app, number));
   CREATE TABLE trigger (app TEXT NOT NULL, name TEXT NOT NULL, schedule TEXT, PRIMARY KEY (app, name));
   CREATE TABLE binding (
     app TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, resource TEXT NOT NULL,
     PRIMARY KEY (app, kind, provider));
   CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
   CREATE TABLE token (
     id TEXT PRIMARY KEY, tenant TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}', subject TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
     hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL DEFAULT 'local', created_at BIGINT NOT NULL, revoked_at BIGINT);
   CREATE TABLE delivery (
     id TEXT PRIMARY KEY, app TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_for BIGINT, caller TEXT, idempotency_key TEXT,
     body BYTEA NOT NULL, state TEXT NOT NULL, attempts BIGINT NOT NULL, next_attempt_at BIGINT NOT NULL, created_at BIGINT NOT NULL,
     replica TEXT, UNIQUE (app, trigger, scheduled_for));
   CREATE INDEX delivery_due ON delivery (state, next_attempt_at);
   CREATE INDEX delivery_key ON delivery (app, trigger, idempotency_key);
   CREATE TABLE stats (app TEXT PRIMARY KEY, last_access_at BIGINT);
   CREATE TABLE tenant (name TEXT PRIMARY KEY, display TEXT NOT NULL, quota TEXT NOT NULL, created_at BIGINT NOT NULL);
   INSERT INTO tenant (name, display, quota, created_at) VALUES ('${DEFAULT_TENANT}', '${DEFAULT_TENANT}', '${UNLIMITED}', ${POSTGRES.now});
   CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, groups TEXT NOT NULL, first_seen BIGINT NOT NULL, last_seen BIGINT NOT NULL);
   CREATE TABLE membership (
     tenant TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'member')), PRIMARY KEY (tenant, user_id));
   CREATE INDEX membership_user ON membership (user_id);
   CREATE TABLE usage (
     app TEXT NOT NULL, tenant TEXT, step BIGINT NOT NULL, start BIGINT NOT NULL, replica TEXT NOT NULL,
     requests BIGINT NOT NULL, errors BIGINT NOT NULL, wakes BIGINT NOT NULL, wake_failures BIGINT NOT NULL, sleeps BIGINT NOT NULL,
     deliveries_done BIGINT NOT NULL, deliveries_failed BIGINT NOT NULL, deliveries_retried BIGINT NOT NULL,
     wake_ms BIGINT NOT NULL, awake_ms BIGINT NOT NULL, PRIMARY KEY (app, step, start, replica));
   CREATE INDEX usage_tenant ON usage (tenant, step, start);
   CREATE TABLE storage_usage (
     app TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, bytes BIGINT NOT NULL, measured_at BIGINT NOT NULL,
     PRIMARY KEY (app, kind, provider));
   CREATE TABLE events (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at BIGINT NOT NULL, replica TEXT NOT NULL, ev TEXT NOT NULL,
     app TEXT, tenant TEXT, body TEXT NOT NULL);
   CREATE INDEX events_at ON events (at);
   CREATE TABLE instance_log (app TEXT PRIMARY KEY, release BIGINT NOT NULL, ended_at BIGINT NOT NULL, reason TEXT NOT NULL, tail TEXT NOT NULL);
   CREATE TABLE audit (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at BIGINT NOT NULL, actor TEXT NOT NULL, actor_tenant TEXT, tenant TEXT,
     action TEXT NOT NULL, target_kind TEXT NOT NULL, target TEXT NOT NULL, result TEXT NOT NULL, details TEXT NOT NULL);
   CREATE INDEX audit_tenant_at ON audit (tenant, at);
   CREATE TABLE replica (id TEXT PRIMARY KEY, started_at BIGINT NOT NULL, seen_at BIGINT NOT NULL);
   CREATE TABLE instance (
     app TEXT PRIMARY KEY, runtime TEXT NOT NULL, release BIGINT NOT NULL, spec_hash TEXT NOT NULL, epoch BIGINT NOT NULL,
     state TEXT NOT NULL, actor TEXT, handle TEXT, address TEXT, node TEXT, home TEXT, since BIGINT NOT NULL, awake_at BIGINT,
     cpu_millis BIGINT NOT NULL, memory_mb BIGINT NOT NULL);
   CREATE TABLE lease_tally (
     app TEXT NOT NULL, replica TEXT NOT NULL, epoch BIGINT NOT NULL, request BIGINT NOT NULL, channel BIGINT NOT NULL,
     trigger BIGINT NOT NULL, released_at BIGINT, PRIMARY KEY (app, replica));
   CREATE TABLE guard (
     app TEXT PRIMARY KEY, release BIGINT NOT NULL, failures TEXT NOT NULL, quarantine_reason TEXT, quarantined_at BIGINT);
   CREATE FUNCTION pneuma_space_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'audit is append-only'; END $$;
   CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION pneuma_space_append_only();
   CREATE FUNCTION pneuma_space_changed() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     r RECORD;
     app_name TEXT;
   BEGIN
     IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
     CASE TG_TABLE_NAME
       WHEN 'policy' THEN PERFORM pg_notify('${CHANNEL}', 'policy');
       WHEN 'instance', 'guard' THEN PERFORM pg_notify('${CHANNEL}', 'instance/' || r.app);
       WHEN 'tenant' THEN PERFORM pg_notify('${CHANNEL}', 'tenant/' || r.name);
       WHEN 'membership', 'token' THEN PERFORM pg_notify('${CHANNEL}', 'tenant/' || r.tenant);
       WHEN 'app' THEN PERFORM pg_notify('${CHANNEL}', 'app/' || r.name);
       ELSE
         SELECT a.name INTO app_name FROM app a WHERE a.id = r.app;
         IF app_name IS NOT NULL THEN PERFORM pg_notify('${CHANNEL}', 'app/' || app_name); END IF;
     END CASE;
     RETURN NULL;
   END $$;
   ${['app', 'release', 'trigger', 'binding', 'policy', 'instance', 'guard', 'tenant', 'membership', 'token'].map(changed).join('\n   ')}`,
];

/** Runs every step not yet recorded, each in its own transaction, under a lock so replicas that start together migrate once. */
async function migrate(options: PgOptions): Promise<void> {
  const session = await Session.open({ ...options, statementTimeoutMs: 0 });
  try {
    await session.query(`SELECT pg_advisory_lock(${LOCK.migrate}, 0)`);
    await session.simple('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
    const { rows } = await session.query('SELECT coalesce(max(version), 0) AS applied FROM schema_migration');
    for (let step = Number(rows[0].applied); step < PG_MIGRATIONS.length; step++) {
      await session.simple(`BEGIN; ${PG_MIGRATIONS[step]};
        INSERT INTO schema_migration (version, applied_at) VALUES (${step + 1}, ${POSTGRES.now}); COMMIT;`);
    }
  } finally {
    await session.close();
  }
}

type Conn = { query(sql: string, params?: readonly Param[]): Promise<Result> };
type Begin = <T>(fn: (session: Session) => Promise<T>) => Promise<T>;

/** sql.ts's view of one call: autocommit statements on `base`, and `atomic` moves them onto one transaction's session. */
class PgSql implements SqlSession {
  readonly dialect = POSTGRES;
  readonly #base: Conn;
  readonly #begin: Begin;
  #tx: Session | null;

  constructor(base: Conn, begin: Begin, tx: Session | null = null) {
    this.#base = base;
    this.#begin = begin;
    this.#tx = tx;
  }

  async all(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return (await (this.#tx ?? this.#base).query(sql, params as Param[])).rows;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ readonly changes: number }> {
    return { changes: (await (this.#tx ?? this.#base).query(sql, params as Param[])).count };
  }

  atomic<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#tx) return fn();
    return this.#begin(async (session) => {
      this.#tx = session;
      try {
        return await fn();
      } finally {
        this.#tx = null;
      }
    });
  }
}

/** A command's own session; its calls and transactions take turns on it (ADR 0025 item 4). */
type Command = { readonly session: Session; open: boolean; tail: Promise<unknown> };
type Context = { readonly command?: Command; readonly tx?: { open: boolean } };

class Tenure implements Leadership {
  readonly session: Session;
  readonly #listeners: (() => void)[] = [];
  #held = true;

  constructor(session: Session) {
    this.session = session;
  }

  held(): boolean {
    return this.#held;
  }

  onLost(listener: () => void): void {
    this.#listeners.push(listener);
  }

  lose(): void {
    if (!this.#held) return;
    this.#held = false;
    for (const listener of this.#listeners) listener();
  }

  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    await this.session.query(`SELECT pg_advisory_unlock(${LOCK.leader}, 0)`).catch(() => undefined);
  }
}

export type PgStoreOptions = {
  /** Commands in flight at once, each on its own session (`PNEUMA_SPACE_STORE_COMMANDS`). */
  readonly commands?: number;
  /** Provisioned size of one files or SQLite binding in GiB, what `storage_gb` counts (ADR 0023 item 4). */
  readonly volumeGb?: number;
  /** Fails every transaction's first commit once, so a `fn` that is not safe to rerun shows (`PNEUMA_SPACE_STORE_TEST_RETRY=1`). */
  readonly testRetry?: boolean;
};

export interface PgStore extends StoreOps {}

/**
 * The platform library on PostgreSQL (ADR 0025): a pool of 8 for calls and transactions, one session per running command,
 * and one dedicated session that listens for changes and holds the leader lock.
 */
export class PgStore implements Store {
  readonly #volumeGb: number;
  #retries = 0;
  readonly #options: PgOptions;
  readonly #pool: Pool;
  readonly #commands: number;
  readonly #testRetry: boolean;
  readonly #context = new AsyncLocalStorage<Context>();
  readonly #names = new Map<AppName, Promise<unknown>>();
  readonly #slots: (() => void)[] = [];
  readonly #changeListeners: ((change: Change) => void)[] = [];
  readonly #resyncListeners: (() => void)[] = [];
  #running = 0;
  #listen: Session | null = null;
  #tenure: Tenure | null = null;
  #asking: Promise<Leadership | null> | null = null;
  #probe: NodeJS.Timeout | null = null;
  #closed = false;

  private constructor(options: PgOptions, { commands = 4, testRetry = false, volumeGb = 1 }: PgStoreOptions) {
    this.#volumeGb = volumeGb;
    this.#options = options;
    this.#pool = new Pool(options, POOL_SIZE);
    this.#commands = commands;
    this.#testRetry = testRetry;
    Object.assign(this, Object.fromEntries(STORE_OPS.map((name) => [name, (...args: unknown[]) => this.#call((ops) => (ops[name] as (...a: unknown[]) => Promise<unknown>)(...args))])));
  }

  /** Transactions rerun after a serialization failure or deadlock. */
  get retries(): number {
    return this.#retries;
  }

  /** `url` is the libpq subset `parsePgUrl` reads; migrates before it resolves. */
  static async open(url: string, options: PgStoreOptions = {}): Promise<PgStore> {
    const pg = parsePgUrl(url);
    await migrate(pg);
    const store = new PgStore(pg, options);
    await store.#connect();
    store.#probe = setInterval(() => void store.#check(), PROBE_MS).unref();
    return store;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#probe) clearInterval(this.#probe);
    await this.#tenure?.release();
    await Promise.all([this.#listen?.close(), this.#pool.close()]);
  }

  transaction<T>(fn: (tx: StoreOps) => Promise<T>): Promise<T> {
    return this.#enter((context, begin) => begin(async (session) => {
      const state = { open: true };
      const ops = new SqlOps(new PgSql(session, (f) => f(session), session), this.#volumeGb);
      const tx = wrap(ops, (work) => (state.open ? work() : Promise.reject(new Error('tx used after its transaction settled'))));
      try {
        return await this.#context.run({ ...context, tx: state }, () => fn(tx));
      } finally {
        state.open = false;
      }
    }));
  }

  exclusive<T>(name: AppName, fn: () => Promise<T>): Promise<T> {
    const run = (this.#names.get(name) ?? Promise.resolve()).then(() => this.#command(name, fn));
    const tail = run.catch(() => undefined);
    this.#names.set(name, tail);
    void tail.then(() => this.#names.get(name) === tail && this.#names.delete(name));
    return run;
  }

  onChange(listener: (change: Change) => void): void {
    this.#changeListeners.push(listener);
  }

  onResync(listener: () => void): void {
    this.#resyncListeners.push(listener);
  }

  leader(): Promise<Leadership | null> {
    if (this.#tenure?.held()) return Promise.resolve(this.#tenure);
    // One ask at a time: the lock is re-entrant, so a second success would count twice.
    this.#asking ??= this.#ask().finally(() => (this.#asking = null));
    return this.#asking;
  }

  async #ask(): Promise<Leadership | null> {
    const session = this.#listen;
    if (!session) return null;
    const { rows } = await session.query(`SELECT pg_try_advisory_lock(${LOCK.leader}, 0) AS held`);
    if (!rows[0].held || this.#listen !== session) return null;
    return (this.#tenure = new Tenure(session));
  }

  #call<T>(work: (ops: StoreOps) => Promise<T>): Promise<T> {
    return this.#enter((_, begin, base) => work(new SqlOps(new PgSql(base, begin), this.#volumeGb)));
  }

  /** Runs on the current command's session, one call at a time, or on the pool; `begin` opens a serializable transaction there. */
  #enter<T>(work: (context: Context, begin: Begin, base: Conn) => Promise<T>): Promise<T> {
    const context = this.#context.getStore() ?? {};
    if (context.tx?.open) return Promise.reject(new Error('Store called inside its own transaction; use the tx handle'));
    const command = context.command?.open ? context.command : undefined;
    if (!command) return work(context, (fn) => this.#serializable((w) => this.#pool.with(w), fn), this.#pool);
    const result = command.tail.then(() => work(context, (fn) => this.#serializable((w) => w(command.session), fn), command.session));
    command.tail = result.catch(() => undefined);
    return result;
  }

  async #serializable<T>(on: Begin, fn: (session: Session) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await on(async (session) => {
          await session.simple('BEGIN ISOLATION LEVEL SERIALIZABLE');
          try {
            const result = await fn(session);
            if (this.#testRetry && attempt === 0) throw new PgError(new Map([['C', '40001'], ['M', 'test mode: the first commit fails']]));
            const [commit] = await session.simple('COMMIT');
            if (commit.command === 'ROLLBACK') throw new Error('the transaction had failed; COMMIT rolled it back');
            return result;
          } catch (error) {
            if (session.alive && session.status !== 'I') await session.simple('ROLLBACK').catch(() => undefined);
            throw error;
          }
        });
      } catch (error) {
        if (!(error instanceof PgError && RETRYABLE.has(error.code)) || attempt >= RETRIES) throw error;
        this.#retries++;
      }
    }
  }

  async #command<T>(name: AppName, fn: () => Promise<T>): Promise<T> {
    if (this.#running < this.#commands) this.#running++;
    else await new Promise<void>((resolve) => this.#slots.push(resolve));
    try {
      const session = await Session.open({ ...this.#options, statementTimeoutMs: 0 });
      const command: Command = { session, open: true, tail: Promise.resolve() };
      try {
        await session.query(`SELECT pg_advisory_lock(${LOCK.command}, hashtext($1))`, [name]);
        return await this.#context.run({ command }, fn);
      } finally {
        command.open = false;
        await command.tail;
        // Closing releases the lock.
        await session.close();
      }
    } finally {
      const next = this.#slots.shift();
      if (next) next();
      else this.#running--;
    }
  }

  async #connect(): Promise<void> {
    const session = await Session.open({ ...this.#options, statementTimeoutMs: 0 });
    await session.simple(`SET tcp_keepalives_idle = 10; SET tcp_keepalives_interval = 5; SET tcp_keepalives_count = 3; LISTEN ${CHANNEL}`)
      .catch(async (error) => {
        await session.close();
        throw error;
      });
    session.onNotification((n) => {
      if (n.channel === CHANNEL && this.#listen === session) this.#notice(n.payload);
    });
    this.#listen = session;
    void session.closed.then(() => this.#lost(session));
  }

  /** A failed or slow probe ends the session, and with it the tenure, before the server notices (ADR 0020 item 4). */
  async #check(): Promise<void> {
    const session = this.#listen;
    if (!session) return;
    const timeout = sleep(PROBE_TIMEOUT_MS, 'timeout', { ref: false });
    const answer = await Promise.race([session.query('SELECT 1').then(() => 'ok', () => 'failed'), timeout]);
    if (answer !== 'ok') this.#lost(session);
  }

  /** Changes announced while no session listened are gone, so every listener re-reads once a new one listens. */
  #lost(session: Session): void {
    if (this.#listen !== session) return;
    this.#listen = null;
    void session.close();
    if (this.#tenure?.session === session) this.#tenure.lose();
    void (async () => {
      while (!this.#closed && !this.#listen) {
        await sleep(RECONNECT_MS);
        if (this.#closed) return;
        try {
          await this.#connect();
        } catch (error) {
          console.error(JSON.stringify({ ev: 'store-listen-failed', error: (error as Error).message }));
        }
      }
      if (this.#closed) return;
      for (const listener of this.#resyncListeners) this.#safely('resync', listener);
    })();
  }

  #notice(payload: string): void {
    const change = parseChange(payload);
    if (!change) return;
    for (const listener of this.#changeListeners) this.#safely(payload, () => listener(change));
  }

  #safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      console.error(JSON.stringify({ ev: 'change-listener-failed', change: what, error: (error as Error).message }));
    }
  }
}
