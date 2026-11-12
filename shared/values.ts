export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Errors the admin API maps to 400, 404 and 409; messages are written for the person who sent the input. */
export class InputError extends Error {}
export class ManifestError extends InputError {}
export class NotFound extends Error {}
export class Conflict extends Error {}

// Ids

export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

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
