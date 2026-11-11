// Shared contract of the gateway. Every component codes against these types; DESIGN.md is the source.

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

type Brand<T, B extends string> = T & { readonly __brand: B };

/** Errors the admin API maps to 400, 404 and 409; messages are written for the person who sent the input. */
export class InputError extends Error {}
export class ManifestError extends InputError {}
export class NotFound extends Error {}
export class Conflict extends Error {}

// Ids

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export type AppName = Brand<string, 'AppName'>;
export type TenantName = Brand<string, 'TenantName'>;
export type AppId = Brand<string, 'AppId'>;
export type ReleaseNumber = Brand<number, 'ReleaseNumber'>;
/** Docker image id (`sha256:...`), resolved from a reference at publish. */
export type ImageId = Brand<string, 'ImageId'>;
/** sha256 hex of the bundle tar. */
export type BundleId = Brand<string, 'BundleId'>;
export type Subject = Brand<`user:${string}` | `service:${string}`, 'Subject'>;
export type DeliveryId = Brand<string, 'DeliveryId'>;
export type TriggerName = Brand<string, 'TriggerName'>;
/** Five-field cron expression, bounds already checked. */
export type CronExpr = Brand<string, 'CronExpr'>;

export function appName(raw: string): AppName {
  if (!NAME_PATTERN.test(raw)) throw new InputError(`app name "${raw}" must match ${NAME_PATTERN.source}`);
  return raw as AppName;
}

export function tenantName(raw: string): TenantName {
  if (!NAME_PATTERN.test(raw)) throw new InputError(`tenant name "${raw}" must match ${NAME_PATTERN.source}`);
  return raw as TenantName;
}

/** Where single-host writes land and where migration step 4 put every M1 app and token (ADR 0022). */
export const DEFAULT_TENANT = 'default' as TenantName;

export function triggerName(raw: string): TriggerName {
  if (!NAME_PATTERN.test(raw)) throw new InputError(`trigger name "${raw}" must match ${NAME_PATTERN.source}`);
  return raw as TriggerName;
}

export function subject(raw: string): Subject {
  if (!/^(user|service):[A-Za-z0-9._@+-]{1,64}$/.test(raw)) {
    throw new InputError(`subject "${raw}" must be user:<id> or service:<id>, id of up to 64 letters, digits and ._@+-`);
  }
  return raw as Subject;
}

export function bundleId(raw: string): BundleId {
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new InputError(`bundle "${raw}" must be the id returned by POST /api/bundles`);
  return raw as BundleId;
}

export function newAppId(): AppId {
  return randomBytes(6).toString('hex') as AppId;
}

// Capabilities

export const CAPABILITY_KINDS = ['route', 'files', 'db', 'kv', 'object', 'static', 'ws', 'cron', 'identity', 'rtc'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];
export type KindClass = 'resource' | 'ingress' | 'schedule';

export type EmptyDeclaration = Record<string, never>;
export type StaticDeclaration = { readonly dir: string };
export type CronDeclaration = { readonly triggers: Readonly<Record<TriggerName, { readonly schedule?: CronExpr }>> };
/** `required` absent means true. */
export type IdentityDeclaration = { readonly required?: boolean };

type CapabilitySpec = {
  readonly class: KindClass;
  readonly needsRuntime: boolean;
  /** Provider implementations; non-empty exactly for resource kinds. */
  readonly providers: readonly string[];
  readonly parse: (raw: unknown, where: string) => unknown;
};

/** The only capability list. Env names, providers to call and gateway flags derive from it. */
export const CAPABILITIES = {
  route:    { class: 'ingress',  needsRuntime: false, providers: [],                     parse: implicit },
  files:    { class: 'resource', needsRuntime: true,  providers: ['volume'],             parse: empty },
  db:       { class: 'resource', needsRuntime: true,  providers: ['sqlite', 'postgres'], parse: empty },
  kv:       { class: 'resource', needsRuntime: true,  providers: ['redis'],              parse: empty },
  object:   { class: 'resource', needsRuntime: true,  providers: ['s3'],                 parse: empty },
  static:   { class: 'ingress',  needsRuntime: false, providers: [],                     parse: parseStatic },
  ws:       { class: 'ingress',  needsRuntime: true,  providers: [],                     parse: empty },
  cron:     { class: 'schedule', needsRuntime: true,  providers: [],                     parse: parseCron },
  identity: { class: 'ingress',  needsRuntime: true,  providers: [],                     parse: parseIdentity },
  rtc:      { class: 'resource', needsRuntime: true,  providers: ['coturn'],             parse: empty },
} as const satisfies Record<CapabilityKind, CapabilitySpec>;

export type Declaration<K extends CapabilityKind> = ReturnType<(typeof CAPABILITIES)[K]['parse']>;
export type ResourceKind = {
  [K in CapabilityKind]: (typeof CAPABILITIES)[K]['class'] extends 'resource' ? K : never;
}[CapabilityKind];
export type ProviderName = (typeof CAPABILITIES)[CapabilityKind]['providers'][number];
export type DbBackend = (typeof CAPABILITIES)['db']['providers'][number];

/** Variables a declared kind injects (docs/app-contract.md, Environment). */
export const ENV_BY_KIND = {
  route:    [],
  files:    ['PNEUMA_SPACE_FILES_DIR'],
  db:       ['PNEUMA_SPACE_DB_URL'],
  kv:       ['PNEUMA_SPACE_KV_URL', 'PNEUMA_SPACE_KV_PREFIX'],
  object:   ['PNEUMA_SPACE_OBJECT_ENDPOINT', 'PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT', 'PNEUMA_SPACE_OBJECT_BUCKET', 'PNEUMA_SPACE_OBJECT_ACCESS_KEY', 'PNEUMA_SPACE_OBJECT_SECRET_KEY'],
  static:   [],
  ws:       [],
  cron:     [],
  identity: [],
  rtc:      ['PNEUMA_SPACE_RTC_STUN_URLS', 'PNEUMA_SPACE_RTC_TURN_URLS', 'PNEUMA_SPACE_RTC_TURN_SECRET'],
} as const satisfies Record<CapabilityKind, readonly string[]>;

/** Set by the Runtime on every app instance, declared or not; `port` is where the app listens (8000 in a container, assigned in an isolate). */
export const RUNTIME_ENV = { app: 'PNEUMA_SPACE_APP', release: 'PNEUMA_SPACE_RELEASE', port: 'PNEUMA_SPACE_PORT' } as const;

// Runtimes (ADR 0017)

export const RUNTIME_KINDS = ['container', 'isolate'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];
/** The only runtime list: a kind is one row here and one Runtime implementation. `service` names the compose service and profile it needs; `input` is what a publish must carry. */
export const RUNTIMES = {
  container: { service: null,     profile: null,      input: 'image' },
  isolate:   { service: 'runner', profile: 'isolate', input: 'bundle' },
} as const satisfies Record<RuntimeKind, { readonly service: string | null; readonly profile: string | null; readonly input: 'image' | 'bundle' }>;
export const DEFAULT_ENTRY = 'src/server.ts';

