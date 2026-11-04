// Shared contract of the gateway. Every component codes against these types; DESIGN.md is the source.
//
// Usage the types are derived from (DESIGN.md 2.2 to 2.4):
//
// publish (admin.ts, PUT /api/apps/<name>/release):
//   const manifest = parseManifest(body.manifest);                  // ManifestError -> 400
//   const release = await registry.publish({ name: appName(raw), image: body.image, manifest,
//     bundle: body.bundle && bundleId(body.bundle), owner: body.owner && subject(body.owner) });
//   // inside: runtime.resolveImage -> provider.ensure per resource kind -> store.transaction(...)
//   //         -> provider.suspend for undeclared kinds -> RouteView rebuilt -> AppChanged listeners
//
// ingress (8080, /apps/<name>/<rest>):
//   const view = registry.view(name);                               // null or removed -> 404
//   if (rest starts with RESERVED_SEGMENT) scheduler.invoke({ app: view.app, trigger, caller, ... });
//   else if (view.bundle?.files[path]) bundles.open(view.bundle.id, path, range);
//   else { const who = await identity.authenticate(req);            // when view.kinds has 'identity'
//          const lease = await runtime.acquire(view.app, 'request');
//          proxy to lease.address; on 101 or text/event-stream runtime.channel(lease, close1001);
//          runtime.release(lease); }
//
// scheduler worker:
//   const [d] = store.deliveries({ state: 'due', dueBefore: now, limit: 1 });
//   const lease = await runtime.acquire(d.app, 'trigger');
//   POST lease.address + TRIGGER_PATH + d.trigger with HEADERS.delivery, attempt, scheduledFor;
//   runtime.release(lease); store.updateDelivery({ ...d, state: 'done' | 'due' | 'failed' });

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

export function triggerName(raw: string): TriggerName {
  if (!NAME_PATTERN.test(raw)) throw new InputError(`trigger name "${raw}" must match ${NAME_PATTERN.source}`);
  return raw as TriggerName;
}

