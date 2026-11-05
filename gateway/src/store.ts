import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  DEFAULT_POLICY, IDEMPOTENCY_WINDOW_MS,
  type App, type AppId, type AppName, type Binding, type Delivery, type DeliveryFilter, type Policy,
  type Release, type ReleaseNumber, type Stats, type Store, type StoreOps, type Token, type Trigger, type TriggerName,
} from './model.ts';

/** Append only; `PRAGMA user_version` counts the steps applied. */
const MIGRATIONS = [
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
];

type Row = Record<string, SQLInputValue>;

const toApp = (r: Row): App => ({
  name: r.name as AppName,
  id: r.id as AppId,
  owner: r.owner as App['owner'],
  status: r.status as App['status'],
  current: r.current as ReleaseNumber | null,
  policyOverride: JSON.parse(r.policy_override as string),
  registeredAt: r.registered_at as number,
});

const toRelease = (r: Row): Release => ({
  app: r.app as AppId,
  number: r.number as ReleaseNumber,
  image: r.image as Release['image'],
  manifest: JSON.parse(r.manifest as string),
  bundle: r.bundle as Release['bundle'],
  releaseKey: r.release_key as string,
  publishedAt: r.published_at as number,
});

const toBinding = (r: Row): Binding => ({
  app: r.app as AppId,
  kind: r.kind as Binding['kind'],
  provider: r.provider as Binding['provider'],
  state: r.state as Binding['state'],
  resource: JSON.parse(r.resource as string),
});

const toDelivery = (r: Row): Delivery => ({
  id: r.id as Delivery['id'],
  app: r.app as AppId,
  trigger: r.trigger as TriggerName,
  scheduledFor: r.scheduled_for as number | null,
  caller: r.caller as Delivery['caller'],
  idempotencyKey: r.idempotency_key as string | null,
  body: r.body as Uint8Array,
  state: r.state as Delivery['state'],
  attempts: r.attempts as number,
  nextAttemptAt: r.next_attempt_at as number,
  createdAt: r.created_at as number,
});

const toStats = (r: Row): Stats => ({
  app: r.app as AppId,
  requests: r.requests as number,
  errors: r.errors as number,
  lastAccessAt: r.last_access_at as number | null,
});

