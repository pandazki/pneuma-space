import { DEFAULT_POLICY, type Actor, type AppRow, type AppSnapshot, type AppRegistration, fail } from './model.ts';
import { authorizeApp, requireAdmin, tenantRole } from './auth.ts';
import { ttlSeconds } from './ephemeral.ts';
import { managerAfter, managerChange } from './manager.ts';
import { NAME, id, text } from './util.ts';

/** An app holds a slot of its kind until purged, except that an ephemeral app gives its slot back once it is ending; its storage and name stay held (ADR 0046). */
export const HOLDS_SLOT = "purged_at IS NULL AND (expires_at IS NULL OR observed_status IS NOT 'purging')";
export const appUrl = (env: Env, name: string): string => env.PNEUMA_SPACE_CONTROL_ORIGIN + '/apps/' + name + '/';
export async function appRow(env: Env, appId: string): Promise<AppRow & { storage_bytes: number }> {
  const row = await env.PNEUMA_SPACE_DB.prepare('SELECT * FROM apps WHERE id=? AND purged_at IS NULL').bind(appId).first<AppRow & { storage_bytes: number }>();
  return row ?? fail(404, 'app_not_found', 'Application not found.');
}
export function appSummary(env: Env, row: AppRow) {
  return {
    id: row.id, name: row.name, tenantId: row.tenant_id, ownerId: row.owner_id, url: appUrl(env, row.name),
    status: row.observed_status, runtime: { state: row.observed_runtime }, release: row.observed_release,
    observedAt: row.observed_at, createdAt: row.created_at, expiresAt: row.expires_at,
    manager: row.manager_name === null ? null : { name: row.manager_name, url: row.manager_url },
  };
}
export async function cell(env: Env, appId: string, path: string, value?: unknown): Promise<Response> {
  return env.PNEUMA_SPACE_APPS.getByName(appId).fetch('https://cell' + path, value === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
}
export async function cellValue<T>(env: Env, appId: string, path: string, value?: unknown): Promise<T> {
  const response = await cell(env, appId, path, value);
  const body = await response.json<{ error?: { code?: string; message?: string } }>();
  if (!response.ok) fail(response.status, body.error?.code ?? 'app_error', body.error?.message ?? 'Application operation failed.');
  return body as T;
}
export async function initialize(env: Env, row: AppRow & { storage_bytes: number }): Promise<void> {
  const registration: AppRegistration = {
    id: row.id, name: row.name, tenantId: row.tenant_id, ownerId: row.owner_id,
    policy: { ...DEFAULT_POLICY, storageBytes: row.storage_bytes }, expiresAt: row.expires_at,
    manager: row.manager_name === null ? null : { name: row.manager_name, url: row.manager_url },
  };
  await cellValue(env, row.id, '/initialize', registration);
}
/** `platform` is the actor of what no request asked for: an ephemeral app's expiry (ADR 0038). */
export async function audit(env: Env, actor: Actor | 'platform', action: string, tenantId: string | null, appId: string | null, result = 'ok', detail: string | Record<string, unknown> = ''): Promise<void> {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  await env.PNEUMA_SPACE_DB.prepare('INSERT INTO audit(id,at,user_id,tenant_id,app_id,action,result,detail) VALUES(?,?,?,?,?,?,?,?)').bind(id('e'), Date.now(), actor === 'platform' ? actor : actor.user.id, tenantId, appId, action, result, text.slice(0, 4096)).run();
}
export async function listApps(env: Env, actor: Actor, tenantId?: string): Promise<AppRow[]> {
  if (!tenantId) {
    requireAdmin(actor);
    return (await env.PNEUMA_SPACE_DB.prepare('SELECT * FROM apps WHERE purged_at IS NULL ORDER BY created_at DESC LIMIT 200').all<AppRow>()).results;
  }
  if (actor.kind === 'token') {
    if (actor.tenantId !== tenantId || !actor.scopes.includes('read')) fail(403, 'token_scope', 'This credential cannot list applications.');
  } else await tenantRole(env, actor, tenantId);
  const rows = (await env.PNEUMA_SPACE_DB.prepare('SELECT a.*,m.role AS member_role FROM apps a LEFT JOIN memberships m ON m.tenant_id=a.tenant_id AND m.user_id=? WHERE a.tenant_id=? AND a.purged_at IS NULL ORDER BY a.created_at DESC LIMIT 200').bind(actor.user.id, tenantId).all<AppRow & { member_role: string | null }>()).results;
  return rows.filter(row => (actor.kind === 'session' && actor.user.platformAdmin) || ((row.member_role === 'admin' || row.owner_id === actor.user.id) && (actor.kind === 'session' || actor.appIds === null || actor.appIds.includes(row.id))));
}
export async function createApp(env: Env, actor: Actor, tenantId: string, body: Record<string, unknown>, operation: string): Promise<AppRow> {
  if (actor.kind === 'token' && (!actor.scopes.includes('publish') || actor.appIds !== null)) fail(403, 'token_scope', 'This credential cannot create applications.');
  await tenantRole(env, actor, tenantId);
  const name = text(body.name, 'application name', 40);
  if (!NAME.test(name)) fail(400, 'name', 'Use lowercase letters, numbers and hyphens.');
  const ttl = ttlSeconds(env, body.ephemeral), manager = managerAfter(null, managerChange(body.manager));
  let row = await env.PNEUMA_SPACE_DB.prepare('SELECT * FROM apps WHERE tenant_id=? AND create_key=?').bind(tenantId, operation).first<AppRow & { storage_bytes: number }>();
  if (row && (row.name !== name || (row.expires_at === null) !== (ttl === null))) fail(409, 'idempotency', 'This operation key was used for another application.');
  if (!row) {
    const appId = id('a'), now = Date.now(), ephemeral = Number(ttl !== null);
    const tenant = await env.PNEUMA_SPACE_DB.prepare('SELECT storage_limit,apps_limit FROM tenants WHERE id=?').bind(tenantId).first<{ storage_limit: number; apps_limit: number }>();
    if (!tenant) fail(404, 'tenant_not_found', 'Space not found.');
    // An ephemeral app's allocation is derived as a durable app's and counts toward storage as usual (ADR 0046).
    const bytes = Math.min(DEFAULT_POLICY.storageBytes, Math.floor(tenant.storage_limit / Math.max(tenant.apps_limit, 1)));
    try {
      const created = await env.PNEUMA_SPACE_DB.prepare('INSERT INTO apps(id,name,tenant_id,owner_id,origin,created_at,create_key,storage_bytes,expires_at,manager_name,manager_url) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM apps WHERE tenant_id=? AND ' + HOLDS_SLOT + ' AND (expires_at IS NOT NULL)=?)<(SELECT CASE WHEN ?=1 THEN ephemeral_limit ELSE apps_limit END FROM tenants WHERE id=?) AND (SELECT coalesce(sum(storage_bytes),0) FROM apps WHERE tenant_id=? AND purged_at IS NULL)+?<=(SELECT storage_limit FROM tenants WHERE id=?)').bind(appId, name, tenantId, actor.user.id, appId, now, operation, bytes, ttl === null ? null : now + ttl * 1000, manager?.name ?? null, manager?.url ?? null, tenantId, ephemeral, ephemeral, tenantId, tenantId, bytes, tenantId).run();
      if (!created.meta.changes) fail(409, ephemeral ? 'ephemeral_quota' : 'app_quota', ephemeral ? 'The space has reached its ephemeral application or allocated storage limit.' : 'The space has reached its application or allocated storage limit.');
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) {
        const retry = await env.PNEUMA_SPACE_DB.prepare('SELECT * FROM apps WHERE tenant_id=? AND create_key=?').bind(tenantId, operation).first<AppRow & { storage_bytes: number }>();
        if (!retry || retry.name !== name) fail(409, 'app_exists', 'An application already uses this name.');
        row = retry;
      } else throw error;
    }
    row ??= await appRow(env, appId);
  }
  await initialize(env, row);
  await audit(env, actor, 'app.create', tenantId, row.id, 'ok', row.expires_at === null && !manager ? '' : { ...(row.expires_at !== null && { expiresAt: row.expires_at }), ...(manager && { manager }) });
  return row;
}
export async function reserveCompute(env: Env, appId: string, bootId: string): Promise<void> {
  const app = await appRow(env, appId), db = env.PNEUMA_SPACE_DB;
  const existing = await db.prepare('SELECT boot_id FROM compute WHERE app_id=?').bind(appId).first<{ boot_id: string }>();
  if (existing?.boot_id === bootId) return;
  const others = (await db.prepare('SELECT c.app_id,c.boot_id FROM compute c JOIN apps a ON a.id=c.app_id WHERE a.tenant_id=? AND c.app_id<>?').bind(app.tenant_id, appId).all<{ app_id: string; boot_id: string }>()).results;
  await Promise.all(others.map(async other => {
    try {
      const snapshot = await cellValue<AppSnapshot>(env, other.app_id, '/inspect');
      if (!snapshot.runtime.running && ['asleep', 'quarantined'].includes(snapshot.runtime.state)) await releaseCompute(env, other.app_id, other.boot_id);
    } catch {}
  }));
  const result = await db.prepare('INSERT INTO compute(app_id,boot_id,started_at) SELECT ?,?,? WHERE (SELECT count(*) FROM compute c JOIN apps a ON a.id=c.app_id WHERE a.tenant_id=?)<(SELECT awake_limit FROM tenants WHERE id=?) ON CONFLICT(app_id) DO NOTHING').bind(appId, bootId, Date.now(), app.tenant_id, app.tenant_id).run();
  if (!result.meta.changes) fail(503, 'compute_quota', 'The space has reached its running application limit.');
}
export async function releaseCompute(env: Env, appId: string, bootId: string): Promise<void> {
  await env.PNEUMA_SPACE_DB.prepare('DELETE FROM compute WHERE app_id=? AND boot_id=?').bind(appId, bootId).run();
}
export async function observeApp(env: Env, snapshot: AppSnapshot): Promise<void> {
  await env.PNEUMA_SPACE_DB.prepare('UPDATE apps SET observed_status=?,observed_runtime=?,observed_release=?,observed_at=?,manager_name=?,manager_url=?,purged_at=CASE WHEN ?=? THEN coalesce(purged_at,?) ELSE purged_at END WHERE id=?').bind(snapshot.status, snapshot.runtime.state, snapshot.current?.number ?? null, Date.now(), snapshot.manager?.name ?? null, snapshot.manager?.url ?? null, snapshot.status, 'purged', Date.now(), snapshot.id).run();
}
export async function admitRequest(env: Env, tenantId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.PNEUMA_SPACE_DB.prepare('INSERT INTO daily_usage(tenant_id,day,requests) SELECT ?,?,1 WHERE (SELECT requests_limit FROM tenants WHERE id=?)>0 ON CONFLICT(tenant_id,day) DO UPDATE SET requests=daily_usage.requests+1 WHERE daily_usage.requests<(SELECT requests_limit FROM tenants WHERE id=?) RETURNING requests').bind(tenantId, day, tenantId, tenantId).first();
  if (!row) fail(429, 'request_quota', 'The space has reached its daily request limit.');
}
