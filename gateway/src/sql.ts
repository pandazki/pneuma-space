// The platform library's DML and row mapping, shared by SqliteStore and PgStore (ADR 0025 item 2). Placeholders are `$n`.

import {
  DEFAULT_POLICY, IDEMPOTENCY_WINDOW_MS, USAGE_COUNTERS,
  type App, type AppId, type AppName, type AuditFilter, type AuditRecord, type Binding, type Change, type Delivery, type DeliveryFilter,
  type DeliveryId, type DeliveryState, type EventFilter, type EventRecord, type GuardRecord, type Instance, type InstanceLog, type LeaseTally, type Membership,
  type Policy, type QuotaUsage, type Release, type ReleaseNumber, type Replica, type ReplicaId, type RowLock, type Stats,
  type StoreOps, type Tenant, type TenantName, type Token, type Trigger, type TriggerName, type Usage, type UsageBucket, type UsageFilter,
  type UsageStep, type User,
} from './model.ts';

export type Row = Record<string, unknown>;

/** What differs between the two engines in DML. */
export type Dialect = { readonly now: string; readonly lock: Readonly<Record<RowLock, string>> };

export const SQLITE: Dialect = { now: "CAST(unixepoch('subsec') * 1000 AS INTEGER)", lock: { share: '', update: '' } };
export const POSTGRES: Dialect = {
  now: 'CAST(extract(epoch FROM clock_timestamp()) * 1000 AS BIGINT)',
  lock: { share: ' FOR SHARE', update: ' FOR UPDATE' },
};