function assertCoversKinds(label: string, table: object): void {
  const has = Object.keys(table).sort().join(',');
  const want = [...CAPABILITY_KINDS].sort().join(',');
  if (has !== want) throw new Error(`${label} must cover exactly the capability kinds: has [${has}], expected [${want}]`);
}
assertCoversKinds('CAPABILITIES', CAPABILITIES);
assertCoversKinds('ENV_BY_KIND', ENV_BY_KIND);
for (const [kind, spec] of Object.entries(CAPABILITIES) as [string, CapabilitySpec][]) {
  if ((spec.class === 'resource') !== spec.providers.length > 0) {
    throw new Error(`CAPABILITIES.${kind}: a kind has providers exactly when its class is resource`);
  }
}

/** The provider that serves `kind` for an app under its effective policy. */
export function selectProvider(kind: ResourceKind, policy: Policy): ProviderName {
  return kind === 'db' ? policy.db_backend : CAPABILITIES[kind].providers[0];
}

// Manifest

export type Capabilities = { readonly [K in CapabilityKind]?: Declaration<K> };
/** Parsed once at the publish boundary; downstream code does not validate it again. `route` is implicit and never present. */
export type Manifest = {
  readonly contract: 1;
  readonly capabilities: Capabilities;
  /** Absent means: container when the publish carries an image, isolate when it carries a code bundle. */
  readonly runtime?: RuntimeKind;
  /** Isolate apps only: the module the runner loads, relative to the bundle; DEFAULT_ENTRY when absent. */
  readonly entry?: string;
};

type RawObject = Record<string, unknown>;

function asObject(raw: unknown, where: string): RawObject {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ManifestError(`${where} must be a JSON object`);
  return raw as RawObject;
}

function onlyKeys(raw: RawObject, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new ManifestError(`${where}: unknown field "${unknown}"; allowed: ${allowed.length ? allowed.join(', ') : 'none'}`);
  }
}

function implicit(_raw: unknown, where: string): never {
  throw new ManifestError(`${where}: route is implicit for every app; remove it from the manifest`);
}

function empty(raw: unknown, where: string): EmptyDeclaration {
  onlyKeys(asObject(raw, where), [], where);
  return {};
}

function parseIdentity(raw: unknown, where: string): IdentityDeclaration {
  const declaration = asObject(raw, where);
  onlyKeys(declaration, ['required'], where);
  if (declaration.required !== undefined && typeof declaration.required !== 'boolean') {
    throw new ManifestError(`${where}.required must be true or false`);
  }
  return declaration.required === undefined ? {} : { required: declaration.required };
}

function parseStatic(raw: unknown, where: string): StaticDeclaration {
  const declaration = asObject(raw, where);
  onlyKeys(declaration, ['dir'], where);
  const dir = declaration.dir;
  if (typeof dir !== 'string' || dir === '' || dir.startsWith('/') || dir.split('/').includes('..')) {
    throw new ManifestError(`${where}.dir must be a relative directory inside the source root, like "dist"`);
  }
  return { dir };
}

const CRON_BOUNDS: readonly (readonly [number, number])[] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function cronFieldValid(field: string, [low, high]: readonly [number, number]): boolean {
  return field.split(',').every((item) => {
    const match = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!match) return false;
    const [, from, to, step] = match;
    const start = from === undefined ? low : Number(from);
    const end = to === undefined ? (from === undefined ? high : start) : Number(to);
    return low <= start && start <= end && end <= high && (step === undefined || Number(step) >= 1);
  });
}

function parseCron(raw: unknown, where: string): CronDeclaration {
  const declaration = asObject(raw, where);
  onlyKeys(declaration, ['triggers'], where);
  const triggers: Record<string, { schedule?: CronExpr }> = {};
  for (const [name, value] of Object.entries(asObject(declaration.triggers, `${where}.triggers`))) {
    const at = `${where}.triggers.${name}`;
    if (!NAME_PATTERN.test(name)) throw new ManifestError(`${at}: trigger name must match ${NAME_PATTERN.source}`);
    const trigger = asObject(value, at);
    onlyKeys(trigger, ['schedule'], at);
    if (trigger.schedule === undefined) {
      triggers[name] = {};
      continue;
    }
    const fields = typeof trigger.schedule === 'string' ? trigger.schedule.trim().split(/\s+/) : [];
    if (fields.length !== 5 || !fields.every((field, i) => cronFieldValid(field, CRON_BOUNDS[i]))) {
      throw new ManifestError(
        `${at}.schedule must be a 5-field cron expression (minute hour day-of-month month day-of-week) using numbers, *, -, / and ,`,
      );
    }
    triggers[name] = { schedule: fields.join(' ') as CronExpr };
  }
  return { triggers: triggers as CronDeclaration['triggers'] };
}

export function parseManifest(raw: unknown): Manifest {
  const manifest = asObject(raw, 'manifest');
  onlyKeys(manifest, ['contract', 'capabilities', 'runtime', 'entry'], 'manifest');
  if (manifest.contract !== 1) {
    throw new ManifestError(`manifest.contract must be 1, got ${JSON.stringify(manifest.contract) ?? 'nothing'}`);
  }
  const capabilities: Record<string, unknown> = {};
  for (const [kind, declaration] of Object.entries(asObject(manifest.capabilities, 'manifest.capabilities'))) {
    if (!Object.hasOwn(CAPABILITIES, kind)) {
      throw new ManifestError(`manifest.capabilities: unknown capability "${kind}"; known: ${CAPABILITY_KINDS.filter((k) => k !== 'route').join(', ')}`);
    }
    capabilities[kind] = CAPABILITIES[kind as CapabilityKind].parse(declaration, `manifest.capabilities.${kind}`);
  }
  const runtime = manifest.runtime ?? null;
  if (runtime !== null && !(RUNTIME_KINDS as readonly unknown[]).includes(runtime)) {
    throw new ManifestError(`manifest.runtime must be one of ${RUNTIME_KINDS.join(', ')}, got ${JSON.stringify(runtime)}`);
  }
  const entry = manifest.entry ?? null;
  if (entry !== null && (typeof entry !== 'string' || entry === '' || entry.startsWith('/') || entry.includes('..'))) {
    throw new ManifestError(`manifest.entry must be a relative file path, got ${JSON.stringify(entry)}`);
  }
  if (entry !== null && runtime !== 'isolate') throw new ManifestError('manifest.entry is only for runtime "isolate"');
  return {
    contract: 1, capabilities: capabilities as Capabilities,
    ...(runtime !== null && { runtime: runtime as RuntimeKind }),
    ...(runtime === 'isolate' && { entry: entry ?? DEFAULT_ENTRY }),
  };
}

export function declaredKinds(manifest: Manifest): CapabilityKind[] {
  return Object.keys(manifest.capabilities) as CapabilityKind[];
}

/** sha256 hex of JSON with object keys sorted at every depth, so key order never changes the hash. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function releaseKey(image: ImageId | null, manifest: Manifest, bundle: BundleId | null): string {
  return canonicalHash({ image, manifest, bundle });
}

// Entities (DESIGN.md 1.2). Times are epoch milliseconds.

export type AppStatus = 'registered' | 'removed' | 'purging';
export const ACCESS_LEVELS = ['tenant', 'org', 'public'] as const;
/** Who may reach the app (ADR 0022 item 6); orthogonal to the manifest's `identity`. */
export type Access = (typeof ACCESS_LEVELS)[number];

export type App = {
  readonly name: AppName;
  readonly id: AppId;
  readonly tenant: TenantName;
  readonly access: Access;
  readonly owner: Subject;
  readonly status: AppStatus;
  /** Null between the first publish's App insert and its commit; the address answers 404 meanwhile. */
  readonly current: ReleaseNumber | null;
  readonly policyOverride: PolicyOverride;
  /** When the status last became registered; a republish after remove starts schedules here. */
  readonly registeredAt: number;
  /** Raised by the store on every write of the app's rows (app, release, trigger, binding); a reader applies only a newer one (ADR 0025 item 5). */
  readonly version: number;
};

