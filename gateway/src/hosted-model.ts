import type { AppId, Quota, RowLock, Subject, TenantName } from './model.ts';

export const TOKEN_SCOPES = ['read', 'publish', 'invoke', 'remove', 'manage'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type TokenRestrictions = {
  readonly expiresAt: number;
  readonly scopes: readonly TokenScope[];
  readonly appIds: readonly AppId[] | null;
};

export type VerifiedHostedIdentity = { readonly provider: string; readonly subject: string; readonly name: string };
export type HostedAccount = { readonly user: string; readonly tenant: TenantName; readonly name: string };
export type HostedIdentityLink = HostedAccount & { readonly provider: string; readonly externalSubject: string };
export type HostedSignup = { readonly limit: number; readonly quota: Quota };

type SessionBase = { readonly user: string; readonly name: string; readonly origin: string };
export type HostedAuthData =
  | (SessionBase & { readonly kind: 'control'; readonly csrf: string })
  | (SessionBase & { readonly kind: 'app'; readonly appId: AppId; readonly parent: string })
  | (SessionBase & { readonly kind: 'grant'; readonly appId: AppId; readonly parent: string; readonly nonceHash: string; readonly returnPath: string })
  | { readonly kind: 'login'; readonly user: ''; readonly cookieHash: string; readonly returnPath: string; readonly verifier: string };
export type HostedAuthRecord = {
  readonly hash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly data: HostedAuthData;
};

export interface HostedStoreOps {
  hostedIdentity(provider: string, externalSubject: string): Promise<HostedIdentityLink | null>;
  putHostedIdentity(identity: HostedIdentityLink): Promise<void>;
  hostedSignupCount(lock?: RowLock): Promise<number>;
  setHostedSignupCount(count: number): Promise<void>;
  hostedAuth(hash: string, lock?: RowLock): Promise<HostedAuthRecord | null>;
  hostedAuthFor(user: string, lock?: RowLock): Promise<HostedAuthRecord[]>;
  putHostedAuth(record: HostedAuthRecord): Promise<void>;
  deleteHostedAuth(hash: string): Promise<boolean>;
  sweepHostedAuth(before: number): Promise<number>;
}

export type HostedActor = { readonly via: 'hosted'; readonly subject: Subject; readonly name: string };