export interface Session {
  readonly dialect: Dialect;
  all(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  run(sql: string, params?: readonly unknown[]): Promise<{ readonly changes: number }>;
  /** Joins the open transaction or runs `fn` in its own. */
  atomic<T>(fn: () => Promise<T>): Promise<T>;
  /** Present where the engine does not announce changes itself: records what a write touched until commit. */
  readonly touched?: (change: Change) => void;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const json = (v: unknown) => JSON.parse(v as string);

const toApp = (r: Row): App => ({
  name: r.name as AppName,
  id: r.id as AppId,
  tenant: r.tenant as TenantName,
  access: r.access as App['access'],
  owner: r.owner as App['owner'],
  status: r.status as App['status'],
  current: numOrNull(r.current) as ReleaseNumber | null,
  policyOverride: json(r.policy_override),
  registeredAt: num(r.registered_at),
  version: num(r.version),
});

const toRelease = (r: Row): Release => ({
  app: r.app as AppId,
  number: num(r.number) as ReleaseNumber,
  image: r.image as Release['image'],
  manifest: json(r.manifest),
  bundle: r.bundle as Release['bundle'],
  runtime: r.runtime as Release['runtime'],
  releaseKey: r.release_key as string,
  publishedAt: num(r.published_at),
});

const toBinding = (r: Row): Binding => ({
  app: r.app as AppId,
  kind: r.kind as Binding['kind'],
  provider: r.provider as Binding['provider'],
  state: r.state as Binding['state'],
  resource: json(r.resource),
});

const toDelivery = (r: Row): Delivery => ({
  id: r.id as Delivery['id'],
  app: r.app as AppId,
  trigger: r.trigger as TriggerName,
  scheduledFor: numOrNull(r.scheduled_for),
  caller: r.caller as Delivery['caller'],
  idempotencyKey: r.idempotency_key as string | null,
  body: r.body as Uint8Array,
  state: r.state as Delivery['state'],
  attempts: num(r.attempts),
  nextAttemptAt: num(r.next_attempt_at),
  createdAt: num(r.created_at),
  replica: r.replica as ReplicaId | null,
});

const toToken = (r: Row): Token => ({
  id: r.id as string,
  tenant: r.tenant as TenantName,
  subject: r.subject as Token['subject'],
  label: r.label as string,
  hash: r.hash as string,
  createdBy: r.created_by as Token['createdBy'],
  createdAt: num(r.created_at),
  revokedAt: numOrNull(r.revoked_at),
});

const toTenant = (r: Row): Tenant => ({ name: r.name as TenantName, display: r.display as string, quota: json(r.quota), createdAt: num(r.created_at) });

const toInstance = (r: Row): Instance => ({
  app: r.app as AppId,
  runtime: r.runtime as Instance['runtime'],
  release: num(r.release) as ReleaseNumber,
  specHash: r.spec_hash as string,
  epoch: num(r.epoch),
  state: r.state as Instance['state'],
  actor: r.actor as ReplicaId | null,
  handle: r.handle as string | null,
  address: r.address as string | null,
  node: r.node as string | null,
  home: r.home as string | null,
  since: num(r.since),
  awakeAt: numOrNull(r.awake_at),
  cpuMillis: num(r.cpu_millis),
  memoryMb: num(r.memory_mb),
});

const toTally = (r: Row): LeaseTally => ({
  app: r.app as AppId,
  replica: r.replica as ReplicaId,
  epoch: num(r.epoch),
  request: num(r.request),
  channel: num(r.channel),
  trigger: num(r.trigger),
  releasedAt: numOrNull(r.released_at),
});

const toGuard = (r: Row): GuardRecord => ({
  app: r.app as AppId,
  release: num(r.release) as ReleaseNumber,
  failures: json(r.failures),
  quarantineReason: r.quarantine_reason as string | null,
  quarantinedAt: numOrNull(r.quarantined_at),
});

const toEvent = (r: Row): EventRecord => ({
  id: num(r.id), at: num(r.at), replica: r.replica as ReplicaId, ev: r.ev as string,
  app: r.app as string | null, tenant: r.tenant as TenantName | null, body: json(r.body),
});

const toAudit = (r: Row): AuditRecord => ({
  id: num(r.id), at: num(r.at), actor: r.actor as AuditRecord['actor'], actorTenant: r.actor_tenant as TenantName | null,
  tenant: r.tenant as TenantName | null, action: r.action as AuditRecord['action'], targetKind: r.target_kind as AuditRecord['targetKind'],
  target: r.target as string, result: r.result as AuditRecord['result'], details: json(r.details),
});

type Counter = (typeof USAGE_COUNTERS)[number];
const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const USAGE_COLUMNS = USAGE_COUNTERS.map((c) => [c, snake(c)] as const);

const INSTANCE_COLUMNS = [
  'app', 'runtime', 'release', 'spec_hash', 'epoch', 'state', 'actor', 'handle', 'address', 'node', 'home', 'since', 'awake_at', 'cpu_millis', 'memory_mb',
] as const;
const instanceParams = (i: Instance) => [
  i.app, i.runtime, i.release, i.specHash, i.epoch, i.state, i.actor, i.handle, i.address, i.node, i.home, i.since, i.awakeAt, i.cpuMillis, i.memoryMb,
];
const placeholders = (count: number, from = 1) => Array.from({ length: count }, (_, i) => `$${from + i}`).join(', ');

/** `WHERE` from the filter entries whose value is set; returns the clause and its params, numbered from `from`. */
function where(entries: readonly (readonly [string, unknown])[], from = 1): { readonly sql: string; readonly params: unknown[] } {
  const set = entries.filter(([, value]) => value !== undefined);
  const sql = set.length ? `WHERE ${set.map(([clause], i) => clause.replaceAll('?', `$${from + i}`)).join(' AND ')}` : '';
  return { sql, params: set.map(([, value]) => value) };
}

const limit = (n: number | undefined) => (n === undefined ? '' : ` LIMIT ${Math.trunc(n)}`);

export class SqlOps implements StoreOps {
  readonly #s: Session;
  readonly #volumeGb: number;

  /** `volumeGb` is the provisioned size of one files or SQLite binding, what `storage_gb` counts (ADR 0023 item 4). */
  constructor(session: Session, volumeGb: number) {
    this.#s = session;
    this.#volumeGb = volumeGb;
  }

  #touch(change: Change): void {
    this.#s.touched?.(change);
  }

  async #touchApp(id: AppId): Promise<void> {
    const [row] = await this.#s.all('UPDATE app SET version = version + 1 WHERE id = $1 RETURNING name', [id]);
    if (row) this.#touch({ kind: 'app', name: row.name as AppName });
  }

