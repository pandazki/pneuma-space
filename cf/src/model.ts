export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const CAPABILITIES = {
  db: { category: 'resource', runtime: true },
  kv: { category: 'resource', runtime: true },
  files: { category: 'resource', runtime: true },
  object: { category: 'resource', runtime: true },
  static: { category: 'ingress', runtime: false },
  ws: { category: 'ingress', runtime: true },
  cron: { category: 'schedule', runtime: true },
  identity: { category: 'ingress', runtime: true },
  rtc: { category: 'resource', runtime: true },
} as const;
export type Capability = keyof typeof CAPABILITIES;
export type Action = 'read' | 'publish' | 'invoke' | 'manage' | 'remove' | 'data';
export const ACTIONS: readonly Action[] = ['read', 'publish', 'invoke', 'manage', 'remove', 'data'];
export type Role = 'admin' | 'member';
export type Manifest = {
  contract: 'pneuma-space.cf/1';
  runtime: 'node' | 'static';
  entry: string;
  capabilities: Partial<Record<Capability, Record<string, unknown>>> & {
    static?: { dir: string };
    cron?: { triggers: Record<string, { schedule?: string }> };
    identity?: { required?: boolean };
  };
};
export type PackageFile = { path: string; body: string; contentType: string };
export type AppPackage = { manifest: Manifest; files: PackageFile[] };
/** When present, `code` is the package the runner boots: the files outside the static directory (ADR 0050). Without it the runner boots the whole package. */
export type Artifact = { digest: string; bytes: number; key: string; manifest: Manifest; code?: { key: string; digest: string } };
export type Release = Artifact & { number: number; createdAt: number; createdBy: string };
export type Policy = {
  idleSeconds: number; requestSeconds: number; drainSeconds: number;
  maxFailures: number; requestsPerDay: number; storageBytes: number;
};
export const DEFAULT_POLICY: Policy = {
  idleSeconds: 300, requestSeconds: 120, drainSeconds: 10,
  maxFailures: 5, requestsPerDay: 2000, storageBytes: 10 * 1024 * 1024,
};
export type Quota = { apps: number; ephemeral: number; awake: number; requestsPerDay: number; storageBytes: number };
export const DEFAULT_QUOTA: Quota = { apps: 5, ephemeral: 3, awake: 2, requestsPerDay: 10000, storageBytes: 80 * 1024 * 1024 };
export type User = { id: string; username: string; name: string; platformAdmin: boolean; disabled: boolean; createdAt: number };
export type Actor = { user: User } & (
  | { kind: 'session'; hash: string; csrf: string }
  | { kind: 'token'; hash: string; tenantId: string; scopes: Action[]; appIds: string[] | null }
);
export type AppRow = {
  id: string; name: string; tenant_id: string; owner_id: string;
  created_at: number; observed_status: string; observed_runtime: string;
  observed_release: number | null; observed_at: number | null;
  expires_at: number | null; manager_name: string | null; manager_url: string | null;
};
export type Manager = { name: string; url: string | null };
/** An absent url keeps the current one while the name stays (ADR 0039). */
export type ManagerChange = { name: string; url?: string | null };
export type AppRegistration = { id: string; name: string; tenantId: string; ownerId: string; policy: Policy; expiresAt: number | null; manager: Manager | null };
export type ExecutionScope = { appId: string; generation: number; bootId: string };
export type AppStatus = 'draft' | 'registered' | 'removed' | 'purging' | 'purged';
export type RuntimeStatus = {
  state: 'asleep' | 'waking' | 'awake' | 'draining' | 'quarantined';
  running: boolean; bootId: string | null; since: number;
  sleepsAt: number | null; requests: number; channels: number; failures: number;
};
export const WAKE_PHASES = ['reserve', 'container', 'fetch', 'unpack', 'listen', 'confirm', 'respond'] as const;
export type Wake = {
  bootId: string; at: number; outcome: 'waking' | 'ready' | 'failed'; error: string | null;
  phases: Record<(typeof WAKE_PHASES)[number], number | null>;
};
export type AppSnapshot = AppRegistration & {
  status: AppStatus; generation: number; current: Release | null; releases: Release[];
  runtime: RuntimeStatus; capabilities: Capability[]; lastAccessAt: number | null;
  usage: { requests: number; errors: number; wakes: number; sleeps: number };
  wake: Wake | null;
};
export type AppAction =
  | { type: 'wake' | 'sleep' | 'restart' | 'kill' | 'remove' | 'resume' | 'unquarantine' | 'discard' }
  | { type: 'rollback'; release: number }
  | { type: 'purge'; confirmation: string }
  | { type: 'policy'; policy: Partial<Policy> };
export function actionScope(type: AppAction['type']): Action | 'purge' | 'kill' {
  return type === 'purge' || type === 'kill' ? type : type === 'remove' || type === 'discard' ? 'remove' : 'manage';
}
export type SqlValue = null | string | number;
export type SqlStatement = { sql: string; params: SqlValue[] };
export type NativeCommand =
  | { type: 'db.query'; sql: string; params: SqlValue[] }
  | { type: 'db.batch'; statements: SqlStatement[] }
  | { type: 'kv.get'; key: string }
  | { type: 'kv.list'; prefix?: string; cursor?: string }
  | { type: 'kv.put'; key: string; value: Json; expected?: number | null; ttl?: number }
  | { type: 'kv.delete'; key: string; expected?: number }
  | { type: 'kv.increment'; key: string; amount: number }
  | { type: 'kv.publish'; channel: string; value: Json }
  | { type: 'files.get'; path: string }
  | { type: 'files.list'; prefix?: string; cursor?: string }
  | { type: 'files.put'; path: string; body: string; expected?: number | null }
  | { type: 'files.delete'; path: string; expected?: number }
  | { type: 'object.upload'; key: string; bytes: number; contentType: string }
  | { type: 'object.complete'; id: string }
  | { type: 'object.download'; key: string }
  | { type: 'object.list'; prefix?: string; cursor?: string }
  | { type: 'object.delete'; key: string }
  | { type: 'rtc.credentials' };
export type Delivery = {
  id: string; name: string; payload: Json; state: 'due' | 'delivering' | 'done' | 'failed' | 'cancelled';
  attempts: number; scheduledFor: number; nextAttemptAt: number; error: string | null;
};
export type EventRow = { id: string; at: number; type: string; message: string; data?: Json };
export type LogRow = { id: string; at: number; level: string; message: string };
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message); this.status = status; this.code = code; this.requestId = requestId;
  }
}
export function fail(status: number, code: string, message: string): never { throw new HttpError(status, code, message); }
