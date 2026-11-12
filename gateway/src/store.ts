import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { DEFAULT_TENANT, QUOTA_RESOURCES, changeKey, type AppName, type Change, type Leadership, type Store, type StoreOps } from './model.ts';
import { SQLITE, SqlOps, wrap, type Row, type Session } from './sql.ts';

/** The migrated `default` tenant is unlimited (ADR 0022 item 4, ADR 0023 item 2). */
const UNLIMITED = JSON.stringify(Object.fromEntries(QUOTA_RESOURCES.map((resource) => [resource, null])));

/** Append only; `PRAGMA user_version` counts the steps applied. */
export const MIGRATIONS = [
  `CREATE TABLE app (
     name TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, status TEXT NOT NULL,
     current INTEGER, policy_override TEXT NOT NULL);
   CREATE TABLE release (
     app TEXT NOT NULL, number INTEGER NOT NULL, image TEXT, manifest TEXT NOT NULL, bundle TEXT,
     release_key TEXT NOT NULL, published_at INTEGER NOT NULL, PRIMARY KEY (app, number));
   CREATE TABLE trigger (app TEXT NOT NULL, name TEXT NOT NULL, schedule TEXT, PRIMARY KEY (app, name));
   CREATE TABLE binding (
     app TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, resource TEXT NOT NULL,
     PRIMARY KEY (app, kind, provider));
   CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
   CREATE TABLE token (id TEXT PRIMARY KEY, subject TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
   CREATE TABLE delivery (
     id TEXT PRIMARY KEY, app TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_for INTEGER, caller TEXT,
     idempotency_key TEXT, body BLOB NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL,
     next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE (app, trigger, scheduled_for));
   CREATE INDEX delivery_due ON delivery (state, next_attempt_at);
   CREATE INDEX delivery_key ON delivery (app, trigger, idempotency_key);
   CREATE TABLE stats (app TEXT PRIMARY KEY, requests INTEGER NOT NULL, errors INTEGER NOT NULL, last_access_at INTEGER);`,
  'ALTER TABLE app ADD COLUMN registered_at INTEGER NOT NULL DEFAULT 0',
  `ALTER TABLE release ADD COLUMN runtime TEXT;
   UPDATE release SET runtime = 'container' WHERE image IS NOT NULL;`,
  // M2 (ADR 0025 item 8): the tables PgStore creates in its step 1, and every M1 app and token in the default tenant.
  `CREATE TABLE tenant (name TEXT PRIMARY KEY, display TEXT NOT NULL, quota TEXT NOT NULL, created_at INTEGER NOT NULL);
   INSERT INTO tenant (name, display, quota, created_at)
     VALUES ('${DEFAULT_TENANT}', '${DEFAULT_TENANT}', '${UNLIMITED}', CAST(unixepoch('subsec') * 1000 AS INTEGER));
   CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, groups TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
   CREATE TABLE membership (
     tenant TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'member')), PRIMARY KEY (tenant, user_id));
   CREATE INDEX membership_user ON membership (user_id);
   ALTER TABLE app ADD COLUMN tenant TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}';
   ALTER TABLE app ADD COLUMN access TEXT NOT NULL DEFAULT 'org' CHECK (access IN ('tenant', 'org', 'public'));
   CREATE INDEX app_tenant ON app (tenant);
   ALTER TABLE token ADD COLUMN tenant TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}';
   ALTER TABLE token ADD COLUMN label TEXT NOT NULL DEFAULT '';
   ALTER TABLE token ADD COLUMN created_by TEXT NOT NULL DEFAULT 'local';
   ALTER TABLE token ADD COLUMN revoked_at INTEGER;
   UPDATE token SET label = substr(subject, length('service:') + 1);
   CREATE TABLE usage (
     app TEXT NOT NULL, tenant TEXT, step INTEGER NOT NULL, start INTEGER NOT NULL, replica TEXT NOT NULL,
     requests INTEGER NOT NULL, errors INTEGER NOT NULL, wakes INTEGER NOT NULL, wake_failures INTEGER NOT NULL, sleeps INTEGER NOT NULL,
     deliveries_done INTEGER NOT NULL, deliveries_failed INTEGER NOT NULL, deliveries_retried INTEGER NOT NULL,
     wake_ms INTEGER NOT NULL, awake_ms INTEGER NOT NULL, PRIMARY KEY (app, step, start, replica));
   CREATE INDEX usage_tenant ON usage (tenant, step, start);
   CREATE TABLE storage_usage (
     app TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, bytes INTEGER NOT NULL, measured_at INTEGER NOT NULL,
     PRIMARY KEY (app, kind, provider));
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, replica TEXT NOT NULL, ev TEXT NOT NULL, app TEXT, tenant TEXT, body TEXT NOT NULL);
   CREATE INDEX events_at ON events (at);
   CREATE TABLE instance_log (app TEXT PRIMARY KEY, release INTEGER NOT NULL, ended_at INTEGER NOT NULL, reason TEXT NOT NULL, tail TEXT NOT NULL);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, actor_tenant TEXT, tenant TEXT,
     action TEXT NOT NULL, target_kind TEXT NOT NULL, target TEXT NOT NULL, result TEXT NOT NULL, details TEXT NOT NULL);
   CREATE INDEX audit_tenant_at ON audit (tenant, at);
   CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
   CREATE TABLE replica (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, seen_at INTEGER NOT NULL);
   CREATE TABLE instance (
     app TEXT PRIMARY KEY, runtime TEXT NOT NULL, release INTEGER NOT NULL, spec_hash TEXT NOT NULL, epoch INTEGER NOT NULL,
     state TEXT NOT NULL, actor TEXT, handle TEXT, address TEXT, node TEXT, home TEXT, since INTEGER NOT NULL, awake_at INTEGER,
     cpu_millis INTEGER NOT NULL, memory_mb INTEGER NOT NULL);
   CREATE TABLE lease_tally (
     app TEXT NOT NULL, replica TEXT NOT NULL, epoch INTEGER NOT NULL, request INTEGER NOT NULL, channel INTEGER NOT NULL,
     trigger INTEGER NOT NULL, released_at INTEGER, PRIMARY KEY (app, replica));
   CREATE TABLE guard (
     app TEXT PRIMARY KEY, release INTEGER NOT NULL, failures TEXT NOT NULL, quarantine_reason TEXT, quarantined_at INTEGER);`,
  // ADR 0024 item 3: counts moved to usage. PgStore builds the final schema, so only SQLite drops columns.
  `ALTER TABLE stats DROP COLUMN requests;
   ALTER TABLE stats DROP COLUMN errors;`,
  // ADR 0020 as revised (step 6): the app's version for stale-view wakes, the delivery's claimer for conditional claims.
  `ALTER TABLE app ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE delivery ADD COLUMN replica TEXT;
   UPDATE tenant SET quota = '${UNLIMITED}' WHERE name = '${DEFAULT_TENANT}';`,
  // ADR 0023 item 4: storage counts provisioned capacity, never a measurement.
  'DROP TABLE storage_usage',
  // ADR 0026 item 2: the cluster view marks the leading gateway from its heartbeat.
  'ALTER TABLE replica ADD COLUMN leads INTEGER NOT NULL DEFAULT 0',
  `ALTER TABLE token ADD COLUMN restrictions TEXT;
   CREATE TABLE hosted_identity (
     provider TEXT NOT NULL, external_subject TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE,
     tenant TEXT NOT NULL UNIQUE, name TEXT NOT NULL, PRIMARY KEY (provider, external_subject));
   CREATE TABLE hosted_signup (id INTEGER PRIMARY KEY CHECK (id = 1), count INTEGER NOT NULL);
   INSERT INTO hosted_signup (id, count) VALUES (1, 0);
   CREATE TABLE hosted_auth (
     hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL);
   CREATE INDEX hosted_auth_user ON hosted_auth (user_id, created_at);
   CREATE INDEX hosted_auth_expiry ON hosted_auth (expires_at);`,
];