  async #one(sql: string, params: readonly unknown[]): Promise<Row | null> {
    return (await this.#s.all(sql, params))[0] ?? null;
  }

  async app(name: AppName) {
    const row = await this.#one('SELECT * FROM app WHERE name = $1', [name]);
    return row ? toApp(row) : null;
  }

  async apps() {
    return (await this.#s.all('SELECT * FROM app ORDER BY name')).map(toApp);
  }

  /** A write that changes nothing raises no version and announces nothing, so restart convergence leaves the rows as they were. */
  async putApp(app: App) {
    const { changes } = await this.#s.run(
      `INSERT INTO app (name, id, tenant, access, owner, status, current, policy_override, registered_at, version) VALUES (${placeholders(9)}, 1)
       ON CONFLICT (name) DO UPDATE SET id = excluded.id, tenant = excluded.tenant, access = excluded.access, owner = excluded.owner,
         status = excluded.status, current = excluded.current, policy_override = excluded.policy_override, registered_at = excluded.registered_at,
         version = app.version + 1
       WHERE ${['id', 'tenant', 'access', 'owner', 'status', 'current', 'policy_override', 'registered_at'].map((c) => `app.${c} IS DISTINCT FROM excluded.${c}`).join(' OR ')}`,
      [app.name, app.id, app.tenant, app.access, app.owner, app.status, app.current, JSON.stringify(app.policyOverride), app.registeredAt],
    );
    if (changes > 0) this.#touch({ kind: 'app', name: app.name });
  }

