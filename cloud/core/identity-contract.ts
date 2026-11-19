import { tenantName, type AppId, type TenantName } from '../../shared/values.ts';
import type { Actor, PersonalAccount } from './model.ts';

export type VerifiedIdentity = { provider: string; subject: string; name: string };
export type CredentialKind = 'control' | 'app' | 'token' | 'grant';
export type ParsedCredential = { kind: CredentialKind; tenant: TenantName; secret: string };
const PREFIXES = { pcs1: 'control', pas1: 'app', ps1: 'token', pg1: 'grant' } as const;

export function parseCredential(value: string): ParsedCredential | null {
  const parts = value.split('.');
  if (parts.length !== 3 || !/^[0-9a-f]{64}$/.test(parts[2])) return null;
  const prefix = parts[0];
  if (!Object.hasOwn(PREFIXES, prefix)) return null;
  const kind = PREFIXES[prefix as keyof typeof PREFIXES];
  try { return { kind, tenant: tenantName(parts[1]), secret: parts[2] }; }
  catch { return null; }
}

export type SessionScope = { kind: 'control'; origin: string } | { kind: 'app'; origin: string; appId: AppId };
export type AuthenticatedSession = {
  actor: Extract<Actor, { kind: 'session' }>;
  account: PersonalAccount;
  csrf: string;
  scope: SessionScope;
  expiresAt: number;
};
export type CreatedSession = AuthenticatedSession & { credential: string; sessionHash: string };
export type GrantTarget = { appId: AppId; origin: string; nonceHash: string; returnPath: string };

export interface IdentityProvider {
  begin(returnPath: string): Promise<{ authorizationUrl: string; cookieValue: string; expiresAt: number }>;
  complete(input: { code: string; state: string; cookieValue: string }): Promise<{ identity: VerifiedIdentity; returnPath: string }>;
}
