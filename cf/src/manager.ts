import { type AppAction, type Manager, type ManagerChange, fail } from './model.ts';
import { NAME, record } from './util.ts';

export const MANAGER_HEADER = 'x-pneuma-space-manager';
/** Rollback and resume change which release serves, which is what a manager keeps a record of (ADR 0039). */
export const NAMED_ACTIONS: ReadonlySet<AppAction['type']> = new Set(['rollback', 'remove', 'resume', 'purge', 'discard', 'policy']);

function managerUrl(value: unknown): string {
  const url = typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) && URL.canParse(value) ? new URL(value) : null;
  const href = url?.protocol === 'https:' || url?.protocol === 'http:' ? url.href : null;
  if (href === null || href.length > 2048) fail(400, 'manager', 'manager.url must be an absolute http or https URL of at most 2048 characters without control characters.');
  return href;
}
/** Absent or null leaves the app's manager as it is. */
export function managerChange(value: unknown): ManagerChange | null {
  if (value === undefined || value === null) return null;
  const input = record(value);
  if (Object.keys(input).some(key => key !== 'name' && key !== 'url')) fail(400, 'manager', 'manager takes a name and an optional url.');
  if (typeof input.name !== 'string' || !NAME.test(input.name)) fail(400, 'manager', 'manager.name uses lowercase letters, numbers and hyphens, starting with a letter.');
  return { name: input.name, ...(input.url !== undefined && { url: input.url === null ? null : managerUrl(input.url) }) };
}
export function managerAfter(current: Manager | null, change: ManagerChange | null): Manager | null {
  if (!change) return current;
  return { name: change.name, url: change.url !== undefined ? change.url : current?.name === change.name ? current.url : null };
}
/** A malformed name answers 400 on an unmanaged app too, or the same request would start failing once the app becomes managed. */
export function namedManager(request: Request): string | null {
  const raw = request.headers.get(MANAGER_HEADER);
  if (raw !== null && !NAME.test(raw)) fail(400, 'manager_header', 'X-Pneuma-Space-Manager names one manager with lowercase letters, numbers and hyphens.');
  return raw;
}
export function mustName(app: { name: string; manager: Manager | null }, named: string | null | undefined): void {
  const manager = app.manager;
  if (!manager || named === manager.name) return;
  fail(409, 'managed', 'Application ' + app.name + ' is managed by ' + manager.name + (manager.url ? ' (' + manager.url + ')' : '') + '; acting here goes around it. Act through ' + manager.name + ', or name it to act anyway: X-Pneuma-Space-Manager: ' + manager.name + ' (CLI: --manager ' + manager.name + ').');
}
