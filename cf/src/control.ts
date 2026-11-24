import { createInvitation, createToken, requireAdmin, requireSession, tenantRole, user } from './auth.ts';
import { appSummary, audit, cellValue, createApp, listApps } from './directory.ts';
import { type Actor, type EventRow, type Quota, fail } from './model.ts';
import { input, integer, json, record, text } from './util.ts';

type TenantRow = { id: string; name: string; apps_limit: number; awake_limit: number; requests_limit: number; storage_limit: number; created_at: number; apps: number; awake: number; storage: number };
const tenantSelect = 'SELECT t.*,(SELECT count(*) FROM apps a WHERE a.tenant_id=t.id AND a.purged_at IS NULL) AS apps,(SELECT count(*) FROM compute c JOIN apps a ON a.id=c.app_id WHERE a.tenant_id=t.id) AS awake,(SELECT coalesce(sum(storage_bytes),0) FROM apps a WHERE a.tenant_id=t.id AND a.purged_at IS NULL) AS storage FROM tenants t';
const quota = (t: TenantRow): Quota => ({ apps: t.apps_limit, awake: t.awake_limit, requestsPerDay: t.requests_limit, storageBytes: t.storage_limit });
const tenantView = (t: TenantRow) => ({ id: t.id, name: t.name, createdAt: t.created_at, quota: quota(t), used: { apps: t.apps, awake: t.awake, storageBytes: t.storage } });
export const operationKey = (request: Request): string => text(request.headers.get('idempotency-key') ?? crypto.randomUUID(), 'operation key', 120);
function offset(url: URL): number {
  const value = url.searchParams.get('cursor');
  if (value !== null && !/^\d{1,7}$/.test(value)) fail(400, 'cursor', 'Invalid page cursor.');
  return value === null ? 0 : Number(value);
}
function page<T>(rows: T[], start: number) {
  return { items: rows.slice(0, 100), ...(rows.length > 100 ? { nextCursor: String(start + 100) } : {}) };
}
async function auditPage(env: Env, actor: Actor, url: URL, tenantId?: string): Promise<Response> {
  const start = offset(url);
  let sql = 'SELECT id,at,user_id AS actorId,tenant_id AS tenantId,app_id AS appId,action,result,detail FROM audit';
  const args: (string | number)[] = [];
  if (tenantId) {
    const role = await tenantRole(env, actor, tenantId);
    sql += ' WHERE tenant_id=?'; args.push(tenantId);
    if (role !== 'admin') {
      sql += ' AND (user_id=? OR app_id IN(SELECT id FROM apps WHERE owner_id=?))'; args.push(actor.user.id, actor.user.id);
    }
  }
  const rows = await env.PNEUMA_SPACE_DB.prepare(sql + ' ORDER BY at DESC,id LIMIT 101 OFFSET ?').bind(...args, start).all();
  return json(page(rows.results, start));
}
async function updateAccount(env: Env, actor: Actor, accountId: string, body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).some(k => !['disabled', 'platformAdmin'].includes(k)) || !Object.keys(body).length) fail(400, 'account', 'Choose an account setting.');
  for (const value of Object.values(body)) if (typeof value !== 'boolean') fail(400, 'account', 'Account settings must be boolean.');
  const disabled = body.disabled === undefined ? null : Number(body.disabled);
  const admin = body.platformAdmin === undefined ? null : Number(body.platformAdmin);
  const db = env.PNEUMA_SPACE_DB;
  const row = await db.prepare('UPDATE users SET disabled=coalesce(?,disabled),platform_admin=coalesce(?,platform_admin) WHERE id=? AND (platform_admin=0 OR disabled=1 OR (coalesce(?,disabled)=0 AND coalesce(?,platform_admin)=1) OR (SELECT count(*) FROM users WHERE platform_admin=1 AND disabled=0)>1) RETURNING *').bind(disabled, admin, accountId, disabled, admin).first<Parameters<typeof user>[0]>();
  if (!row) fail(409, 'last_admin', 'Account not found or this change would remove the last active platform administrator.');
  if (row.disabled) {
    await db.batch([
      db.prepare('UPDATE sessions SET revoked_at=coalesce(revoked_at,?) WHERE user_id=?').bind(Date.now(), accountId),
      db.prepare('UPDATE tokens SET revoked_at=coalesce(revoked_at,?) WHERE user_id=?').bind(Date.now(), accountId),
    ]);
  }
  await audit(env, actor, 'account.update', null, null, 'ok', accountId);
  return json(user(row));
}
async function resources(env: Env): Promise<Response> {
  const checks = await Promise.allSettled([
    env.PNEUMA_SPACE_DB.prepare('SELECT count(*) AS apps FROM apps WHERE purged_at IS NULL').first(),
    env.PNEUMA_SPACE_ARTIFACTS.list({ limit: 1 }), env.PNEUMA_SPACE_OBJECTS.list({ limit: 1 }),
  ]);
  return json({
    checkedAt: Date.now(),
    d1: { status: checks[0].status === 'fulfilled' ? 'reachable' : 'failed' },
    artifacts: { bucket: env.PNEUMA_SPACE_ARTIFACT_BUCKET, status: checks[1].status === 'fulfilled' ? 'reachable' : 'failed' },
    objects: { bucket: env.PNEUMA_SPACE_OBJECT_BUCKET, status: checks[2].status === 'fulfilled' ? 'reachable' : 'failed' },
    runtime: { provider: 'Cloudflare Containers', observations: 'Open an application for its current runtime state.' },
    turn: { status: env.PNEUMA_SPACE_TURN_KEY_ID && env.PNEUMA_SPACE_TURN_API_TOKEN ? 'configured' : 'unconfigured' },
  });
}
async function adminRoute(request: Request, env: Env, actor: Actor, segments: string[], url: URL): Promise<Response> {
  requireAdmin(actor);
  const [section, target] = segments, db = env.PNEUMA_SPACE_DB, start = offset(url);
  if (segments.length > 2) fail(404, 'not_found', 'Route not found.');
  if (section === 'accounts') {
    if (request.method === 'PATCH' && target) return updateAccount(env, actor, target, await input(request, 2048));
    if (request.method === 'GET' && !target) {
      const rows = await db.prepare('SELECT id,username,name,platform_admin,disabled,created_at,(SELECT count(*) FROM memberships WHERE user_id=users.id) AS tenantCount FROM users ORDER BY created_at,id LIMIT 101 OFFSET ?').bind(start).all<Parameters<typeof user>[0] & { tenantCount: number }>();
      return json(page(rows.results.map(row => ({ ...user(row), tenantCount: row.tenantCount })), start));
    }
  }
  if (section === 'invitations') {
    if (request.method === 'GET' && !target) return json(page((await db.prepare('SELECT id,created_at AS createdAt,expires_at AS expiresAt,consumed_at AS consumedAt,revoked_at AS revokedAt FROM invitations ORDER BY created_at DESC,id LIMIT 101 OFFSET ?').bind(start).all()).results, start));
    if (request.method === 'POST' && !target) {
      const result = await createInvitation(env, actor, (await input(request, 2048)).expiresAt);
      await audit(env, actor, 'invitation.create', null, null); return json(result, 201);
    }
    if (request.method === 'DELETE' && target) {
      await db.prepare('UPDATE invitations SET revoked_at=coalesce(revoked_at,?) WHERE id=?').bind(Date.now(), target).run();
      await audit(env, actor, 'invitation.revoke', null, null, 'ok', target); return new Response(null, { status: 204 });
    }
  }
  if (section === 'tenants') {
    if (request.method === 'GET' && !target) return json(page((await db.prepare(tenantSelect + ' ORDER BY t.created_at,t.id LIMIT 101 OFFSET ?').bind(start).all<TenantRow>()).results.map(tenantView), start));
    if (request.method === 'PATCH' && target) {
      const values = record((await input(request, 2048)).quota);
      const next = { apps: integer(values.apps, 'application limit', 0, 50), awake: integer(values.awake, 'awake limit', 0, 10), requestsPerDay: integer(values.requestsPerDay, 'request limit', 0, 1000000), storageBytes: integer(values.storageBytes, 'storage limit', 0, 1024 * 1024 * 1024) };
      const changed = await db.prepare('UPDATE tenants SET apps_limit=?,awake_limit=?,requests_limit=?,storage_limit=? WHERE id=? AND (SELECT count(*) FROM apps WHERE tenant_id=? AND purged_at IS NULL)<=? AND (SELECT coalesce(sum(storage_bytes),0) FROM apps WHERE tenant_id=? AND purged_at IS NULL)<=? AND (SELECT count(*) FROM compute c JOIN apps a ON a.id=c.app_id WHERE a.tenant_id=?)<=?').bind(next.apps, next.awake, next.requestsPerDay, next.storageBytes, target, target, next.apps, target, next.storageBytes, target, next.awake).run();
      if (!changed.meta.changes) fail(409, 'quota_in_use', 'Space not found or the limit is below its current reservations.');
      await audit(env, actor, 'tenant.quota', target, null); return json({ quota: next });
    }
  }
  if (request.method === 'GET' && !target) {
    if (section === 'apps') return json({ items: (await listApps(env, actor)).map(row => appSummary(env, row)) });
    if (section === 'resources') return resources(env);
    if (section === 'audit') return auditPage(env, actor, url);
    if (section === 'overview') {
      const row = await db.prepare('SELECT (SELECT count(*) FROM users) AS accounts,(SELECT count(*) FROM users WHERE disabled=1) AS disabledAccounts,(SELECT count(*) FROM tenants) AS tenants,(SELECT count(*) FROM apps WHERE purged_at IS NULL) AS apps,(SELECT count(*) FROM compute) AS reservedRuntimes,(SELECT coalesce(sum(requests),0) FROM daily_usage WHERE day=?) AS requestsToday').bind(new Date().toISOString().slice(0, 10)).first();
      return json({ ...row, observedAt: Date.now() });
    }
  }
  return fail(404, 'not_found', 'Route not found.');
}
async function memberRoute(request: Request, env: Env, actor: Actor, tenantId: string, target?: string): Promise<Response> {
  requireSession(actor);
  const role = await tenantRole(env, actor, tenantId, request.method !== 'GET'), db = env.PNEUMA_SPACE_DB;
  if (request.method === 'GET' && !target) {
    const rows = await db.prepare('SELECT u.id,u.id AS userId,u.username,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? ORDER BY m.role,u.username LIMIT 100').bind(tenantId).all();
    return json({ items: rows.results, role });
  }
  if (request.method === 'POST' && !target) {
    const body = await input(request, 2048), userId = text(body.userId, 'user');
    if (body.role !== 'admin' && body.role !== 'member') fail(400, 'role', 'Invalid member role.');
    const result = await db.prepare("INSERT INTO memberships(tenant_id,user_id,role) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0) ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=excluded.role WHERE memberships.role<>'admin' OR excluded.role='admin' OR (SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.role='admin' AND u.disabled=0)>1").bind(tenantId, userId, body.role, userId, tenantId).run();
    if (!result.meta.changes) fail(409, 'last_admin', 'User unavailable or this change would remove the last active tenant administrator.');
    await audit(env, actor, 'member.set', tenantId, null, 'ok', userId + ':' + body.role);
    return json({ userId, role: body.role });
  }
  if (request.method === 'DELETE' && target) {
    const result = await db.prepare("DELETE FROM memberships WHERE tenant_id=? AND user_id=? AND (role<>'admin' OR (SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.role='admin' AND u.disabled=0 AND m.user_id<>?)>0)").bind(tenantId, target, tenantId, target).run();
    if (!result.meta.changes) fail(409, 'last_admin', 'Member not found or this change would remove the last active tenant administrator.');
    await db.prepare('UPDATE tokens SET revoked_at=coalesce(revoked_at,?) WHERE tenant_id=? AND user_id=?').bind(Date.now(), tenantId, target).run();
    await audit(env, actor, 'member.remove', tenantId, null, 'ok', target);
    return new Response(null, { status: 204 });
  }
  return fail(404, 'not_found', 'Route not found.');
}
async function tokenRoute(request: Request, env: Env, actor: Actor, tenantId: string, target?: string): Promise<Response> {
  requireSession(actor);
  const role = await tenantRole(env, actor, tenantId), db = env.PNEUMA_SPACE_DB;
  if (request.method === 'GET' && !target) {
    const rows = await db.prepare('SELECT id,label,scopes_json,app_ids_json,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt FROM tokens WHERE tenant_id=? AND (?=1 OR user_id=?) ORDER BY created_at DESC LIMIT 100').bind(tenantId, Number(role === 'admin'), actor.user.id).all<{ id: string; label: string; scopes_json: string; app_ids_json: string | null; createdAt: number; expiresAt: number; revokedAt: number | null }>();
    return json({ items: rows.results.map(({ scopes_json, app_ids_json, ...row }) => ({ ...row, scopes: JSON.parse(scopes_json), appIds: app_ids_json ? JSON.parse(app_ids_json) : null })) });
  }
  if (request.method === 'POST' && !target) {
    const result = await createToken(env, actor, tenantId, await input(request, 8192));
    await audit(env, actor, 'token.create', tenantId, null); return json(result, 201);
  }
  if (request.method === 'DELETE' && target) {
    const result = await db.prepare('UPDATE tokens SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND tenant_id=? AND (?=1 OR user_id=?)').bind(Date.now(), target, tenantId, Number(role === 'admin'), actor.user.id).run();
    if (!result.meta.changes) fail(404, 'token', 'Credential not found.');
    await audit(env, actor, 'token.revoke', tenantId, null, 'ok', target); return new Response(null, { status: 204 });
  }
  return fail(404, 'not_found', 'Route not found.');
}
export async function controlRoute(request: Request, env: Env, actor: Actor, path: string): Promise<Response | null> {
  const segments = path.split('/').filter(Boolean), url = new URL(request.url);
  if (segments[0] === 'admin') return adminRoute(request, env, actor, segments.slice(1), url);
  if (segments[0] !== 'tenants' || segments.length < 3 || segments.length > 4) return null;
  const [, tenantId, section, target] = segments;
  if (section === 'apps' && !target) {
    if (request.method === 'GET') return json({ items: (await listApps(env, actor, tenantId)).map(row => appSummary(env, row)) });
    if (request.method === 'POST') return json(appSummary(env, await createApp(env, actor, tenantId, (await input(request, 2048)).name, operationKey(request))), 201);
  }
  requireSession(actor);
  await tenantRole(env, actor, tenantId);
  if (section === 'members') return memberRoute(request, env, actor, tenantId, target);
  if (section === 'tokens') return tokenRoute(request, env, actor, tenantId, target);
  if (request.method === 'GET' && !target) {
    if (section === 'audit') return auditPage(env, actor, url, tenantId);
    if (section === 'events') {
      const apps = await listApps(env, actor, tenantId);
      const lists = await Promise.all(apps.map(async app => {
        const result = await cellValue<{ items: EventRow[] }>(env, app.id, '/events');
        return result.items.map(event => ({ ...event, appId: app.id, appName: app.name }));
      }));
      return json({ items: lists.flat().sort((a, b) => b.at - a.at).slice(0, 200) });
    }
    if (section === 'usage') {
      const tenant = await env.PNEUMA_SPACE_DB.prepare(tenantSelect + ' WHERE t.id=?').bind(tenantId).first<TenantRow>();
      if (!tenant) fail(404, 'tenant', 'Space not found.');
      const requests = await env.PNEUMA_SPACE_DB.prepare('SELECT requests FROM daily_usage WHERE tenant_id=? AND day=?').bind(tenantId, new Date().toISOString().slice(0, 10)).first<{ requests: number }>();
      return json({ ...tenantView(tenant), requestsToday: requests?.requests ?? 0, observedAt: Date.now() });
    }
  }
  return fail(404, 'not_found', 'Route not found.');
}