/** `$n` placeholders become `?n`, which node:sqlite binds by position. */
export const positional = (sql: string): string => sql.replace(/\$(\d+)/g, '?$1');

/** One connection; statements are prepared once. Writes record their change keys until the outermost commit hands them to `commit`. */
export class SqliteSession implements Session {
  readonly dialect = SQLITE;
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  readonly #pending = new Map<string, Change>();
  readonly #commit: (changes: Change[]) => void;

  constructor(db: DatabaseSync, commit: (changes: Change[]) => void = () => {}) {
    this.#db = db;
    this.#commit = commit;
  }

  readonly touched = (change: Change): void => {
    this.#pending.set(changeKey(change), change);
  };

  async all(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return this.#statement(sql).all(...(params as SQLInputValue[])) as Row[];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ readonly changes: number }> {
    return { changes: Number(this.#statement(sql).run(...(params as SQLInputValue[])).changes) };
  }

  async atomic<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#db.isTransaction) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      this.#db.exec('COMMIT');
      this.settle();
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      this.#pending.clear();
      throw error;
    }
  }

  /** Hands over what autocommitted writes touched; a no-op inside a transaction. */
  settle(): void {
    if (this.#pending.size === 0 || this.#db.isTransaction) return;
    const changes = [...this.#pending.values()];
    this.#pending.clear();
    this.#commit(changes);
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) this.#statements.set(sql, (statement = this.#db.prepare(positional(sql))));
    return statement;
  }
}

export interface SqliteStore extends StoreOps {}

/** Calls and transactions run one at a time in call order; node:sqlite is synchronous and in-process, so there is nothing to overlap. */
export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  readonly #session: SqliteSession;
  readonly #ops: SqlOps;
  readonly #inside = new AsyncLocalStorage<{ open: boolean }>();
  readonly #locks = new Map<AppName, Promise<unknown>>();
  readonly #changeListeners: ((change: Change) => void)[] = [];
  #tail: Promise<unknown> = Promise.resolve();