  deleteApp(app: AppId) {
    return this.#s.atomic(async () => {
      await this.#touchApp(app);
      for (const table of ['release', 'trigger', 'binding']) await this.#s.run(`DELETE FROM ${table} WHERE app = $1`, [app]);
      await this.#s.run('DELETE FROM app WHERE id = $1', [app]);
    });
  }

  async release(app: AppId, number: ReleaseNumber) {
    const row = await this.#one('SELECT * FROM release WHERE app = $1 AND number = $2', [app, number]);
    return row ? toRelease(row) : null;
  }

  async releases(app: AppId) {
    return (await this.#s.all('SELECT * FROM release WHERE app = $1 ORDER BY number', [app])).map(toRelease);
  }

  async putRelease(r: Release) {
    await this.#s.run(
      `INSERT INTO release (app, number, image, manifest, bundle, runtime, release_key, published_at) VALUES (${placeholders(8)})`,
      [r.app, r.number, r.image, JSON.stringify(r.manifest), r.bundle, r.runtime, r.releaseKey, r.publishedAt],
    );
    await this.#touchApp(r.app);
  }

  async triggers() {
    return (await this.#s.all('SELECT * FROM trigger ORDER BY app, name')).map((r): Trigger => ({
      app: r.app as AppId, name: r.name as TriggerName, schedule: r.schedule as Trigger['schedule'],
    }));
  }

  replaceTriggers(app: AppId, triggers: readonly Trigger[]) {
    return this.#s.atomic(async () => {
      await this.#s.run('DELETE FROM trigger WHERE app = $1', [app]);
      for (const t of triggers) await this.#s.run('INSERT INTO trigger (app, name, schedule) VALUES ($1, $2, $3)', [app, t.name, t.schedule]);
      await this.#touchApp(app);
    });
  }

  async bindings(app?: AppId) {
    const rows = app === undefined
      ? await this.#s.all('SELECT * FROM binding ORDER BY app, kind, provider')
      : await this.#s.all('SELECT * FROM binding WHERE app = $1 ORDER BY kind, provider', [app]);
    return rows.map(toBinding);
  }

  async putBinding(b: Binding) {
    const { changes } = await this.#s.run(
      `INSERT INTO binding (app, kind, provider, state, resource) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app, kind, provider) DO UPDATE SET state = excluded.state, resource = excluded.resource
       WHERE binding.state IS DISTINCT FROM excluded.state OR binding.resource IS DISTINCT FROM excluded.resource`,
      [b.app, b.kind, b.provider, b.state, JSON.stringify(b.resource)],
    );
    if (changes > 0) await this.#touchApp(b.app);
  }

  async policy(): Promise<Policy> {
    const row = await this.#one('SELECT value FROM policy WHERE id = 1', []);
    return row ? { ...DEFAULT_POLICY, ...json(row.value) } : DEFAULT_POLICY;
  }

  async putPolicy(policy: Policy) {
    await this.#s.run('INSERT INTO policy (id, value) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET value = excluded.value', [JSON.stringify(policy)]);
    this.#touch({ kind: 'policy' });
  }

  async token(hash: string) {
    const row = await this.#one('SELECT * FROM token WHERE hash = $1', [hash]);
    return row ? toToken(row) : null;
  }

  async tokens(tenant: TenantName) {
    return (await this.#s.all('SELECT * FROM token WHERE tenant = $1 ORDER BY created_at, id', [tenant])).map(toToken);
  }

  async putToken(t: Token) {
    await this.#s.run(
      `INSERT INTO token (id, tenant, subject, label, hash, created_by, created_at, revoked_at) VALUES (${placeholders(8)})`,
      [t.id, t.tenant, t.subject, t.label, t.hash, t.createdBy, t.createdAt, t.revokedAt],
    );
    this.#touch({ kind: 'tenant', name: t.tenant });
  }

  async revokeToken(id: string, at: number) {
    const [row] = await this.#s.all('UPDATE token SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING tenant', [id, at]);
    if (row) this.#touch({ kind: 'tenant', name: row.tenant as TenantName });
    return row !== undefined;
  }

  async tenant(name: TenantName, lock?: RowLock) {
    const row = await this.#one(`SELECT * FROM tenant WHERE name = $1${lock ? this.#s.dialect.lock[lock] : ''}`, [name]);
    return row ? toTenant(row) : null;
  }

  async tenants() {
    return (await this.#s.all('SELECT * FROM tenant ORDER BY name')).map(toTenant);
  }

  async putTenant(t: Tenant) {
    await this.#s.run(
      `INSERT INTO tenant (name, display, quota, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET display = excluded.display, quota = excluded.quota`,
      [t.name, t.display, JSON.stringify(t.quota), t.createdAt],
    );
    this.#touch({ kind: 'tenant', name: t.name });
  }

  async quotaUsed(tenant: TenantName): Promise<QuotaUsage> {
    const row = (await this.#one(
      `SELECT
         (SELECT count(*) FROM app WHERE tenant = $1 AND status <> 'purging') AS apps,
         (SELECT count(*) FROM instance i JOIN app a ON a.id = i.app WHERE a.tenant = $1 AND i.state <> 'asleep') AS awake,
         (SELECT coalesce(sum(i.cpu_millis), 0) FROM instance i JOIN app a ON a.id = i.app WHERE a.tenant = $1 AND i.state <> 'asleep') AS cpu_millis,
         (SELECT coalesce(sum(i.memory_mb), 0) FROM instance i JOIN app a ON a.id = i.app WHERE a.tenant = $1 AND i.state <> 'asleep') AS memory_mb,
         (SELECT count(*) FROM binding b JOIN app a ON a.id = b.app WHERE a.tenant = $1 AND b.provider IN ('volume', 'sqlite')) AS volumes`,
      [tenant],
    ))!;
    return {
      apps: num(row.apps), awake: num(row.awake), cpu_millis: num(row.cpu_millis), memory_mb: num(row.memory_mb), storage_gb: num(row.volumes) * this.#volumeGb,
    };
  }

  async user(id: string) {
    const row = await this.#one('SELECT * FROM users WHERE id = $1', [id]);
    return row
      ? { id, name: row.name as string, groups: json(row.groups), firstSeen: num(row.first_seen), lastSeen: num(row.last_seen) } satisfies User
      : null;
  }

  async putUser(u: User) {
    await this.#s.run(
      `INSERT INTO users (id, name, groups, first_seen, last_seen) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, groups = excluded.groups, last_seen = excluded.last_seen`,
      [u.id, u.name, JSON.stringify(u.groups), u.firstSeen, u.lastSeen],
    );
  }

  async memberships(filter: { readonly tenant?: TenantName; readonly user?: string }) {
    const w = where([['tenant = ?', filter.tenant], ['user_id = ?', filter.user]]);
    return (await this.#s.all(`SELECT * FROM membership ${w.sql} ORDER BY tenant, user_id`, w.params)).map((r): Membership => ({
      tenant: r.tenant as TenantName, user: r.user_id as string, role: r.role as Membership['role'],
    }));
  }

  async putMembership(m: Membership) {
    await this.#s.run(
      'INSERT INTO membership (tenant, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (tenant, user_id) DO UPDATE SET role = excluded.role',
      [m.tenant, m.user, m.role],
    );
    this.#touch({ kind: 'tenant', name: m.tenant });
  }

  async deleteMembership(tenant: TenantName, user: string) {
    await this.#s.run('DELETE FROM membership WHERE tenant = $1 AND user_id = $2', [tenant, user]);
    this.#touch({ kind: 'tenant', name: tenant });
  }

  insertDelivery(d: Delivery) {
    return this.#s.atomic(async () => {
      const existing = d.scheduledFor !== null
        ? await this.#one('SELECT * FROM delivery WHERE app = $1 AND trigger = $2 AND scheduled_for = $3', [d.app, d.trigger, d.scheduledFor])
        : d.idempotencyKey !== null
          ? await this.#one(
              'SELECT * FROM delivery WHERE app = $1 AND trigger = $2 AND idempotency_key = $3 AND created_at > $4 ORDER BY created_at DESC LIMIT 1',
              [d.app, d.trigger, d.idempotencyKey, d.createdAt - IDEMPOTENCY_WINDOW_MS],
            )
          : null;
      if (existing) return toDelivery(existing);
      await this.#s.run(
        `INSERT INTO delivery (id, app, trigger, scheduled_for, caller, idempotency_key, body, state, attempts, next_attempt_at, created_at)
         VALUES (${placeholders(11)})`,
        [d.id, d.app, d.trigger, d.scheduledFor, d.caller, d.idempotencyKey, d.body, d.state, d.attempts, d.nextAttemptAt, d.createdAt],
      );
      return d;
    });
  }

  async updateDelivery(d: Delivery) {
    await this.#s.run('UPDATE delivery SET state = $1, attempts = $2, next_attempt_at = $3 WHERE id = $4', [d.state, d.attempts, d.nextAttemptAt, d.id]);
  }

  async claimDelivery(id: DeliveryId, replica: ReplicaId, attempts: number) {
    const { changes } = await this.#s.run("UPDATE delivery SET state = 'delivering', replica = $2, attempts = $3 WHERE id = $1 AND state = 'due'", [id, replica, attempts]);
    return changes > 0;
  }

  async deliveries(filter: DeliveryFilter) {
    const w = where([['app = ?', filter.app], ['state = ?', filter.state], ['next_attempt_at <= ?', filter.dueBefore]]);
    // The worker wants the oldest due row first; every other reader wants the newest.
    const order = filter.dueBefore !== undefined ? 'next_attempt_at, created_at' : 'created_at DESC';
    return (await this.#s.all(`SELECT * FROM delivery ${w.sql} ORDER BY ${order}${limit(filter.limit)}`, w.params)).map(toDelivery);
  }

  async deliveryCounts() {
    const counts: Record<DeliveryState, number> = { due: 0, delivering: 0, done: 0, failed: 0, cancelled: 0 };
    for (const row of await this.#s.all('SELECT state, count(*) AS n FROM delivery GROUP BY state')) counts[row.state as DeliveryState] = num(row.n);
    return counts;
  }

  async lastScheduledFor(app: AppId, trigger: TriggerName) {
    const row = await this.#one('SELECT max(scheduled_for) AS last FROM delivery WHERE app = $1 AND trigger = $2', [app, trigger]);
    return numOrNull(row?.last);
  }

  async deleteDeliveries(app: AppId) {
    await this.#s.run('DELETE FROM delivery WHERE app = $1', [app]);
  }

  async sweepDeliveries(before: number) {
    return (await this.#s.run("DELETE FROM delivery WHERE state IN ('done', 'cancelled') AND created_at < $1", [before])).changes;
  }

  /** `requests` and `errors` live in `usage` now (ADR 0024 item 3); the zeros stand in until Stats loses them. */
  async stats() {
    return (await this.#s.all('SELECT app, last_access_at FROM stats')).map((r): Stats => ({
      app: r.app as AppId, requests: 0, errors: 0, lastAccessAt: numOrNull(r.last_access_at),
    }));
  }

  /** Each replica writes its own last access; the later one wins. */
  putStats(stats: readonly Stats[]) {
    return this.#s.atomic(async () => {
      for (const s of stats) {
        await this.#s.run(
          `INSERT INTO stats (app, last_access_at) VALUES ($1, $2)
           ON CONFLICT (app) DO UPDATE SET last_access_at = CASE
             WHEN stats.last_access_at IS NULL OR excluded.last_access_at > stats.last_access_at THEN excluded.last_access_at
             ELSE stats.last_access_at END`,
          [s.app, s.lastAccessAt],
        );
      }
    });
  }

  async deleteStats(app: AppId) {
    await this.#s.run('DELETE FROM stats WHERE app = $1', [app]);
  }

  async replicas() {
    return (await this.#s.all('SELECT * FROM replica ORDER BY id')).map((r): Replica => ({
      id: r.id as ReplicaId, startedAt: num(r.started_at), seenAt: num(r.seen_at),
    }));
  }

  async putReplica(r: Replica) {
    await this.#s.run(
      'INSERT INTO replica (id, started_at, seen_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET seen_at = excluded.seen_at',
      [r.id, r.startedAt, r.seenAt],
    );
  }

  sweepReplicas(before: number) {
    return this.#s.atomic(async () => {
      const dead = (await this.#s.all('SELECT id FROM replica WHERE seen_at < $1 ORDER BY id', [before])).map((r) => r.id as ReplicaId);
      for (const id of dead) await this.deleteReplica(id);
      return dead;
    });
  }

  deleteReplica(id: ReplicaId) {
    return this.#s.atomic(async () => {
      await this.#s.run('DELETE FROM lease_tally WHERE replica = $1', [id]);
      await this.#s.run('DELETE FROM replica WHERE id = $1', [id]);
    });
  }

  async instance(app: AppId, lock?: RowLock) {
    const row = await this.#one(`SELECT * FROM instance WHERE app = $1${lock ? this.#s.dialect.lock[lock] : ''}`, [app]);
    return row ? toInstance(row) : null;
  }

  async instances() {
    return (await this.#s.all('SELECT * FROM instance ORDER BY app')).map(toInstance);
  }

  async insertInstance(i: Instance) {
    const { changes } = await this.#s.run(
      `INSERT INTO instance (${INSTANCE_COLUMNS.join(', ')}) VALUES (${placeholders(INSTANCE_COLUMNS.length)}) ON CONFLICT (app) DO NOTHING`,
      instanceParams(i),
    );
    if (changes > 0) this.#touch({ kind: 'instance', app: i.app });
    return changes > 0;
  }

  async casInstance(expected: Pick<Instance, 'runtime' | 'state' | 'epoch'>, next: Instance) {
    const n = INSTANCE_COLUMNS.length;
    const set = INSTANCE_COLUMNS.slice(1).map((column, i) => `${column} = $${i + 2}`).join(', ');
    const { changes } = await this.#s.run(
      `UPDATE instance SET ${set} WHERE app = $1 AND runtime = $${n + 1} AND state = $${n + 2} AND epoch = $${n + 3}`,
      [...instanceParams(next), expected.runtime, expected.state, expected.epoch],
    );
    if (changes > 0) this.#touch({ kind: 'instance', app: next.app });
    return changes > 0;
  }

  deleteInstance(app: AppId) {
    return this.#s.atomic(async () => {
      const { changes } = await this.#s.run('DELETE FROM instance WHERE app = $1', [app]);
      await this.#s.run('DELETE FROM lease_tally WHERE app = $1', [app]);
      if (changes > 0) this.#touch({ kind: 'instance', app });
    });
  }

  async leaseTallies(app?: AppId) {
    const w = where([['app = ?', app]]);
    return (await this.#s.all(`SELECT * FROM lease_tally ${w.sql} ORDER BY app, replica`, w.params)).map(toTally);
  }

  async putLeaseTally(t: LeaseTally) {
    await this.#s.run(
      `INSERT INTO lease_tally (app, replica, epoch, request, channel, trigger, released_at) VALUES (${placeholders(7)})
       ON CONFLICT (app, replica) DO UPDATE SET epoch = excluded.epoch, request = excluded.request, channel = excluded.channel,
         trigger = excluded.trigger, released_at = excluded.released_at`,
      [t.app, t.replica, t.epoch, t.request, t.channel, t.trigger, t.releasedAt],
    );
  }

  async guard(app: AppId, lock?: RowLock) {
    const row = await this.#one(`SELECT * FROM guard WHERE app = $1${lock ? this.#s.dialect.lock[lock] : ''}`, [app]);
    return row ? toGuard(row) : null;
  }

  async guards() {
    return (await this.#s.all('SELECT * FROM guard ORDER BY app')).map(toGuard);
  }

  async putGuard(g: GuardRecord) {
    await this.#s.run(
      `INSERT INTO guard (app, release, failures, quarantine_reason, quarantined_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app) DO UPDATE SET release = excluded.release, failures = excluded.failures,
         quarantine_reason = excluded.quarantine_reason, quarantined_at = excluded.quarantined_at`,
      [g.app, g.release, JSON.stringify(g.failures), g.quarantineReason, g.quarantinedAt],
    );
    this.#touch({ kind: 'instance', app: g.app });
  }

  async deleteGuard(app: AppId) {
    await this.#s.run('DELETE FROM guard WHERE app = $1', [app]);
    this.#touch({ kind: 'instance', app });
  }

  putUsage(rows: readonly Usage[]) {
    const columns = ['app', 'tenant', 'step', 'start', 'replica', ...USAGE_COLUMNS.map(([, column]) => column)];
    const sql = `INSERT INTO usage (${columns.join(', ')}) VALUES (${placeholders(columns.length)})
      ON CONFLICT (app, step, start, replica) DO UPDATE SET tenant = excluded.tenant, ${USAGE_COLUMNS.map(([, c]) => `${c} = excluded.${c}`).join(', ')}`;
    return this.#s.atomic(async () => {
      for (const u of rows) await this.#s.run(sql, [u.app, u.tenant, u.step, u.start, u.replica, ...USAGE_COLUMNS.map(([counter]) => u[counter])]);
    });
  }

  async usage(filter: UsageFilter) {
    const w = where([['step = ?', filter.step], ['start >= ?', filter.from], ['start < ?', filter.to], ['app = ?', filter.app], ['tenant = ?', filter.tenant]]);
    const sums = USAGE_COLUMNS.map(([, c]) => `sum(${c}) AS ${c}`).join(', ');
    const rows = await this.#s.all(`SELECT app, max(tenant) AS tenant, step, start, ${sums} FROM usage ${w.sql} GROUP BY app, step, start ORDER BY app, start`, w.params);
    return rows.map((r): UsageBucket => ({
      app: r.app as UsageBucket['app'], tenant: r.tenant as TenantName | null, step: num(r.step) as UsageStep, start: num(r.start),
      ...(Object.fromEntries(USAGE_COLUMNS.map(([counter, column]) => [counter, num(r[column])])) as Record<Counter, number>),
    }));
  }

  async sweepUsage(step: UsageStep, before: number) {
    return (await this.#s.run('DELETE FROM usage WHERE step = $1 AND start < $2', [step, before])).changes;
  }

  insertEvents(events: readonly Omit<EventRecord, 'id' | 'at'>[]) {
    const sql = `INSERT INTO events (at, replica, ev, app, tenant, body) VALUES (${this.#s.dialect.now}, $1, $2, $3, $4, $5)`;
    return this.#s.atomic(async () => {
      for (const e of events) await this.#s.run(sql, [e.replica, e.ev, e.app, e.tenant, JSON.stringify(e.body)]);
    });
  }

  async events(filter: EventFilter) {
    const w = where([['id > ?', filter.after], ['at >= ?', filter.since], ['ev = ?', filter.ev], [`at < ${this.#s.dialect.now} - ?`, filter.settleMs]]);
    return (await this.#s.all(`SELECT * FROM events ${w.sql} ORDER BY id${limit(filter.limit)}`, w.params)).map(toEvent);
  }

  sweepEvents(before: number, maxRows: number) {
    return this.#s.atomic(async () => {
      const old = await this.#s.run('DELETE FROM events WHERE at < $1', [before]);
      const over = await this.#s.run(
        'DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET $1)', [Math.trunc(maxRows)],
      );
      return old.changes + over.changes;
    });
  }

  async insertAudit(a: Omit<AuditRecord, 'id'>) {
    const [row] = await this.#s.all(
      `INSERT INTO audit (at, actor, actor_tenant, tenant, action, target_kind, target, result, details) VALUES (${placeholders(9)}) RETURNING id`,
      [a.at, a.actor, a.actorTenant, a.tenant, a.action, a.targetKind, a.target, a.result, JSON.stringify(a.details)],
    );
    return num(row.id);
  }

  async audit(filter: AuditFilter) {
    const w = where([
      ['tenant = ?', filter.tenant], ['at >= ?', filter.from], ['at < ?', filter.to], ['actor = ?', filter.actor],
      ['action = ?', filter.action], ['target = ?', filter.target],
    ]);
    return (await this.#s.all(`SELECT * FROM audit ${w.sql} ORDER BY id DESC${limit(filter.limit)}`, w.params)).map(toAudit);
  }

  async instanceLog(app: AppId) {
    const row = await this.#one('SELECT * FROM instance_log WHERE app = $1', [app]);
    return row
      ? { app, release: num(row.release) as ReleaseNumber, endedAt: num(row.ended_at), reason: row.reason as string, tail: row.tail as string } satisfies InstanceLog
      : null;
  }

  async putInstanceLog(l: InstanceLog) {
    await this.#s.run(
      `INSERT INTO instance_log (app, release, ended_at, reason, tail) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app) DO UPDATE SET release = excluded.release, ended_at = excluded.ended_at, reason = excluded.reason, tail = excluded.tail`,
      [l.app, l.release, l.endedAt, l.reason, l.tail],
    );
  }
}

/** Every StoreOps method name, for stores that wrap each call (a queue, a pool session). */
export const STORE_OPS = Object.getOwnPropertyNames(SqlOps.prototype).filter((name) => name !== 'constructor') as (keyof StoreOps)[];