export type Release = {
  readonly app: AppId;
  readonly number: ReleaseNumber;
  readonly image: ImageId | null;
  readonly manifest: Manifest;
  readonly bundle: BundleId | null;
  /** Null for a static-only release. */
  readonly runtime: RuntimeKind | null;
  readonly releaseKey: string;
  readonly publishedAt: number;
};

/** Provider-private record: volume name, database and password, ACL user, bucket and keys. */
export type Resource = Readonly<Record<string, string>>;
export type BindingState = 'active' | 'suspended';

export type Binding = {
  readonly app: AppId;
  readonly kind: ResourceKind;
  readonly provider: ProviderName;
  /** The row is the truth; the provider's backend converges to it. */
  readonly state: BindingState;
  readonly resource: Resource;
};

/** Field names are the admin API's wire names. */
export type Policy = {
  readonly idle_seconds: number;
  readonly ready_timeout_seconds: number;
  readonly drain_timeout_seconds: number;
  readonly connection_idle_seconds: number;
  readonly trigger_timeout_seconds: number;
  readonly db_backend: DbBackend;
  /** Failure handling (ADR 0017): a crash, hang or failed wake is a failure; `max_failures` within `failure_window_seconds` quarantines the app; a wake after a failure waits `restart_backoff_seconds`. */
  readonly max_failures: number;
  readonly failure_window_seconds: number;
  readonly restart_backoff_seconds: number;
  /** Instance shape (ADR 0023): thousandths of a core and MiB. */
  readonly cpu_millis: number;
  readonly memory_mb: number;
  /** Global only; cron schedules are read in it. */
  readonly timezone: string;
  /** Global only (ADR 0024). */
  readonly usage_retention_days: number;
  readonly events_retention_days: number;
  readonly events_max_rows: number;
};
export const GLOBAL_ONLY_POLICY = ['timezone', 'usage_retention_days', 'events_retention_days', 'events_max_rows'] as const;
export type PolicyOverride = Partial<Omit<Policy, (typeof GLOBAL_ONLY_POLICY)[number]>>;
/** A per-app policy change; null clears that override field. */
export type PolicyPatch = { readonly [K in keyof PolicyOverride]?: PolicyOverride[K] | null };

export const DEFAULT_POLICY: Policy = {
  idle_seconds: 60,
  ready_timeout_seconds: 15,
  drain_timeout_seconds: 30,
  connection_idle_seconds: 21600,
  trigger_timeout_seconds: 600,
  db_backend: 'sqlite',
  max_failures: 3,
  failure_window_seconds: 60,
  restart_backoff_seconds: 5,
  cpu_millis: 1000,
  memory_mb: 512,
  timezone: 'UTC',
  usage_retention_days: 90,
  events_retention_days: 14,
  events_max_rows: 1_000_000,
};

/** Merged on every read and never stored, so a global change reaches every app without an override at once. */
export function effectivePolicy(global: Policy, override: PolicyOverride): Policy {
  const set = Object.entries(override).filter(([, value]) => value !== undefined);
  return { ...global, ...Object.fromEntries(set) };
}

export type Trigger = {
  readonly app: AppId;
  readonly name: TriggerName;
  /** Null means on demand only. */
  readonly schedule: CronExpr | null;
};

export type DeliveryState = 'due' | 'delivering' | 'done' | 'failed' | 'cancelled';

export type Delivery = {
  readonly id: DeliveryId;
  readonly app: AppId;
  readonly trigger: TriggerName;
  /** Set for scheduled deliveries; (app, trigger, scheduledFor) is unique. */
  readonly scheduledFor: number | null;
  /** Set for on-demand deliveries. */
  readonly caller: Subject | null;
  readonly idempotencyKey: string | null;
  readonly body: Uint8Array;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly createdAt: number;
  /** The replica that claimed it for its current attempt; null until the first claim. */
  readonly replica: ReplicaId | null;
};

/** A service token's subject is `service:<tenant>.<label>`, a personal token's is its issuer's `user:<id>` (ADR 0022 item 2). */
export type Token = {
  readonly id: string;
  readonly tenant: TenantName;
  readonly subject: Subject;
  readonly label: string;
  /** sha256 hex of the secret; the secret itself is shown once and never stored. */
  readonly hash: string;
  readonly createdBy: Subject | 'local';
  readonly createdAt: number;
  readonly revokedAt: number | null;
};

// Tenants and quotas (ADR 0022, 0023)

export const QUOTA_RESOURCES = ['apps', 'awake', 'cpu_millis', 'memory_mb', 'storage_gb'] as const;
export type QuotaResource = (typeof QUOTA_RESOURCES)[number];
/** Null is unlimited. */
export type Quota = { readonly [R in QuotaResource]: number | null };
export type QuotaUsage = { readonly [R in QuotaResource]: number };
/** Copied into a tenant when it is created; changing it leaves existing tenants as they are. */
export const DEFAULT_QUOTA: Quota = { apps: 100, awake: 20, cpu_millis: 20000, memory_mb: 10240, storage_gb: 20 };

export type Refusal = { readonly resource: QuotaResource; readonly used: number; readonly limit: number; readonly ask: number };

/** The one quota rule, at publish and at wake: refused when `used + ask` passes a limit. */
export function admits(quota: Quota, used: QuotaUsage, ask: Partial<QuotaUsage>): Refusal | null {
  for (const resource of QUOTA_RESOURCES) {
    const limit = quota[resource];
    const more = ask[resource];
    if (more === undefined || limit === null) continue;
    if (used[resource] + more > limit) return { resource, used: used[resource], limit, ask: more };
  }
  return null;
}

/** Publish answers 409 with `quota`; a wake answers 503 with Retry-After. */
export class QuotaExceeded extends Conflict {
  readonly tenant: TenantName;
  readonly refusal: Refusal;
  constructor(tenant: TenantName, refusal: Refusal) {
    super(`tenant "${tenant}" is at its ${refusal.resource} quota: ${refusal.used} used + ${refusal.ask} asked > ${refusal.limit}`);
    this.tenant = tenant;
    this.refusal = refusal;
  }
}

export type Tenant = { readonly name: TenantName; readonly display: string; readonly quota: Quota; readonly createdAt: number };
export type User = {
  /** The subject without `user:`. */
  readonly id: string;
  readonly name: string;
  /** As last seen from the upstream; shown, never used to authorize. */
  readonly groups: readonly string[];
  readonly firstSeen: number;
  readonly lastSeen: number;
};
export type Role = 'admin' | 'member';
export type Membership = { readonly tenant: TenantName; readonly user: string; readonly role: Role };

/** Who did it, as the audit row and the admin boundary record it (ADR 0022 item 7). */
export type Actor =
  | { readonly via: 'upstream'; readonly subject: Subject; readonly name: string }
  | { readonly via: 'token'; readonly subject: Subject; readonly token: string; readonly createdBy: Subject | 'local' }
  | { readonly via: 'local' };
/** Built once per request by authentication; nothing downstream looks identity up again. A token's roles are narrowed to its tenant and capped at member. */
export type Caller = {
  readonly actor: Actor;
  readonly platformAdmin: boolean;
  readonly roles: ReadonlyMap<TenantName, Role>;
  readonly viaToken: boolean;
};