export function subject(raw: string): Subject {
  if (!/^(user|service):[A-Za-z0-9._@-]{1,64}$/.test(raw)) {
    throw new InputError(`subject "${raw}" must be user:<id> or service:<id>, id of letters, digits and ._@-`);
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
  readonly needsImage: boolean;
  /** Provider implementations; non-empty exactly for resource kinds. */
  readonly providers: readonly string[];
  readonly parse: (raw: unknown, where: string) => unknown;
};

/** The only capability list. Env names, providers to call and gateway flags derive from it. */
export const CAPABILITIES = {
  route:    { class: 'ingress',  needsImage: false, providers: [],                     parse: implicit },
  files:    { class: 'resource', needsImage: true,  providers: ['volume'],             parse: empty },
  db:       { class: 'resource', needsImage: true,  providers: ['sqlite', 'postgres'], parse: empty },
  kv:       { class: 'resource', needsImage: true,  providers: ['redis'],              parse: empty },
  object:   { class: 'resource', needsImage: true,  providers: ['s3'],                 parse: empty },
  static:   { class: 'ingress',  needsImage: false, providers: [],                     parse: parseStatic },
  ws:       { class: 'ingress',  needsImage: true,  providers: [],                     parse: empty },
  cron:     { class: 'schedule', needsImage: true,  providers: [],                     parse: parseCron },
  identity: { class: 'ingress',  needsImage: true,  providers: [],                     parse: parseIdentity },
  rtc:      { class: 'resource', needsImage: true,  providers: ['coturn'],             parse: empty },
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

/** Set by the Runtime on every app container, declared or not. */
export const RUNTIME_ENV = ['PNEUMA_SPACE_APP', 'PNEUMA_SPACE_RELEASE'] as const;

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
export type Manifest = { readonly contract: 1; readonly capabilities: Capabilities };

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
  onlyKeys(manifest, ['contract', 'capabilities'], 'manifest');
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
  return { contract: 1, capabilities: capabilities as Capabilities };
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

export type App = {
  readonly name: AppName;
  readonly id: AppId;
  readonly owner: Subject;
  readonly status: AppStatus;
  /** Null between the first publish's App insert and its commit; the address answers 404 meanwhile. */
  readonly current: ReleaseNumber | null;
  readonly policyOverride: PolicyOverride;
  /** When the status last became registered; a republish after remove starts schedules here. */
  readonly registeredAt: number;
};

export type Release = {
  readonly app: AppId;
  readonly number: ReleaseNumber;
  readonly image: ImageId | null;
  readonly manifest: Manifest;
  readonly bundle: BundleId | null;
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
  /** Global only; cron schedules are read in it. */
  readonly timezone: string;
};
export type PolicyOverride = Partial<Omit<Policy, 'timezone'>>;
/** A per-app policy change; null clears that override field. */
export type PolicyPatch = { readonly [K in keyof PolicyOverride]?: PolicyOverride[K] | null };

export const DEFAULT_POLICY: Policy = {
  idle_seconds: 60,
  ready_timeout_seconds: 15,
  drain_timeout_seconds: 30,
  connection_idle_seconds: 21600,
  trigger_timeout_seconds: 600,
  db_backend: 'sqlite',
  timezone: 'UTC',
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
};

export type Token = {
  readonly id: string;
  readonly subject: Subject;
  /** sha256 hex of the secret; the secret itself is shown once and never stored. */
  readonly hash: string;
  readonly createdAt: number;
};

export type BundleFile = { readonly size: number; readonly etag: string; readonly contentType: string };
/** Paths are relative to `static.dir`, without a leading slash. */
export type BundleIndex = { readonly id: BundleId; readonly files: Readonly<Record<string, BundleFile>> };

export type Stats = {
  readonly app: AppId;
  readonly requests: number;
  readonly errors: number;
  readonly lastAccessAt: number | null;
};

export type InstanceState = 'asleep' | 'waking' | 'awake' | 'draining' | 'stopping';
export type LeaseKind = 'request' | 'channel' | 'trigger';

/** A handle the Runtime issued; give it back exactly once with `release`. */
export type Lease = { readonly app: AppId; readonly address: string };

export type Mount = { readonly volume: string; readonly target: string };
/** Derived from the current Release's bindings at container creation; never stored. */
export type Injection = { readonly env: Readonly<Record<string, string>>; readonly mounts: readonly Mount[] };

/** Everything the Runtime needs to run an app; it never reads a Manifest. */
export type RunSpec = {
  readonly app: AppId;
  readonly name: AppName;
  readonly release: ReleaseNumber;
  readonly image: ImageId;
  readonly injection: Injection;
  readonly policy: Policy;
};

/** Per-app snapshot the Ingress reads; rebuilt after every command that changes the app's rows. */
export type RouteView = {
  readonly app: AppId;
  readonly name: AppName;
  readonly status: AppStatus;
  readonly owner: Subject;
  readonly release: ReleaseNumber | null;
  readonly image: ImageId | null;
  readonly kinds: ReadonlySet<CapabilityKind>;
  readonly bundle: BundleIndex | null;
  /** Null when the release does not declare identity. */
  readonly identity: IdentityDeclaration | null;
  readonly policyOverride: PolicyOverride;
};

export type PublishRequest = {
  readonly name: AppName;
  /** Image reference; the Registry resolves it to an id. Null for a static-only manifest. */
  readonly image: string | null;
  readonly manifest: Manifest;
  readonly bundle: BundleId | null;
  /** Required on first publish, ignored after. */
  readonly owner: Subject | null;
};

export type AppSummary = {
  readonly name: AppName;
  readonly address: string;
  readonly release: ReleaseNumber | null;
  readonly capabilities: readonly CapabilityKind[];
  readonly status: AppStatus;
  readonly instance: InstanceState | 'none';
  readonly lastAccessAt: number | null;
  readonly requests: number;
  readonly errors: number;
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
};

export type Principal = { readonly subject: Subject; readonly name: string };
/** 303 to the login page for browsers, 401 for other clients. */
export type Challenge = { readonly status: 303; readonly location: string } | { readonly status: 401 };

export type ByteRange = { readonly start: number; readonly end: number };

/** Compose services a provider administers through `Runtime.runJob`. */
export type InfraService = 'postgres' | 'redis';
export type Job = { readonly service: InfraService; readonly argv: readonly string[]; readonly stdin?: string };
export type JobResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export type DeliveryFilter = {
  readonly app?: AppId;
  readonly state?: DeliveryState;
  /** nextAttemptAt <= dueBefore */
  readonly dueBefore?: number;
  readonly limit?: number;
};

// Protocols

/** Hides the platform library (SQLite in M1). Synchronous; one writer per table is a convention the Registry and Scheduler keep, not a type. */
export interface Store {
  transaction<T>(fn: () => T): T;

  app(name: AppName): App | null;
  apps(): App[];
  putApp(app: App): void;
  /** Deletes the app and its Registry rows (release, trigger, binding); the end of purge. */
  deleteApp(app: AppId): void;

  release(app: AppId, number: ReleaseNumber): Release | null;
  releases(app: AppId): Release[];
  putRelease(release: Release): void;

  triggers(): Trigger[];
  replaceTriggers(app: AppId, triggers: readonly Trigger[]): void;

  bindings(app?: AppId): Binding[];
  putBinding(binding: Binding): void;

  policy(): Policy;
  putPolicy(policy: Policy): void;

  token(hash: string): Token | null;
  putToken(token: Token): void;

  /** Returns the stored row: an existing one for the same scheduled slot, or the same (app, trigger, idempotencyKey) within IDEMPOTENCY_WINDOW_MS. */
  insertDelivery(delivery: Delivery): Delivery;
  updateDelivery(delivery: Delivery): void;
  deliveries(filter: DeliveryFilter): Delivery[];
  lastScheduledFor(app: AppId, trigger: TriggerName): number | null;
  deleteDeliveries(app: AppId): void;

  stats(): Stats[];
  putStats(stats: readonly Stats[]): void;
  deleteStats(app: AppId): void;
}

/** Hides Docker: instances, leases, the reaper and container lifecycle. The M2 multi-node seam. */
export interface Runtime {
  /** Wakes the app if needed. Rejects with NotFound when the app has no RunSpec; any other rejection is a failed wake (502). */
  acquire(app: AppId, kind: 'request' | 'trigger'): Promise<Lease>;
  release(lease: Lease): void;
  /** Turns a request lease into a channel lease; `onRetire` closes it when the instance drains. */
  channel(lease: Lease, onRetire: () => void): void;
  /** Drains and removes the app's container; the next acquire creates one for the current release. */
  retire(app: AppId): Promise<void>;
  /** Startup: adopt or remove containers by label, then follow Docker events. */
  reconcile(): Promise<void>;
  state(app: AppId): InstanceState | 'none';
  runJob(job: Job): Promise<JobResult>;
  resolveImage(reference: string): Promise<ImageId | null>;
  ensureVolume(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
}

/** Hides one backend for one resource kind. Every method is idempotent. */
export interface CapabilityProvider {
  readonly kind: ResourceKind;
  readonly name: ProviderName;
  /** Creates or converges the resource and re-enables it if suspended; `current` is the binding's last record. Throws Conflict when the backend is not running. */
  ensure(app: AppId, current: Resource | null): Promise<Resource>;
  inject(app: AppId, resource: Resource): Injection;
  suspend(app: AppId, resource: Resource): Promise<void>;
  destroy(app: AppId, resource: Resource): Promise<void>;
}

/** Hides how a request's caller is identified (local stub in M1, OIDC in M2). */
export interface IdentityProvider {
  authenticate(request: IncomingMessage): Promise<Principal | Challenge>;
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
  invoke(request: InvokeRequest): DeliveryId;
  /** Re-reads the app's triggers; cancels deliveries of undeclared triggers and of removed apps, and deletes those of purged apps. */
  reload(app: AppId): void;
  /** Startup: delivering rows return to due, then the loop and worker start. */
  resume(): void;
}

/** Hides the platform rows behind commands; the only writer of everything but Delivery and Stats. */
export interface Registry {
  publish(request: PublishRequest): Promise<Release>;
  remove(name: AppName): Promise<void>;
  /** Only from removed; otherwise Conflict. */
  purge(name: AppName): Promise<void>;
  setGlobalPolicy(patch: Partial<Policy>): Policy;
  setAppPolicy(name: AppName, patch: PolicyPatch): Promise<PolicyOverride>;
  setOwner(name: AppName, owner: Subject): void;
  issueToken(name: string): { readonly token: string; readonly subject: Subject };
  view(name: AppName): RouteView | null;
  /** The global snapshot; merge with a RouteView's override via effectivePolicy. */
  policy(): Policy;
  runSpec(app: AppId): RunSpec | null;
  listing(): AppSummary[];
  detail(name: AppName): AppDetail | null;
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
  health: '/api/health',
  apps: '/api/apps',
  bundles: '/api/bundles',
  policy: '/api/policy',
  tokens: '/api/tokens',
  app: (name: string) => `/api/apps/${name}`,
  release: (name: string) => `/api/apps/${name}/release`,
  appPolicy: (name: string) => `/api/apps/${name}/policy`,
  owner: (name: string) => `/api/apps/${name}/owner`,
  remove: (name: string) => `/api/apps/${name}/remove`,
  purge: (name: string) => `/api/apps/${name}/purge`,
} as const;