type Sync<T> = { [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never };

/** Every method runs synchronously, inside the open transaction if there is one. */
class Statements implements Sync<StoreOps> {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Joins the open transaction or runs `fn` in its own. */
  atomic<T>(fn: () => T): T {
    if (this.#db.isTransaction) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) this.#statements.set(sql, (statement = this.#db.prepare(sql)));
    return statement;
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#statement(sql).get(...params) as Row | undefined;
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#statement(sql).all(...params) as Row[];
  }

  #run(sql: string, ...params: SQLInputValue[]): void {
    this.#statement(sql).run(...params);
  }

  app(name: AppName): App | null {
    const row = this.#get('SELECT * FROM app WHERE name = ?', name);
    return row ? toApp(row) : null;
  }

  apps(): App[] {
    return this.#all('SELECT * FROM app ORDER BY name').map(toApp);
  }

  putApp(app: App): void {
    this.#run(
      `INSERT INTO app (name, id, owner, status, current, policy_override, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET id = excluded.id, owner = excluded.owner, status = excluded.status,
         current = excluded.current, policy_override = excluded.policy_override, registered_at = excluded.registered_at`,
      app.name, app.id, app.owner, app.status, app.current, JSON.stringify(app.policyOverride), app.registeredAt,
    );
  }

  deleteApp(app: AppId): void {
    this.atomic(() => {
      for (const table of ['release', 'trigger', 'binding']) this.#run(`DELETE FROM ${table} WHERE app = ?`, app);
      this.#run('DELETE FROM app WHERE id = ?', app);
    });
  }

  release(app: AppId, number: ReleaseNumber): Release | null {
    const row = this.#get('SELECT * FROM release WHERE app = ? AND number = ?', app, number);
    return row ? toRelease(row) : null;
  }

  releases(app: AppId): Release[] {
    return this.#all('SELECT * FROM release WHERE app = ? ORDER BY number', app).map(toRelease);
  }

  putRelease(r: Release): void {
    this.#run(
      'INSERT INTO release (app, number, image, manifest, bundle, release_key, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      r.app, r.number, r.image, JSON.stringify(r.manifest), r.bundle, r.releaseKey, r.publishedAt,
    );
  }

  triggers(): Trigger[] {
    return this.#all('SELECT * FROM trigger ORDER BY app, name').map((r) => ({
      app: r.app as AppId,
      name: r.name as TriggerName,
      schedule: r.schedule as Trigger['schedule'],
    }));
  }

  replaceTriggers(app: AppId, triggers: readonly Trigger[]): void {
    this.atomic(() => {
      this.#run('DELETE FROM trigger WHERE app = ?', app);
      for (const t of triggers) this.#run('INSERT INTO trigger (app, name, schedule) VALUES (?, ?, ?)', app, t.name, t.schedule);
    });
  }

  bindings(app?: AppId): Binding[] {
    const rows = app === undefined
      ? this.#all('SELECT * FROM binding ORDER BY app, kind, provider')
      : this.#all('SELECT * FROM binding WHERE app = ? ORDER BY kind, provider', app);
    return rows.map(toBinding);
  }

  putBinding(b: Binding): void {
    this.#run(
      `INSERT INTO binding (app, kind, provider, state, resource) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (app, kind, provider) DO UPDATE SET state = excluded.state, resource = excluded.resource`,
      b.app, b.kind, b.provider, b.state, JSON.stringify(b.resource),
    );
  }

  policy(): Policy {
    const row = this.#get('SELECT value FROM policy WHERE id = 1');
    return row ? { ...DEFAULT_POLICY, ...JSON.parse(row.value as string) } : DEFAULT_POLICY;
  }

  putPolicy(policy: Policy): void {
    this.#run('INSERT INTO policy (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value', JSON.stringify(policy));
  }

  token(hash: string): Token | null {
    const row = this.#get('SELECT * FROM token WHERE hash = ?', hash);
    return row ? { id: row.id as string, subject: row.subject as Token['subject'], hash, createdAt: row.created_at as number } : null;
  }

  putToken(t: Token): void {
    this.#run('INSERT INTO token (id, subject, hash, created_at) VALUES (?, ?, ?, ?)', t.id, t.subject, t.hash, t.createdAt);
  }

  insertDelivery(d: Delivery): Delivery {
    return this.atomic(() => {
      const existing = d.scheduledFor !== null
        ? this.#get('SELECT * FROM delivery WHERE app = ? AND trigger = ? AND scheduled_for = ?', d.app, d.trigger, d.scheduledFor)
        : d.idempotencyKey !== null
          ? this.#get(
              'SELECT * FROM delivery WHERE app = ? AND trigger = ? AND idempotency_key = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
              d.app, d.trigger, d.idempotencyKey, d.createdAt - IDEMPOTENCY_WINDOW_MS,
            )
          : undefined;
      if (existing) return toDelivery(existing);
      this.#run(
        `INSERT INTO delivery (id, app, trigger, scheduled_for, caller, idempotency_key, body, state, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.id, d.app, d.trigger, d.scheduledFor, d.caller, d.idempotencyKey, d.body, d.state, d.attempts, d.nextAttemptAt, d.createdAt,
      );
      return d;
    });
  }

  updateDelivery(d: Delivery): void {
    this.#run('UPDATE delivery SET state = ?, attempts = ?, next_attempt_at = ? WHERE id = ?', d.state, d.attempts, d.nextAttemptAt, d.id);
  }

  deliveries(filter: DeliveryFilter): Delivery[] {
    const conditions = ([['app = ?', filter.app], ['state = ?', filter.state], ['next_attempt_at <= ?', filter.dueBefore]] as const)
      .filter(([, value]) => value !== undefined);
    const where = conditions.length ? `WHERE ${conditions.map(([clause]) => clause).join(' AND ')}` : '';
    // The worker wants the oldest due row first; every other reader wants the newest.
    const order = filter.dueBefore !== undefined ? 'next_attempt_at, created_at' : 'created_at DESC';
    const params = conditions.map(([, value]) => value as SQLInputValue);
    return this.#all(`SELECT * FROM delivery ${where} ORDER BY ${order} LIMIT ?`, ...params, filter.limit ?? -1).map(toDelivery);
  }

  lastScheduledFor(app: AppId, trigger: TriggerName): number | null {
    const row = this.#get('SELECT max(scheduled_for) AS last FROM delivery WHERE app = ? AND trigger = ?', app, trigger);
    return (row?.last as number | null) ?? null;
  }

  deleteDeliveries(app: AppId): void {
    this.#run('DELETE FROM delivery WHERE app = ?', app);
  }

  stats(): Stats[] {
    return this.#all('SELECT * FROM stats').map(toStats);
  }

  putStats(stats: readonly Stats[]): void {
    this.atomic(() => {
      for (const s of stats) {
        this.#run(
          `INSERT INTO stats (app, requests, errors, last_access_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (app) DO UPDATE SET requests = excluded.requests, errors = excluded.errors, last_access_at = excluded.last_access_at`,
          s.app, s.requests, s.errors, s.lastAccessAt,
        );
      }
    });
  }

  deleteStats(app: AppId): void {
    this.#run('DELETE FROM stats WHERE app = ?', app);
  }
}

abstract class Ops implements StoreOps {
  protected abstract run<T>(work: (s: Statements) => T): Promise<T>;

  app(name: AppName) { return this.run((s) => s.app(name)); }
  apps() { return this.run((s) => s.apps()); }
  putApp(app: App) { return this.run((s) => s.putApp(app)); }
  deleteApp(app: AppId) { return this.run((s) => s.deleteApp(app)); }
  release(app: AppId, number: ReleaseNumber) { return this.run((s) => s.release(app, number)); }
  releases(app: AppId) { return this.run((s) => s.releases(app)); }
  putRelease(release: Release) { return this.run((s) => s.putRelease(release)); }
  triggers() { return this.run((s) => s.triggers()); }
  replaceTriggers(app: AppId, triggers: readonly Trigger[]) { return this.run((s) => s.replaceTriggers(app, triggers)); }
  bindings(app?: AppId) { return this.run((s) => s.bindings(app)); }
  putBinding(binding: Binding) { return this.run((s) => s.putBinding(binding)); }
  policy() { return this.run((s) => s.policy()); }
  putPolicy(policy: Policy) { return this.run((s) => s.putPolicy(policy)); }
  token(hash: string) { return this.run((s) => s.token(hash)); }
  putToken(token: Token) { return this.run((s) => s.putToken(token)); }
  insertDelivery(delivery: Delivery) { return this.run((s) => s.insertDelivery(delivery)); }
  updateDelivery(delivery: Delivery) { return this.run((s) => s.updateDelivery(delivery)); }
  deliveries(filter: DeliveryFilter) { return this.run((s) => s.deliveries(filter)); }
  lastScheduledFor(app: AppId, trigger: TriggerName) { return this.run((s) => s.lastScheduledFor(app, trigger)); }
  deleteDeliveries(app: AppId) { return this.run((s) => s.deleteDeliveries(app)); }
  stats() { return this.run((s) => s.stats()); }
  putStats(stats: readonly Stats[]) { return this.run((s) => s.putStats(stats)); }
  deleteStats(app: AppId) { return this.run((s) => s.deleteStats(app)); }
}

/** The handle `transaction` passes to its function: calls run at once, inside the open transaction. */
class TransactionOps extends Ops {
  readonly #statements: Statements;
  open = true;

  constructor(statements: Statements) {
    super();
    this.#statements = statements;
  }

  protected async run<T>(work: (s: Statements) => T): Promise<T> {
    if (!this.open) throw new Error('tx used after its transaction settled');
    return work(this.#statements);
  }
}

/** Calls and transactions run one at a time in call order; node:sqlite is synchronous and in-process, so there is nothing to overlap. */
export class SqliteStore extends Ops implements Store {
  readonly #db: DatabaseSync;
  readonly #statements: Statements;
  readonly #inside = new AsyncLocalStorage<TransactionOps>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    super();
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.#statements = new Statements(this.#db);
    const { user_version: applied } = this.#db.prepare('PRAGMA user_version').get() as { user_version: number };
    this.#statements.atomic(() => {
      MIGRATIONS.slice(applied).forEach((step) => this.#db.exec(step));
      this.#db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    });
  }

  /** Closes after every queued call has run. */
  close(): Promise<void> {
    return this.#queue(() => this.#db.close());
  }

  transaction<T>(fn: (tx: StoreOps) => Promise<T>): Promise<T> {
    return this.#queue(async () => {
      const tx = new TransactionOps(this.#statements);
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const result = await this.#inside.run(tx, () => fn(tx));
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      } finally {
        tx.open = false;
      }
    });
  }

  protected run<T>(work: (s: Statements) => T): Promise<T> {
    return this.#queue(() => work(this.#statements));
  }

  #queue<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.#inside.getStore()?.open) {
      return Promise.reject(new Error('Store called inside its own transaction would wait for it forever; use the tx handle'));
    }
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