export type BundleFile = { readonly size: number; readonly etag: string; readonly contentType: string };
/** Paths without a leading slash, relative to `static.dir` in a static bundle and to the app root in a code bundle. */
export type BundleIndex = { readonly id: BundleId; readonly files: Readonly<Record<string, BundleFile>> };

/** What the `stats` table keeps of an app (ADR 0024 item 3); the counts live in `usage`. */
export type Stats = {
  readonly app: AppId;
  readonly lastAccessAt: number | null;
};
/** An app's request and error counts beside its last access: since boot in Ingress, over the last 24 h in the listing. */
export type Traffic = Stats & { readonly requests: number; readonly errors: number };

export type InstanceState = 'asleep' | 'waking' | 'awake' | 'draining' | 'stopping';
/** What a runtime can detect about an instance (ADR 0017); the Guard judges, the runtime only reports. */
export type HealthCheck = 'exit' | 'ready' | 'hang' | 'memory';
export type Quarantine = { readonly reason: string; readonly since: number; readonly failures: number };
/** Decides from lifecycle events whether an app may wake; one implementation over every runtime. */
export interface Guard {
  quarantine(app: AppId): Quarantine | null;
  unquarantine(app: AppId): void;
}
export type LeaseKind = 'request' | 'channel' | 'trigger';

/** A handle the Runtime issued; give it back exactly once with `release`. */
export type Lease = { readonly app: AppId; readonly address: string };

/** A persistent directory an app needs; the runtime realizes `id` (a volume, or a directory in the runner's volume) and replaces `{dir}` in `env` values with where it put it. */
export type StorageBinding = { readonly id: string; readonly target: string; readonly env: Readonly<Record<string, string>> };
/** A platform service an app's provider talks to; a Kubernetes instance gets a `reach.<service>` label per entry (ADR 0019). */
export type ProviderService = 'postgres' | 'redis' | 'object' | 'coturn';
/** Derived from the current Release's bindings at instance creation; never stored. */
export type Injection = {
  readonly env: Readonly<Record<string, string>>;
  readonly storage: readonly StorageBinding[];
  /** The `service` of every active binding's provider. */
  readonly services: readonly ProviderService[];
};

/** Everything the Runtime needs to run an app; it never reads a Manifest. */
export type RunSpec = {
  readonly app: AppId;
  readonly name: AppName;
  readonly tenant: TenantName;
  readonly release: ReleaseNumber;
  readonly runtime: { readonly kind: 'container'; readonly image: ImageId } | { readonly kind: 'isolate'; readonly bundle: BundleId; readonly entry: string };
  readonly injection: Injection;
  readonly policy: Policy;
  /** The app row's version this spec was built from; a wake against a newer row waits for the refresh (ADR 0020 item 4). */
  readonly version: number;
};

/** Per-app snapshot the Ingress reads; rebuilt after every command that changes the app's rows. */
export type RouteView = {
  readonly app: AppId;
  readonly name: AppName;
  readonly tenant: TenantName;
  readonly access: Access;
  readonly status: AppStatus;
  readonly owner: Subject;
  readonly release: ReleaseNumber | null;
  readonly image: ImageId | null;
  /** Null for a static-only release: nothing to wake. */
  readonly runtime: RuntimeKind | null;
  readonly kinds: ReadonlySet<CapabilityKind>;
  /** Null unless the release declares `static`. */
  readonly bundle: BundleIndex | null;
  /** Prefix a static request resolves under inside `bundle`: '' for a static bundle, `<static.dir>/` for a code bundle. */
  readonly staticRoot: string;
  /** Null when the release does not declare identity. */
  readonly identity: IdentityDeclaration | null;
  readonly policyOverride: PolicyOverride;
  readonly version: number;
};

export type PublishRequest = {
  readonly name: AppName;
  /** Image reference; the Registry resolves it to an id. Null for a static-only manifest. */
  readonly image: string | null;
  readonly manifest: Manifest;
  readonly bundle: BundleId | null;
  /** Required on first publish, ignored after. */
  readonly owner: Subject | null;
  /** Read on first publish only; DEFAULT_TENANT when absent. */
  readonly tenant?: TenantName;
};

export type AppSummary = {
  readonly name: AppName;
  readonly address: string;
  readonly tenant: TenantName;
  readonly access: Access;
  readonly release: ReleaseNumber | null;
  readonly capabilities: readonly CapabilityKind[];
  readonly status: AppStatus;
  readonly instance: InstanceState | 'none';
  /** Epoch ms the instance entered its state; null when none. */
  readonly since: number | null;
  readonly leases: Readonly<Record<LeaseKind, number>>;
  /** Epoch ms the reaper stops an awake instance that holds no lease; null while a lease is held or when not awake. */
  readonly sleepsAt: number | null;
  readonly runtime: RuntimeKind | null;
  readonly quarantine: Quarantine | null;
  /** The engine a declared `db` uses under the app's effective policy; null without `db`. */
  readonly dbBackend: Policy['db_backend'] | null;
  readonly lastAccessAt: number | null;
  /** Over the last 24 hourly `usage` buckets (ADR 0024). */
  readonly requests: number;
  readonly errors: number;
  /** The node the instance runs on; null when asleep or not known. */
  readonly node: string | null;
};

export type StateEntry = Omit<Binding, 'app' | 'resource'> & { readonly location: Readonly<Record<string, string>> };
/** One app's answer on ADMIN_PATHS.state; `bundle` is null for an image release. */
export type StateInventory = {
  readonly app: AppName;
  readonly release: ReleaseNumber | null;
  readonly bundle: BundleId | null;
  readonly bindings: readonly StateEntry[];
};

export type AppDetail = {
  readonly app: App;
  readonly releases: readonly Release[];
  /** Without `resource`, which holds credentials. */
  readonly bindings: readonly Omit<Binding, 'resource'>[];
  readonly policy: Policy;
  readonly instance: InstanceState | 'none';
  readonly stats: Stats;
  readonly deliveries: readonly Delivery[];
  readonly quarantine: Quarantine | null;
};

export type Principal = { readonly subject: Subject; readonly name: string };
/** 303 to the login page for browsers, 401 for other clients. */
export type Challenge = { readonly status: 303; readonly location: string } | { readonly status: 401 };

export type ByteRange = { readonly start: number; readonly end: number };

export type DeliveryFilter = {
  readonly app?: AppId;
  readonly state?: DeliveryState;
  /** nextAttemptAt <= dueBefore */
  readonly dueBefore?: number;
  readonly limit?: number;
};

// Instance state in the platform library (ADR 0020). Written only by compare-and-set on (state, epoch).

/** Pod name under Kubernetes, the host name on a single host. */
export type ReplicaId = Brand<string, 'ReplicaId'>;
/** `leading` is what the replica's last heartbeat said of its own tenure; the cluster view marks the leading gateway with it. */
export type Replica = { readonly id: ReplicaId; readonly startedAt: number; readonly seenAt: number; readonly leading: boolean };

export type Instance = {
  readonly app: AppId;
  readonly runtime: RuntimeKind;
  readonly release: ReleaseNumber;
  readonly specHash: string;
  /** Raised by every wake; a CAS that names an older epoch fails. */
  readonly epoch: number;
  readonly state: InstanceState;
  /** The replica in the middle of a waking or stopping transition. */
  readonly actor: ReplicaId | null;
  readonly handle: string | null;
  readonly address: string | null;
  readonly node: string | null;
  readonly home: string | null;
  readonly since: number;
  readonly awakeAt: number | null;
  /** What this wake took from the tenant's quota; a later policy change does not alter it. */
  readonly cpuMillis: number;
  readonly memoryMb: number;
};

