import type { AppId, AppName, TenantName } from '../../shared/values.ts';
import type { Records, RecordsAccess, RecordsLimits, RecordsResource } from './records-contract.ts';

export type PersonalAccount = { userId: string; tenant: TenantName; name: string };
export type Actor =
  | { kind: 'session'; userId: string; sessionHash: string }
  | { kind: 'token'; tokenHash: string };
export type Action = 'read' | 'publish' | 'invoke' | 'remove' | 'export';
export const ACTIONS: readonly Action[] = ['read', 'publish', 'invoke', 'remove', 'export'];

export type CloudManifest = {
  contract: 2;
  runtime: 'fetch';
  abi: 'pneuma-space.fetch/1';
  entry: 'app.mjs';
  capabilities: { records?: Record<string, never>; identity?: Record<string, never>; static?: { dir: string } };
};
export type Asset = { path: string; contentType: string; body: string };
export type Artifact = { manifest: CloudManifest; source: string; assets: Asset[] };
export type PreparedArtifact = { artifact: Artifact; digest: string; bytes: number };
export type Release = { number: number; digest: string; bytes: number; manifest: CloudManifest; createdAt: number };
export type AppIdentity = { subject: string; name: string; owner: string };
export type Invocation = {
  appId: AppId;
  name: AppName;
  release: Release;
  identity: AppIdentity;
  expiresAt: number;
  records: RecordsAccess | null;
};
export type AppContext = { id: string; name: string; release: number; identity?: AppIdentity; records?: Records };

export type Limits = {
  accounts: number;
  apps: number;
  tokens: number;
  sessions: number;
  artifactBytes: number;
  tenantArtifactBytes: number;
  publishesPerDay: number;
  requestsPerDay: number;
  requestBytes: number;
  responseBytes: number;
  deadlineMs: number;
  cpuMs: number;
  recordOperations: number;
  records: RecordsLimits;
};

export const DEFAULT_LIMITS: Limits = {
  accounts: 20, apps: 5, tokens: 20, sessions: 30,
  artifactBytes: 2 * 1024 * 1024, tenantArtifactBytes: 20 * 1024 * 1024,
  publishesPerDay: 30, requestsPerDay: 200,
  requestBytes: 64 * 1024, responseBytes: 1024 * 1024,
  deadlineMs: 15_000, cpuMs: 20, recordOperations: 10,
  records: { valueBytes: 64 * 1024, totalBytes: 1024 * 1024, count: 1000, batch: 10, page: 100 },
};

export interface ArtifactStore {
  put(appId: AppId, prepared: PreparedArtifact): Promise<void>;
  get(appId: AppId, digest: string): Promise<Artifact>;
  destroy(appId: AppId): Promise<void>;
}

export interface ExecutionHost {
  prepare(appId: AppId, prepared: PreparedArtifact): Promise<void>;
  invoke(invocation: Invocation, artifact: Artifact, request: Request, records: Records | null): Promise<Response>;
}

export interface ResourceDirectory {
  records(appId: AppId): RecordsResource;
}
