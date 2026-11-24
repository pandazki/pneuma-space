import { ACTIONS, type Action, type Actor, type AppRow, type Role, type User, fail } from './model.ts';
import { cookie, id, input, integer, json, secret, sha, text } from './util.ts';

export const CONTROL_COOKIE = '__Host-pneuma-space-control';
export const APP_COOKIE = '__Host-pneuma-space-app';
export const NONCE_COOKIE = '__Host-pneuma-space-nonce';
export type CredentialProof = Pick<Actor, 'kind' | 'hash'>;
type UserRow = { id: string; username: string; name: string; platform_admin: number; disabled: number; created_at: number };
type SessionRow = UserRow & { hash: string; csrf: string };
type TokenRow = UserRow & { hash: string; tenant_id: string; scopes_json: string; app_ids_json: string | null };
export const user = (row: UserRow): User => ({
  id: row.id, username: row.username, name: row.name, platformAdmin: row.platform_admin === 1,
  disabled: row.disabled === 1, createdAt: row.created_at,
});
export const sessionCookie = (name: string, value: string, seconds: number): string =>
  name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + seconds;

async function proof(env: Env, kind: 'session' | 'token', hash: string): Promise<Actor | null> {
  const db = env.PNEUMA_SPACE_DB;
  if (kind === 'session') {
    const row = await db.prepare('SELECT u.*,s.hash,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.disabled=0').bind(hash, Date.now()).first<SessionRow>();
    return row ? { kind, user: user(row), hash, csrf: row.csrf } : null;
  }
  const row = await db.prepare('SELECT u.*,t.hash,t.tenant_id,t.scopes_json,t.app_ids_json FROM tokens t JOIN users u ON u.id=t.user_id JOIN memberships m ON m.tenant_id=t.tenant_id AND m.user_id=t.user_id WHERE t.hash=? AND t.revoked_at IS NULL AND t.expires_at>? AND u.disabled=0').bind(hash, Date.now()).first<TokenRow>();
  if (!row) return null;
  return { kind, user: user(row), hash, tenantId: row.tenant_id, scopes: JSON.parse(row.scopes_json), appIds: row.app_ids_json ? JSON.parse(row.app_ids_json) : null };
}
export async function authenticate(request: Request, env: Env): Promise<Actor | null> {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
    return match ? proof(env, 'token', await sha(match[1])) : null;
  }
  const key = cookie(request, CONTROL_COOKIE);
  return key && /^[a-f0-9]{64}$/.test(key) ? proof(env, 'session', await sha(key)) : null;
}
export async function fresh(env: Env, actor: CredentialProof): Promise<Actor> {
  return await proof(env, actor.kind, actor.hash) ?? fail(401, 'unauthorized', 'The credential is no longer valid.');
}
export function requireSession(actor: Actor): asserts actor is Extract<Actor, { kind: 'session' }> {
  if (actor.kind !== 'session') fail(403, 'session_required', 'Sign in to manage this setting.');
}
export function requireAdmin(actor: Actor): void {
  requireSession(actor);
  if (!actor.user.platformAdmin) fail(403, 'administrator_required', 'Platform administrator access is required.');
}
export function protectWrite(request: Request, env: Env, actor?: Actor): void {
  if (actor?.kind === 'token') return;
  if (request.headers.get('origin') !== env.PNEUMA_SPACE_CONTROL_ORIGIN) fail(403, 'origin', 'The request origin is not allowed.');
  if (actor?.kind === 'session' && request.headers.get('x-pneuma-space-csrf') !== actor.csrf) fail(403, 'csrf', 'Reload the page before trying again.');
}
export async function tenantRole(env: Env, actor: Actor, tenantId: string, admin = false): Promise<Role> {
  if (actor.kind === 'session' && actor.user.platformAdmin) return 'admin';
  if (actor.kind === 'token' && (actor.tenantId !== tenantId || admin || actor.appIds !== null)) fail(403, 'tenant_scope', 'This credential does not allow tenant management.');
  const row = await env.PNEUMA_SPACE_DB.prepare('SELECT role FROM memberships WHERE tenant_id=? AND user_id=?').bind(tenantId, actor.user.id).first<{ role: Role }>();
  if (!row || (admin && row.role !== 'admin')) fail(403, 'tenant_role', 'A tenant administrator is required.');
  return row.role;
}
export async function authorizeApp(env: Env, stale: CredentialProof, appId: string, action: Action | 'purge' | 'kill'): Promise<AppRow> {
  const actor = await fresh(env, stale);
  const app = await env.PNEUMA_SPACE_DB.prepare('SELECT * FROM apps WHERE id=? AND purged_at IS NULL').bind(appId).first<AppRow>();
  if (!app) fail(404, 'app_not_found', 'Application not found.');
  if (actor.kind === 'token') {
    if (action === 'purge' || action === 'kill') fail(403, 'session_required', 'This action requires a signed-in account.');
    if (actor.tenantId !== app.tenant_id || (actor.appIds !== null && !actor.appIds.includes(app.id))) fail(404, 'app_not_found', 'Application not found.');
    if (!actor.scopes.includes(action)) fail(403, 'token_scope', 'This credential does not allow this action.');
  } else if (actor.user.platformAdmin) return app;
  if (action === 'kill') fail(403, 'administrator_required', 'Platform administrator access is required.');
  const role = await env.PNEUMA_SPACE_DB.prepare('SELECT role FROM memberships WHERE tenant_id=? AND user_id=?').bind(app.tenant_id, actor.user.id).first<{ role: Role }>();
  if (!role) fail(404, 'app_not_found', 'Application not found.');
  if (action !== 'invoke' && role.role !== 'admin' && app.owner_id !== actor.user.id) fail(404, 'app_not_found', 'Application not found.');
  return app;
}
export async function me(env: Env, actor: Actor) {
  const rows = await env.PNEUMA_SPACE_DB.prepare('SELECT t.*,m.role FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=? ORDER BY t.created_at,t.id').bind(actor.user.id).all<{ id: string; name: string; role: Role; apps_limit: number; awake_limit: number; requests_limit: number; storage_limit: number }>();
  const tenants = rows.results.filter(row => actor.kind === 'session' || row.id === actor.tenantId).map(row => ({
    id: row.id, name: row.name, role: row.role,
    quota: { apps: row.apps_limit, awake: row.awake_limit, requestsPerDay: row.requests_limit, storageBytes: row.storage_limit },
  }));
  return { user: actor.user, platformAdmin: actor.kind === 'session' && actor.user.platformAdmin, tenants, csrf: actor.kind === 'session' ? actor.csrf : null };
}
async function createSession(env: Env, userId: string): Promise<{ actor: Actor; key: string }> {
  const key = secret(), hash = await sha(key), csrf = secret(), now = Date.now();
  await env.PNEUMA_SPACE_DB.prepare('INSERT INTO sessions(hash,user_id,csrf,created_at,expires_at) VALUES(?,?,?,?,?)').bind(hash, userId, csrf, now, now + 7 * 86400000).run();
  const actor = await proof(env, 'session', hash);
  if (!actor) fail(401, 'unauthorized', 'Account is disabled.');
  return { actor, key };
}
async function loginLimit(request: Request, env: Env): Promise<void> {
  const key = await sha(request.headers.get('cf-connecting-ip') ?? 'local');
  const slot = Math.floor(Date.now() / 600000);
  const row = await env.PNEUMA_SPACE_DB.prepare('INSERT INTO auth_limits(key,slot,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET slot=excluded.slot,count=CASE WHEN auth_limits.slot=excluded.slot THEN auth_limits.count+1 ELSE 1 END RETURNING count').bind(key, slot).first<{ count: number }>();
  if (!row || row.count > 40) fail(429, 'login_limit', 'Too many sign-in attempts. Try again later.');
}
export async function authRoute(request: Request, env: Env, path: string, actor: Actor | null): Promise<Response> {
  if (request.method !== 'POST') fail(405, 'method', 'Use POST.');
  protectWrite(request, env, path === 'logout' ? actor ?? undefined : undefined);
  if (path === 'logout') {
    if (actor) { requireSession(actor); await env.PNEUMA_SPACE_DB.prepare('UPDATE sessions SET revoked_at=? WHERE hash=?').bind(Date.now(), actor.hash).run(); }
    return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie(CONTROL_COOKIE, '', 0) } });
  }
  await loginLimit(request, env);
  const body = await input(request, 4096);
  let userId: string, accessKey: string | undefined;
  if (path === 'login') {
    const account = text(body.account, 'account', 40), key = text(body.key, 'key', 128);
    const row = await env.PNEUMA_SPACE_DB.prepare('SELECT id FROM users WHERE username=? AND key_hash=? AND disabled=0').bind(account.toLowerCase(), await sha(key)).first<{ id: string }>();
    if (!row) fail(401, 'login_failed', 'Account or access key is incorrect.');
    userId = row.id;
  } else if (path === 'redeem') {
    const username = text(body.username, 'username', 32).toLowerCase();
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) fail(400, 'username', 'Use 3–32 lowercase letters, numbers, underscores or hyphens.');
    const name = text(body.name, 'display name', 80), invite = text(body.invite, 'invitation', 128);
    const now = Date.now();
    const row = await env.PNEUMA_SPACE_DB.prepare('SELECT * FROM invitations WHERE hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?').bind(await sha(invite), now).first<{ id: string; user_id: string; tenant_id: string }>();
    if (!row) fail(409, 'invitation_invalid', 'This invitation is expired, revoked or already used.');
    accessKey = secret();
    const condition = 'EXISTS(SELECT 1 FROM invitations WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?)';
    try {
      const result = await env.PNEUMA_SPACE_DB.batch([
        env.PNEUMA_SPACE_DB.prepare('INSERT INTO tenants(id,name,created_at) SELECT ?,?,? WHERE ' + condition + ' AND (SELECT count(*) FROM users)<?').bind(row.tenant_id, name + "'s space", now, row.id, now, Number(env.PNEUMA_SPACE_MAX_ACCOUNTS)),
        env.PNEUMA_SPACE_DB.prepare('INSERT INTO users(id,username,name,key_hash,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tenants WHERE id=?) AND ' + condition).bind(row.user_id, username, name, await sha(accessKey), now, row.tenant_id, row.id, now),
        env.PNEUMA_SPACE_DB.prepare("INSERT INTO memberships(tenant_id,user_id,role) SELECT ?,?,'admin' WHERE EXISTS(SELECT 1 FROM users WHERE id=?) AND " + condition).bind(row.tenant_id, row.user_id, row.user_id, row.id, now),
        env.PNEUMA_SPACE_DB.prepare('UPDATE invitations SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM users WHERE id=?)').bind(now, row.id, now, row.user_id),
      ]);
      if (result[3].meta.changes !== 1) fail(409, 'account_capacity', 'The invitation cannot be redeemed at the current account limit.');
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) fail(409, 'account_conflict', 'Username is taken or the invitation was already used.');
      throw error;
    }
    userId = row.user_id;
  } else return fail(404, 'not_found', 'Route not found.');
  const created = await createSession(env, userId);
  const value = await me(env, created.actor);
  const response = json({ ...value, ...(accessKey ? { accessKey } : {}) });
  response.headers.set('set-cookie', sessionCookie(CONTROL_COOKIE, created.key, 7 * 86400));
  return response;
}
export async function createInvitation(env: Env, actor: Actor, expiresAt: unknown): Promise<unknown> {
  requireAdmin(actor);
  const expires = expiresAt === undefined ? Date.now() + 7 * 86400000 : integer(expiresAt, 'expiry', Date.now() + 60000, Date.now() + 30 * 86400000);
  const key = secret(), inviteId = id('i');
  await env.PNEUMA_SPACE_DB.prepare('INSERT INTO invitations(id,hash,user_id,tenant_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(inviteId, await sha(key), id('u'), id('t'), actor.user.id, Date.now(), expires).run();
  return { id: inviteId, url: env.PNEUMA_SPACE_CONTROL_ORIGIN + '/invite?code=' + key, expiresAt: expires };
}
export async function createToken(env: Env, actor: Actor, tenantId: string, body: Record<string, unknown>): Promise<unknown> {
  requireSession(actor); await tenantRole(env, actor, tenantId);
  const label = text(body.label, 'label', 80);
  if (!Array.isArray(body.scopes) || !body.scopes.length || body.scopes.some(x => !ACTIONS.includes(x))) fail(400, 'scopes', 'Choose valid credential actions.');
  const scopes: Action[] = [...new Set(body.scopes)];
  const appIds = body.appIds === null || body.appIds === undefined ? null : body.appIds;
  if (appIds !== null) {
    if (!Array.isArray(appIds) || !appIds.length || appIds.length > 50 || appIds.some(x => typeof x !== 'string')) fail(400, 'app_scope', 'Choose valid applications.');
    for (const appId of appIds) {
      const app = await authorizeApp(env, actor, appId, 'read');
      if (app.tenant_id !== tenantId) fail(400, 'app_scope', 'Application belongs to another tenant.');
    }
  }
  const expires = body.expiresAt === undefined ? Date.now() + 30 * 86400000 : integer(body.expiresAt, 'expiry', Date.now() + 60000, Date.now() + 365 * 86400000);
  const key = secret(), tokenId = id('k');
  const result = await env.PNEUMA_SPACE_DB.prepare('INSERT INTO tokens(id,hash,tenant_id,user_id,label,scopes_json,app_ids_json,expires_at,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM tokens WHERE user_id=? AND revoked_at IS NULL AND expires_at>?)<30').bind(tokenId, await sha(key), tenantId, actor.user.id, label, JSON.stringify(scopes), appIds === null ? null : JSON.stringify(appIds), expires, Date.now(), actor.user.id, Date.now()).run();
  if (!result.meta.changes) fail(409, 'token_limit', 'Revoke an existing credential before creating another.');
  return { id: tokenId, token: key, expiresAt: expires };
}
export async function appActor(request: Request, env: Env, app: AppRow): Promise<Actor | null> {
  if (request.headers.has('authorization')) {
    const actor = await authenticate(request, env);
    if (actor) await authorizeApp(env, actor, app.id, 'invoke');
    return actor;
  }
  const key = cookie(request, APP_COOKIE);
  if (!key || !/^[a-f0-9]{64}$/.test(key)) return null;
  const row = await env.PNEUMA_SPACE_DB.prepare('SELECT parent_hash FROM app_sessions WHERE hash=? AND app_id=? AND expires_at>?').bind(await sha(key), app.id, Date.now()).first<{ parent_hash: string }>();
  if (!row) return null;
  const actor = await proof(env, 'session', row.parent_hash);
  if (actor) await authorizeApp(env, actor, app.id, 'invoke');
  return actor;
}
export async function appLogin(request: Request, env: Env, app: AppRow): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/_pneuma-space/callback') {
    const nonce = cookie(request, NONCE_COOKIE), code = url.searchParams.get('code');
    if (!nonce || !code) fail(401, 'grant', 'Sign-in handshake is incomplete.');
    const row = await env.PNEUMA_SPACE_DB.prepare('SELECT * FROM grants WHERE hash=? AND app_id=? AND origin=? AND nonce_hash=? AND consumed_at IS NULL AND expires_at>?').bind(await sha(code), app.id, app.origin, await sha(nonce), Date.now()).first<{ hash: string; user_id: string; parent_hash: string; next_path: string }>();
    if (!row) fail(401, 'grant', 'Sign-in handshake is invalid or expired.');
    const actor = await proof(env, 'session', row.parent_hash);
    if (!actor) fail(401, 'grant', 'The parent session has ended.');
    await authorizeApp(env, actor, app.id, 'invoke');
    const key = secret(), now = Date.now(), grantHash = row.hash;
    const result = await env.PNEUMA_SPACE_DB.batch([
      env.PNEUMA_SPACE_DB.prepare('INSERT INTO app_sessions(hash,user_id,app_id,parent_hash,expires_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM grants WHERE hash=? AND consumed_at IS NULL AND expires_at>?)').bind(await sha(key), row.user_id, app.id, row.parent_hash, now + 86400000, grantHash, now),
      env.PNEUMA_SPACE_DB.prepare('UPDATE grants SET consumed_at=? WHERE hash=? AND consumed_at IS NULL AND expires_at>?').bind(now, grantHash, now),
    ]);
    if (result[1].meta.changes !== 1) fail(401, 'grant', 'Sign-in handshake was already used.');
    const response = new Response(null, { status: 303, headers: { location: app.origin + row.next_path, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    response.headers.append('set-cookie', sessionCookie(APP_COOKIE, key, 86400));
    response.headers.append('set-cookie', sessionCookie(NONCE_COOKIE, '', 0));
    return response;
  }
  const nonce = secret();
  const next = url.pathname === '/_pneuma-space/login' ? url.searchParams.get('next') ?? '/' : url.pathname + url.search;
  const safeNext = next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !/[\r\n]/.test(next) ? next : '/';
  const location = new URL('/_pneuma-space/authorize', env.PNEUMA_SPACE_CONTROL_ORIGIN);
  location.searchParams.set('app', app.id); location.searchParams.set('nonce', await sha(nonce)); location.searchParams.set('next', safeNext);
  return new Response(null, { status: 303, headers: { location: location.href, 'set-cookie': sessionCookie(NONCE_COOKIE, nonce, 300), 'cache-control': 'no-store' } });
}
export async function grantApp(request: Request, env: Env, actor: Actor | null): Promise<Response> {
  const url = new URL(request.url);
  if (!actor) return Response.redirect(env.PNEUMA_SPACE_CONTROL_ORIGIN + '/login?next=' + encodeURIComponent(url.pathname + url.search), 303);
  requireSession(actor);
  const app = await authorizeApp(env, actor, text(url.searchParams.get('app'), 'app'), 'invoke');
  const nonce = text(url.searchParams.get('nonce'), 'nonce', 64);
  if (!/^[a-f0-9]{64}$/.test(nonce)) fail(400, 'nonce', 'Invalid sign-in nonce.');
  const next = url.searchParams.get('next') ?? '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\r\n]/.test(next)) fail(400, 'next', 'Invalid return path.');
  const key = secret();
  await env.PNEUMA_SPACE_DB.prepare('INSERT INTO grants(hash,app_id,user_id,parent_hash,origin,nonce_hash,next_path,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(await sha(key), app.id, actor.user.id, actor.hash, app.origin, nonce, next, Date.now() + 60000).run();
  return new Response(null, { status: 303, headers: { location: app.origin + '/_pneuma-space/callback?code=' + key, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