/** One replica's leases on one instance; an app's leases are the sum over replicas at the current epoch. */
export type LeaseTally = {
  readonly app: AppId;
  readonly replica: ReplicaId;
  readonly epoch: number;
  readonly request: number;
  readonly channel: number;
  readonly trigger: number;
  readonly releasedAt: number | null;
};

export type GuardRecord = {
  readonly app: AppId;
  readonly release: ReleaseNumber;
  /** Epoch ms of each failure inside the window. */
  readonly failures: readonly number[];
  readonly quarantineReason: string | null;
  readonly quarantinedAt: number | null;
};

/** `FOR SHARE` or `FOR UPDATE` on PostgreSQL; a SQLite transaction is exclusive already. */
export type RowLock = 'share' | 'update';

// Observability in the platform library (ADR 0024)

export type UsageStep = 60 | 3600;
export const USAGE_COUNTERS = ['requests', 'errors', 'wakes', 'wakeFailures', 'sleeps', 'deliveriesDone', 'deliveriesFailed', 'deliveriesRetried', 'wakeMs', 'awakeMs'] as const;
export type UsageCounters = { readonly [C in (typeof USAGE_COUNTERS)[number]]: number };
/** One replica's absolute counts for one bucket; `app` '*' is the whole platform. */
export type Usage = UsageCounters & {
  readonly app: AppId | '*';
  readonly tenant: TenantName | null;
  readonly step: UsageStep;
  readonly start: number;
  readonly replica: ReplicaId;
};
/** Summed over replicas. */
export type UsageBucket = Omit<Usage, 'replica'>;
export type UsageFilter = {
  readonly step: UsageStep;
  readonly app?: AppId | '*';
  readonly tenant?: TenantName;
  /** Only the apps this subject owns now (ADR 0022 item 5). */
  readonly owner?: Subject;
  /** start >= from and start < to */
  readonly from: number;
  readonly to: number;
};

export type EventRecord = {
  /** Global and increasing; the console's cursor. */
  readonly id: number;
  /** The library's clock. */
  readonly at: number;
  readonly replica: ReplicaId;
  readonly ev: string;
  readonly app: string | null;
  readonly tenant: TenantName | null;
  readonly body: Readonly<Record<string, unknown>>;
};
export type EventFilter = {
  readonly after?: number;
  /** at >= since */
  readonly since?: number;
  readonly ev?: string;
  /** Leaves out rows younger than this on the library's clock, so a concurrent commit with a lower id is not skipped by a cursor. */
  readonly settleMs?: number;
  readonly limit?: number;
  /** The newest this many matching rows instead of the oldest, still returned oldest first. */
  readonly newest?: number;
};
export const EVENT_SETTLE_MS = 2000;

