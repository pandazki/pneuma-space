import { fail } from './model.ts';
import { record } from './util.ts';

/** Seconds an ephemeral app lives, or null for a durable app; refused rather than cut, so an app never ends before its caller expects (ADR 0038). */
export function ttlSeconds(env: Env, value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const input = record(value);
  if (Object.keys(input).some(key => key !== 'ttlSeconds')) fail(400, 'ephemeral', 'ephemeral takes only ttlSeconds.');
  const fallback = Number(env.PNEUMA_SPACE_EPHEMERAL_TTL_SECONDS), max = Number(env.PNEUMA_SPACE_EPHEMERAL_MAX_TTL_SECONDS);
  if (!Number.isSafeInteger(fallback) || !Number.isSafeInteger(max) || fallback < 1 || fallback > max) fail(503, 'ephemeral_config', 'PNEUMA_SPACE_EPHEMERAL_TTL_SECONDS must be a whole number of seconds no greater than PNEUMA_SPACE_EPHEMERAL_MAX_TTL_SECONDS.');
  const ttl = input.ttlSeconds ?? fallback;
  if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > max) fail(400, 'ttl', 'ttlSeconds must be a whole number from 1 to ' + max + '.');
  return ttl;
}
/** Absent means durable. */
export function statedEphemeral(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') fail(400, 'ephemeral', 'ephemeral must be true or false.');
  return value === true;
}
/** A publish states the kind it expects, so a mistyped name lands nothing on the other kind. */
export function expectKind(app: { name: string; expiresAt: number | null }, ephemeral: boolean): void {
  if ((app.expiresAt !== null) === ephemeral) return;
  fail(409, 'kind', app.expiresAt === null
    ? 'Application ' + app.name + ' is durable and never becomes ephemeral; publish the ephemeral copy under another name.'
    : 'Application ' + app.name + ' is ephemeral until ' + new Date(app.expiresAt).toISOString() + ' and never becomes durable; publish it with ephemeral: true, or the durable app under another name.');
}