  constructor(path: string, { volumeGb = 1 }: { readonly volumeGb?: number } = {}) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const { user_version: applied } = this.#db.prepare('PRAGMA user_version').get() as { user_version: number };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS.slice(applied).forEach((step) => this.#db.exec(step));
      this.#db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    this.#session = new SqliteSession(this.#db, (changes) => this.#announce(changes));
    this.#ops = new SqlOps(this.#session, volumeGb);
    Object.assign(this, wrap(this.#ops, (work) => this.#queue(work)));
  }

  /** Closes after every queued call has run. */
  close(): Promise<void> {
    return this.#queue(async () => this.#db.close());
  }

  transaction<T>(fn: (tx: StoreOps) => Promise<T>): Promise<T> {
    return this.#queue(async () => {
      const state = { open: true };
      const tx = wrap(this.#ops, (work) => (state.open ? work() : Promise.reject(new Error('tx used after its transaction settled'))));
      try {
        return await this.#session.atomic(() => this.#inside.run(state, () => fn(tx)));
      } finally {
        state.open = false;
      }
    });
  }

  exclusive<T>(name: AppName, fn: () => Promise<T>): Promise<T> {
    const run = (this.#locks.get(name) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    this.#locks.set(name, tail);
    void tail.then(() => this.#locks.get(name) === tail && this.#locks.delete(name));
    return run;
  }

  onChange(listener: (change: Change) => void): void {
    this.#changeListeners.push(listener);
  }

  /** In-process announcements are never missed, so there is never a resync. */
  onResync(_listener: () => void): void {}

  /** One process owns the file, so it leads at once and never loses it (ADR 0020 item 7). */
  async leader(): Promise<Leadership> {
    let held = true;
    return { held: () => held, onLost: () => {}, release: async () => void (held = false) };
  }

  #announce(changes: readonly Change[]): void {
    for (const change of changes) {
      for (const listener of this.#changeListeners) {
        try {
          listener(change);
        } catch (error) {
          console.error(JSON.stringify({ ev: 'change-listener-failed', change: changeKey(change), error: (error as Error).message }));
        }
      }
    }
  }

  #queue<T>(work: () => Promise<T>): Promise<T> {
    if (this.#inside.getStore()?.open) {
      return Promise.reject(new Error('Store called inside its own transaction would wait for it forever; use the tx handle'));
    }
    const result = this.#tail.then(async () => {
      try {
        return await work();
      } finally {
        this.#session.settle();
      }
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