export const AUDIT_ACTIONS = [
  'app.publish', 'app.remove', 'app.purge', 'app.policy', 'app.owner', 'app.access', 'app.move', 'app.unquarantine',
  'policy.global', 'token.issue', 'token.revoke', 'tenant.create', 'tenant.quota', 'member.add', 'member.role', 'member.remove',
  'app.stop', 'app.restart', 'app.kill', 'cluster.scale', 'cluster.restart', 'cluster.drain',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditRecord = {
  readonly id: number;
  readonly at: number;
  readonly actor: Subject | 'local';
  /** The tenant whose role the actor used; null for a platform admin. */
  readonly actorTenant: TenantName | null;
  /** The tenant of what was acted on. */
  readonly tenant: TenantName | null;
  readonly action: AuditAction;
  readonly targetKind: 'app' | 'tenant' | 'token' | 'member' | 'policy' | 'workload' | 'pod' | 'node';
  readonly target: string;
  readonly result: 'started' | 'ok' | 'refused' | 'error';
  /** Never a secret. */
  readonly details: Readonly<Record<string, unknown>>;
};
export type AuditFilter = {
  readonly tenant?: TenantName;
  /** Only rows whose target is an app this subject owns now (ADR 0022 item 5). */
  readonly owner?: Subject;
  readonly from?: number;
  readonly to?: number;
  readonly actor?: string;
  readonly action?: AuditAction;
  readonly target?: string;
  readonly limit?: number;
};

/** The tail of an instance's log kept when it ended, one row per app. */
export type InstanceLog = { readonly app: AppId; readonly release: ReleaseNumber; readonly endedAt: number; readonly reason: string; readonly tail: string };

/** What a committed write touched; on PostgreSQL the NOTIFY payload is `changeKey(change)` (ADR 0025 item 5). */
export type Change =
  | { readonly kind: 'app'; readonly name: AppName }
  | { readonly kind: 'policy' }
  | { readonly kind: 'instance'; readonly app: AppId }
  | { readonly kind: 'tenant'; readonly name: TenantName };

export function changeKey(change: Change): string {
  switch (change.kind) {
    case 'app': return `app/${change.name}`;
    case 'policy': return 'policy';
    case 'instance': return `instance/${change.app}`;
    case 'tenant': return `tenant/${change.name}`;
  }
}

export function parseChange(key: string): Change | null {
  if (key === 'policy') return { kind: 'policy' };
  const [kind, value] = key.split('/', 2);
  if (!value) return null;
  if (kind === 'app') return { kind, name: value as AppName };
  if (kind === 'instance') return { kind, app: value as AppId };
  if (kind === 'tenant') return { kind, name: value as TenantName };
  return null;
}

// Protocols

/** The platform library's rows; one writer per table is a convention the Registry and Scheduler keep, not a type. */
export interface StoreOps {
  app(name: AppName): Promise<App | null>;
  apps(): Promise<App[]>;
  /** Every app with its current release, in one read; the Registry's resync (ADR 0025 item 5). */
  appsWithCurrent(): Promise<{ readonly app: App; readonly release: Release | null }[]>;
  putApp(app: App): Promise<void>;
  /** Deletes the app and its Registry rows (release, trigger, binding); the end of purge. */
  deleteApp(app: AppId): Promise<void>;

  release(app: AppId, number: ReleaseNumber): Promise<Release | null>;
  releases(app: AppId): Promise<Release[]>;
  putRelease(release: Release): Promise<void>;
  /** Whether a release of an app other than `except` references the bundle; one read on the release bundle index (ADR 0028). */
  bundleReferenced(bundle: BundleId, except: AppId): Promise<boolean>;

  triggers(): Promise<Trigger[]>;
  replaceTriggers(app: AppId, triggers: readonly Trigger[]): Promise<void>;

  bindings(app?: AppId): Promise<Binding[]>;
  putBinding(binding: Binding): Promise<void>;

  policy(): Promise<Policy>;
  putPolicy(policy: Policy): Promise<void>;

  /** Revoked tokens included; the caller decides. */
  token(hash: string): Promise<Token | null>;
  tokens(tenant: TenantName): Promise<Token[]>;
  putToken(token: Token): Promise<void>;
  /** False when the token does not exist or was already revoked. */
  revokeToken(id: string, at: number): Promise<boolean>;

  tenant(name: TenantName, lock?: RowLock): Promise<Tenant | null>;
  tenants(): Promise<Tenant[]>;
  putTenant(tenant: Tenant): Promise<void>;
  /** Apps not purging, instances waking to stopping with their recorded cpu and memory, and the provisioned GiB of files and SQLite bindings. */
  quotaUsed(tenant: TenantName): Promise<QuotaUsage>;

  user(id: string): Promise<User | null>;
  putUser(user: User): Promise<void>;
  memberships(filter: { readonly tenant?: TenantName; readonly user?: string }): Promise<Membership[]>;
  putMembership(membership: Membership): Promise<void>;
  deleteMembership(tenant: TenantName, user: string): Promise<void>;

  /** Returns the stored row: an existing one for the same scheduled slot, or the same (app, trigger, idempotencyKey) within IDEMPOTENCY_WINDOW_MS. */
  insertDelivery(delivery: Delivery): Promise<Delivery>;
  updateDelivery(delivery: Delivery): Promise<void>;
  /** Moves a due delivery to delivering for `replica` with `attempts`; false when it was not due any more (ADR 0020 item 4). */
  claimDelivery(id: DeliveryId, replica: ReplicaId, attempts: number): Promise<boolean>;
  deliveries(filter: DeliveryFilter): Promise<Delivery[]>;
  deliveryCounts(): Promise<Record<DeliveryState, number>>;
  lastScheduledFor(app: AppId, trigger: TriggerName): Promise<number | null>;
  deleteDeliveries(app: AppId): Promise<void>;

  stats(): Promise<Stats[]>;
  putStats(stats: readonly Stats[]): Promise<void>;
  deleteStats(app: AppId): Promise<void>;

  replicas(): Promise<Replica[]>;
  putReplica(replica: Replica): Promise<void>;
  /** Deletes replicas not seen since `before` and their lease tallies; returns their ids. */
  sweepReplicas(before: number): Promise<ReplicaId[]>;
  /** A replica's own shutdown: its row and its lease tallies. */
  deleteReplica(id: ReplicaId): Promise<void>;

  instance(app: AppId, lock?: RowLock): Promise<Instance | null>;
  instances(): Promise<Instance[]>;
  /** False when the app already has a row. */
  insertInstance(instance: Instance): Promise<boolean>;
  /** Writes `next` only if the row still has `expected` runtime, state and epoch; false otherwise. */
  casInstance(expected: Pick<Instance, 'runtime' | 'state' | 'epoch'>, next: Instance): Promise<boolean>;
  /** Deletes the app's instance and lease_tally rows; purge cleanup, idempotent (ADR 0020 item 8). */
  deleteInstance(app: AppId): Promise<void>;
  /** Every replica's lease_tally row of the app; the operator's kill (ADR 0026 item 3). */
  deleteLeaseTallies(app: AppId): Promise<void>;

  leaseTallies(app?: AppId): Promise<LeaseTally[]>;
  /** Announces no change (ADR 0020 item 2). */
  putLeaseTally(tally: LeaseTally): Promise<void>;

  guard(app: AppId, lock?: RowLock): Promise<GuardRecord | null>;
  guards(): Promise<GuardRecord[]>;
  putGuard(record: GuardRecord): Promise<void>;
  deleteGuard(app: AppId): Promise<void>;

  /** Upserts absolute counts, so a retried write never counts twice. */
  putUsage(rows: readonly Usage[]): Promise<void>;
  /** Ordered by app, then start. */
  usage(filter: UsageFilter): Promise<UsageBucket[]>;
  sweepUsage(step: UsageStep, before: number): Promise<number>;

  /** `at` is the library's clock. */
  insertEvents(events: readonly Omit<EventRecord, 'id' | 'at'>[]): Promise<void>;
  /** Oldest first. */
  events(filter: EventFilter): Promise<EventRecord[]>;
  /** Deletes events older than `before`, then the oldest beyond `maxRows`; returns how many went. */
  sweepEvents(before: number, maxRows: number): Promise<number>;
  /** Deletes done and cancelled deliveries created before `before`; failed ones stay until purge. */
  sweepDeliveries(before: number): Promise<number>;

  /** Append only: the library refuses any update or delete. Returns the id. */
  insertAudit(record: Omit<AuditRecord, 'id'>): Promise<number>;
  /** Newest first. */
  audit(filter: AuditFilter): Promise<AuditRecord[]>;

  instanceLog(app: AppId): Promise<InstanceLog | null>;
  putInstanceLog(log: InstanceLog): Promise<void>;
}

/** Hides the platform library: SQLite on a single host, PostgreSQL on a cluster (ADR 0025). */
export interface Store extends StoreOps {
  /**
   * `fn` reads and writes only through `tx`; it commits when `fn` resolves and rolls back when it rejects.
   * The effect is as if nothing else ran meanwhile, and `fn` may run more than once, so besides reads and writes through `tx` it makes only idempotent in-memory writes. It must not await network or Docker.
   */
  transaction<T>(fn: (tx: StoreOps) => Promise<T>): Promise<T>;
  /** Runs commands on one name one at a time, across replicas; `fn` may await anything. */
  exclusive<T>(name: AppName, fn: () => Promise<T>): Promise<T>;
  /** Runs work on one bundle one at a time, across replicas; a command takes it after its name and holds one bundle at a time (ADR 0028). */
  exclusiveBundle<T>(bundle: BundleId, fn: () => Promise<T>): Promise<T>;
  /** Called once per changed key after each commit, on every replica. */
  onChange(listener: (change: Change) => void): void;
  /** Called when changes may have been missed; listeners re-read everything. */
  onResync(listener: () => void): void;
  /** Takes the leader lock if it is free: this replica's tenure, or null while another replica leads. SQLite always leads (ADR 0020 item 7). */
  leader(): Promise<Leadership | null>;
}

/** One tenure as the leader (ADR 0020 item 4); once ended it stays ended, and the replica asks `Store.leader` again. */
export interface Leadership {
  held(): boolean;
  /** Called once when the tenure ends other than by `release`: the lock's session died or missed its probe. */
  onLost(listener: () => void): void;
  release(): Promise<void>;
}

/** Hides how instances run: instances, leases, the reaper and their lifecycle. The M2 multi-node seam. */
export interface Runtime {
  readonly kind: RuntimeKind;
  /** Wakes the app if needed. Rejects with NotFound when the app has no RunSpec; any other rejection is a failed wake (502). */
  acquire(app: AppId, kind: 'request' | 'trigger'): Promise<Lease>;
  release(lease: Lease): void;
  /** Turns a request lease into a channel lease; `onRetire` closes it when the instance drains. */
  channel(lease: Lease, onRetire: () => void): void;
  /** Drains and removes the app's container; the next acquire creates one for the current release. */
  retire(app: AppId): Promise<void>;
  /** Removes the instance without draining and puts its row asleep whatever its state and actor, clearing every replica's tally (ADR 0026 item 3). */
  kill(app: AppId): Promise<void>;
  /** Startup: adopt or remove containers by label, then follow Docker events. */
  reconcile(): Promise<void>;
  state(app: AppId): InstanceState | 'none';
  /** Epoch ms of the instance's last state change; null when none. */
  since(app: AppId): number | null;
  leases(app: AppId): Readonly<Record<LeaseKind, number>>;
  sleepsAt(app: AppId): number | null;
  /** The last `tail` lines of stdout and stderr of the app's current or last container; empty when it has none. */
  logs(app: AppId, tail: number): Promise<string>;
  /** What this runtime detects; it reports failures as lifecycle events. */
  health(): readonly HealthCheck[];
  /** Deletes what the runtime realized for a StorageBinding id; the end of a storage provider's destroy. */
  destroyStorage(app: AppId, id: string): Promise<void>;
}

export type NodeResources = { readonly cpuMillis: number; readonly memoryBytes: number; readonly pods: number };
/** A Pod carrying a `pneuma-space.role` label in a platform namespace; `leading` marks the gateway replica that leads (ADR 0026 item 2). */
export type PlatformPod = {
  readonly name: string;
  readonly role: string;
  readonly app: AppId | null;
  readonly ip: string | null;
  readonly phase: string;
  readonly ready: boolean;
  readonly restarts: number;
  readonly node: string | null;
  readonly startedAt: number | null;
  readonly leading: boolean;
};
/** One cluster node (ADR 0024 item 8); `requested` sums the platform's own Pods on it, not every Pod. */
export type NodeSample = {
  readonly name: string;
  readonly ready: boolean;
  readonly schedulable: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly taints: readonly { readonly key: string; readonly value?: string; readonly effect: string }[];
  readonly allocatable: NodeResources;
  readonly requested: NodeResources;
  readonly pods: readonly PlatformPod[];
};

export type Plane = 'docker' | 'kubernetes';
/** A platform Deployment or StatefulSet, or a compose service with no Pods (ADR 0026 item 2). */
export type Workload = {
  readonly name: string;
  readonly role: string;
  readonly kind: 'Deployment' | 'StatefulSet' | 'service';
  readonly desired: number;
  readonly ready: number;
  readonly scalable: boolean;
  readonly image: string | null;
  readonly pods: readonly PlatformPod[];
};
/** An instance row joined to its Pod; `pod` is the container id on a single host. */
export type InstanceRow = {
  readonly app: AppName;
  readonly tenant: TenantName;
  readonly runtime: RuntimeKind;
  readonly state: InstanceState;
  readonly since: number;
  readonly actor: ReplicaId | null;
  readonly node: string | null;
  readonly pod: string | null;
  readonly leases: Readonly<Record<LeaseKind, number>>;
  readonly requests: number;
  readonly restarts: number | null;
  /** What this wake took (the instance row's cpu_millis and memory_mb); a policy change applies from the next wake. */
  readonly cpuMillis: number;
  readonly memoryMb: number;
};
export type VolumeRow = {
  readonly app: AppName;
  readonly name: string;
  readonly sizeGb: number | null;
  readonly storageClass: string | null;
  readonly phase: string | null;
  readonly node: string | null;
};
/** What Infra lists: the app by id, named by the sampler. */
export type VolumeSample = Omit<VolumeRow, 'app'> & { readonly app: AppId };
/** A `type=Warning` Event of the last hour in a platform namespace. */
export type Warning = {
  readonly at: number;
  readonly kind: 'Pod' | 'Node' | 'PersistentVolumeClaim';
  readonly object: string;
  readonly reason: string;
  readonly message: string;
  readonly count: number;
};
export type HostSample = {
  readonly cpus: number;
  readonly load: readonly number[];
  readonly memory: { readonly totalBytes: number; readonly freeBytes: number };
  /** The filesystem holding the platform data directory. */
  readonly data: { readonly totalBytes: number; readonly freeBytes: number } | null;
};
type Amounts = { readonly cpuMillis: number; readonly memoryBytes: number; readonly pods: number | null };
/** One node of the node view (ADR 0024 item 8). */
export type NodeEntry = {
  readonly name: string;
  readonly ready: boolean;
  readonly schedulable: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly taints: NodeSample['taints'];
  readonly allocatable: Amounts;
  readonly requested: Amounts;
  readonly gateways: readonly { readonly pod: string; readonly ready: boolean }[];
  readonly runner: { readonly pod: string; readonly ready: boolean; readonly restarts: number | null; readonly workers: number | null; readonly stuck: number | null } | null;
  readonly instances: readonly { readonly app: AppName; readonly runtime: RuntimeKind | null; readonly state: InstanceState }[];
};
/** ADMIN_PATHS.cluster, answered from the sampler's memory (ADR 0026 item 1). */
export type ClusterView = {
  readonly plane: Plane;
  readonly sampledAt: number | null;
  readonly nodes: readonly NodeEntry[];
  readonly workloads: readonly Workload[];
  readonly instances: readonly InstanceRow[];
  readonly volumes: readonly VolumeRow[];
  readonly warnings: readonly Warning[];
  /** PNEUMA_SPACE_SCALE_MAX: the highest replica count `cluster.scale` accepts. */
  readonly scaleMax: number;
};
/** What the sampler holds; the admin API adds `scaleMax` from configuration. */
export type ClusterSample = Omit<ClusterView, 'scaleMax'>;

/** What the plane answers for publish, the nodes view and the cluster page, whatever runtime an app uses. */
export interface Infra {
  resolveImage(reference: string): Promise<ImageId | null>;
  /** The cluster's nodes with the platform's Pods on them; null on a single host. */
  nodes(): Promise<NodeSample[] | null>;
  workloads(): Promise<Workload[]>;
  volumes(): Promise<VolumeSample[]>;
  warnings(): Promise<Warning[]>;
  /** Only a `scalable` workload; Conflict otherwise, and NotOnThisPlane on a single host. */
  scale(name: string, replicas: number): Promise<void>;
  /** Only a gateway or runner Pod, by its uid so a replacement under the same name stays; Conflict otherwise. */
  deletePod(name: string): Promise<void>;
}

/** An operation the cluster page offers that a single host does not have. */
export class NotOnThisPlane extends Conflict {
  constructor(what: string) {
    super(`${what} needs the kubernetes plane`);
  }
}

/** Hides one backend for one resource kind. Every method is idempotent. */
export interface CapabilityProvider {
  readonly kind: ResourceKind;
  readonly name: ProviderName;
  /** The platform service an instance with this binding must reach; null when none. */
  readonly service: ProviderService | null;
  /** Creates or converges the resource and re-enables it if suspended; `current` is the binding's last record. Throws Conflict when the backend is not running. */
  ensure(app: AppId, current: Resource | null): Promise<Resource>;
  inject(app: AppId, resource: Resource): Omit<Injection, 'services'>;
  /** Where the resource's data lives, without credentials (ADR 0024 item 10). */
  location(resource: Resource): Readonly<Record<string, string>>;
  suspend(app: AppId, resource: Resource): Promise<void>;
  destroy(app: AppId, resource: Resource): Promise<void>;
}

/** Hides how a request's caller is identified (local stub in M1, OIDC in M2). */
export interface IdentityProvider {
  /** Serves the gateway-root pages under /_pneuma-space/ (login, logout). */
  serve(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/** Hides where static bundles live (object store `pneuma-space-bundles/<id>/`). */
export interface BundleStore {
  put(tar: Readable): Promise<BundleId>;
  index(id: BundleId): Promise<BundleIndex>;
  open(id: BundleId, path: string, range: ByteRange | null): Promise<Readable>;
  delete(id: BundleId): Promise<void>;
}

export type InvokeRequest = {
  readonly app: AppId;
  readonly trigger: TriggerName;
  readonly caller: Subject;
  readonly idempotencyKey: string | null;
  readonly body: Uint8Array;
};

/** Hides cron and delivery: every trigger call is a durable Delivery before any attempt. */
export interface Scheduler {
  /** Throws NotFound when the app's current release does not declare the trigger. */
  invoke(request: InvokeRequest): Promise<DeliveryId>;
  /** Re-reads the app's triggers; cancels deliveries of undeclared triggers and of removed apps, and deletes those of purged apps. */
  reload(app: AppId): Promise<void>;
  /** Startup: delivering rows return to due, then the loop and worker start. */
  resume(): Promise<void>;
}

/** What the Scheduler reads about one app. */
export type SchedulerView = {
  readonly status: AppStatus;
  /** The later of the current Release's publishedAt and the app's registeredAt: no slot at or before it is materialized. */
  readonly publishedAt: number;
  readonly triggers: readonly Trigger[];
  /** Effective policy (global merged with the app's override). */
  readonly policy: Policy;
};

/** The secret appears here once; the store keeps only its hash. */
export type IssuedToken = { readonly id: string; readonly token: string; readonly subject: Subject };

/** Hides the platform rows behind commands; the only writer of everything but Delivery and Stats. */
export interface Registry {
  publish(request: PublishRequest): Promise<Release>;
  remove(name: AppName): Promise<void>;
  /** Only from removed; otherwise Conflict. */
  purge(name: AppName): Promise<void>;
  setGlobalPolicy(patch: Partial<Policy>): Promise<Policy>;
  setAppPolicy(name: AppName, patch: PolicyPatch): Promise<PolicyOverride>;
  setOwner(name: AppName, owner: Subject): Promise<void>;
  /** `local` only: a service token in DEFAULT_TENANT (ADR 0022 item 4). */
  issueToken(name: string): Promise<IssuedToken>;
  /** Copies DEFAULT_QUOTA; `admins` are user ids, at least one. */
  createTenant(name: TenantName, display: string, admins: readonly string[]): Promise<Tenant>;
  setQuota(tenant: TenantName, patch: Readonly<Record<string, unknown>>): Promise<Quota>;
  /** `force` lets a platform admin leave a tenant without an admin; otherwise demoting or removing the last one is a Conflict. */
  setMember(tenant: TenantName, user: string, role: Role, force: boolean): Promise<void>;
  removeMember(tenant: TenantName, user: string, force: boolean): Promise<void>;
  issueTenantToken(tenant: TenantName, subject: Subject, label: string, createdBy: Subject | 'local'): Promise<IssuedToken>;
  revokeToken(tenant: TenantName, id: string): Promise<void>;
  setAccess(name: AppName, access: Access): Promise<void>;
  /** Retires the instance, then moves the row, so quota, labels and tokens switch at once (ADR 0022 item 3). */
  moveApp(name: AppName, tenant: TenantName): Promise<void>;
  /** Retires the instance; the next request wakes it (ADR 0026 item 3). */
  stop(name: AppName): Promise<void>;
  /** Retires the instance and wakes it again at once. */
  restart(name: AppName): Promise<void>;
  /** Runtime.kill, outside the command lock so a command stuck on the instance cannot hold it back. */
  kill(name: AppName): Promise<void>;
  /** Stops every instance the sampler places on `node`, one at a time, past a failure. */
  drain(node: string): Promise<{ readonly stopped: readonly AppName[]; readonly failed: readonly { readonly app: AppName; readonly error: string }[] }>;
  view(name: AppName): RouteView | null;
  nameOf(id: AppId): AppName | null;
  /** The global snapshot; merge with a RouteView's override via effectivePolicy. */
  policy(): Policy;
  runSpec(app: AppId): RunSpec | null;
  /** Null once the app is purged. */
  schedule(app: AppId): SchedulerView | null;
  listing(): Promise<AppSummary[]>;
  detail(name: AppName): Promise<AppDetail | null>;
  /** Called after every committed change to an app, the end of purge included; main wires it to Runtime.retire, Scheduler.reload and Ingress.forget. */
  onAppChanged(listener: (app: AppId) => void): void;
  /** Startup: continues interrupted purges and re-runs ensure or suspend on every binding per its state (DESIGN 2.3 重启). */
  resume(): Promise<void>;
}

// Protocol constants (docs/app-contract.md)

export const APP_PORT = 8000;
export const INGRESS_PORT = 8080;
export const ADMIN_PORT = 8081;
export const FILES_DIR = '/data';
export const APPS_PATH = '/apps';
export const RESERVED_SEGMENT = '_pneuma-space';
export const TRIGGER_PATH = `/${RESERVED_SEGMENT}/trigger/`;
export const LOGIN_PATH = `/${RESERVED_SEGMENT}/login`;
export const LOGOUT_PATH = `/${RESERVED_SEGMENT}/logout`;
export const RESERVED_HEADER_PREFIX = 'x-pneuma-space-';
export const MAX_ATTEMPTS = 5;
export const TRIGGER_BODY_LIMIT = 64 * 1024;
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const HEADERS = {
  prefix: 'x-forwarded-prefix',
  subject: 'x-pneuma-space-subject',
  name: 'x-pneuma-space-name',
  owner: 'x-pneuma-space-owner',
  delivery: 'x-pneuma-space-delivery',
  attempt: 'x-pneuma-space-attempt',
  scheduledFor: 'x-pneuma-space-scheduled-for',
  idempotencyKey: 'idempotency-key',
} as const;

export const ADMIN_PATHS = {
  /** Unauthenticated liveness for probes (ADR 0022 item 5). */
  healthz: '/healthz',
  health: '/api/health',
  apps: '/api/apps',
  metrics: '/api/metrics',
  requests: '/api/requests',

  cluster: '/api/cluster',
  scale: (workload: string) => `/api/cluster/workloads/${workload}/scale`,
  restartPod: (pod: string) => `/api/cluster/pods/${pod}/restart`,
  drain: (node: string) => `/api/cluster/nodes/${node}/drain`,
  usage: '/api/usage',
  usageApps: '/api/usage/apps',
  audit: '/api/audit',
  bundles: '/api/bundles',
  policy: '/api/policy',
  tokens: '/api/tokens',
  app: (name: string) => `/api/apps/${name}`,
  logs: (name: string) => `/api/apps/${name}/logs`,
  state: (name: string) => `/api/apps/${name}/state`,
  states: '/api/state',
  release: (name: string) => `/api/apps/${name}/release`,
  appPolicy: (name: string) => `/api/apps/${name}/policy`,
  owner: (name: string) => `/api/apps/${name}/owner`,
  remove: (name: string) => `/api/apps/${name}/remove`,
  purge: (name: string) => `/api/apps/${name}/purge`,
  unquarantine: (name: string) => `/api/apps/${name}/unquarantine`,
  stop: (name: string) => `/api/apps/${name}/stop`,
  restart: (name: string) => `/api/apps/${name}/restart`,
  kill: (name: string) => `/api/apps/${name}/kill`,
  access: (name: string) => `/api/apps/${name}/access`,
  move: (name: string) => `/api/apps/${name}/tenant`,
  me: '/api/me',
  tenants: '/api/tenants',
  quota: (tenant: string) => `/api/tenants/${tenant}/quota`,
  members: (tenant: string) => `/api/tenants/${tenant}/members`,
  member: (tenant: string, user: string) => `/api/tenants/${tenant}/members/${user}`,
  tenantTokens: (tenant: string) => `/api/tenants/${tenant}/tokens`,
  tenantToken: (tenant: string, id: string) => `/api/tenants/${tenant}/tokens/${id}`,
} as const;
