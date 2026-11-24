export { AppCell, AppServices } from './app.ts';
import { authenticate, authRoute, authorizeApp, me, protectWrite, requireAdmin, requireSession } from './auth.ts';
import { artifactUsage, beginUpload, publishUpload, staticResponse } from './artifacts.ts';
import { controlRoute, operationKey } from './control.ts';
import { admitRequest, appSummary, audit, cell, cellValue } from './directory.ts';
import { type Actor, type AppAction, type AppRow, type AppSnapshot, type Policy, fail } from './model.ts';
import { boundedBody, errorResponse, input, json, record, text } from './util.ts';

function method(request: Request, expected: string): void {
  if (request.method !== expected) fail(405, 'method', 'Use ' + expected + '.');
}
function action(value: Record<string, unknown>): AppAction {
  switch (value.type) {
    case 'wake': case 'sleep': case 'restart': case 'kill': case 'remove': case 'resume': case 'unquarantine':
      return { type: value.type };
    case 'purge': return { type: 'purge', confirmation: text(value.confirmation, 'application name', 40) };
    case 'rollback':
      if (!Number.isSafeInteger(value.release) || Number(value.release) < 1) fail(400, 'release', 'Choose a release number.');
      return { type: 'rollback', release: Number(value.release) };
    case 'policy': {
      const supplied = record(value.policy), policy: Partial<Policy> = {};
      for (const [key, v] of Object.entries(supplied)) {
        if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(400, 'policy', 'Policy values must be integers.');
        switch (key) {
          case 'idleSeconds': case 'requestSeconds': case 'drainSeconds': case 'maxFailures': case 'requestsPerDay': case 'storageBytes':
            policy[key] = v; break;
          default: fail(400, 'policy', 'Unknown policy setting.');
        }
      }
      return { type: 'policy', policy };
    }
    default: return fail(400, 'action', 'Unknown application action.');
  }
}
async function appControl(request: Request, env: Env, actor: Actor, appId: string, section?: string): Promise<Response> {
  const next = section === 'actions' && request.method === 'POST' ? action(await input(request, 4096)) : null;
  const permission = next ? next.type === 'purge' || next.type === 'kill' ? next.type : next.type === 'remove' ? 'remove' : 'manage' : section === 'data' ? 'data' : section === 'jobs' && request.method === 'POST' ? 'manage' : section === 'uploads' || (section === 'releases' && request.method === 'POST') ? 'publish' : 'read';
  const app = await authorizeApp(env, actor, appId, permission);
  if (!section) {
    method(request, 'GET');
    const snapshot = await cellValue<AppSnapshot>(env, app.id, '/inspect');
    return json({ ...appSummary(env, app), ...snapshot });
  }
  if (section === 'actions') {
    method(request, 'POST');
    if (!next) fail(400, 'action', 'Choose an action.');
    const result = await cellValue(env, app.id, '/action', { actor, action: next, idempotencyKey: operationKey(request) });
    await audit(env, actor, 'app.' + next.type, app.tenant_id, app.id);
    return json(result);
  }
  if (section === 'uploads') {
    method(request, 'POST');
    return json(await beginUpload(env, actor, app, await input(request, 8192)), 201);
  }
  if (section === 'releases') {
    if (request.method === 'GET') return json({ items: (await cellValue<AppSnapshot>(env, app.id, '/inspect')).releases });
    method(request, 'POST');
    return json(await publishUpload(env, actor, app, (await input(request, 4096)).uploadId, operationKey(request)));
  }
  if (section === 'data') {
    method(request, 'POST');
    return cell(env, app.id, '/data', { actor, command: await input(request, 256 * 1024) });
  }
  if (section === 'jobs' && request.method === 'POST') {
    const body = await input(request, 64 * 1024);
    const result = await cellValue(env, app.id, '/jobs', { actor, name: body.name, payload: body.payload, idempotencyKey: operationKey(request) });
    await audit(env, actor, 'job.create', app.tenant_id, app.id); return json(result, 201);
  }
  if (['state', 'logs', 'events', 'usage', 'jobs'].includes(section)) {
    method(request, 'GET');
    if (section === 'state') return json({ ...await cellValue<Record<string, unknown>>(env, app.id, '/inspect/state'), artifacts: await artifactUsage(env, app.id) });
    return cell(env, app.id, section === 'state' ? '/inspect/state' : '/' + section);
  }
  return fail(404, 'not_found', 'Route not found.');
}
async function api(request: Request, env: Env, actor: Actor | null, path: string): Promise<Response> {
  const auth = /^\/auth\/(login|redeem|logout)$/.exec(path);
  if (auth) return authRoute(request, env, auth[1], actor);
  if (!actor) fail(401, 'unauthorized', 'Sign in to continue.');
  if (!['GET', 'HEAD'].includes(request.method)) protectWrite(request, env, actor);
  if (path === '/me') { method(request, 'GET'); return json(await me(env, actor)); }
  const app = /^\/apps\/([a-zA-Z0-9_-]+)(?:\/([a-z]+))?$/.exec(path);
  if (app) return appControl(request, env, actor, app[1], app[2]);
  return await controlRoute(request, env, actor, path) ?? fail(404, 'not_found', 'Route not found.');
}
async function control(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  const actor = await authenticate(request, env);
  if (path.startsWith('/api/v1/')) return api(request, env, actor, path.slice('/api/v1'.length));
  const app = /^\/apps\/([^/]+)(\/.*)?$/.exec(path);
  if (app) return app[2] ? application(request, env, actor, app[1], app[2]) : Response.redirect(url.origin + path + '/' + url.search, 308);
  if (path === '/_pneuma-space/health') { method(request, 'GET'); return json({ service: 'pneuma-space-cf' }); }
  if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'method', 'Use GET or HEAD.');
  if (path === '/') return Response.redirect(url.origin + (actor ? actor.user.platformAdmin ? '/admin' : '/dashboard' : '/login'), 303);
  let asset = path;
  if (/^\/(?:admin|dashboard)(?:\/|$)/.test(path)) {
    if (!actor) return login(url);
    requireSession(actor);
    if (path === '/admin' || path.startsWith('/admin/')) requireAdmin(actor);
    asset = '/index.html';
  } else if (path === '/login' || path === '/invite') asset = path + '.html';
  else if (path === '/_pneuma-space/console/app.js' || path === '/_pneuma-space/console/style.css') asset = path.slice('/_pneuma-space/console'.length);
  else if (path !== '/downloads/cli.json' && !/^\/downloads\/pneuma-space-cli-\d+\.\d+\.\d+-[a-f0-9]{12}\.tgz$/.test(path)) fail(404, 'not_found', 'Route not found.');
  const target = new URL(asset, url.origin);
  const result = await env.PNEUMA_SPACE_UI.fetch(new Request(target, { method: request.method }));
  const response = new Response(result.body, result);
  response.headers.set('cache-control', 'no-store');
  response.headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}
const login = (url: URL): Response => Response.redirect(url.origin + '/login?next=' + encodeURIComponent(url.pathname + url.search), 303);
export function guestHeaders(request: Request, actor: Actor, identity: boolean, app: AppRow): Headers {
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) if (key.startsWith('x-pneuma-space-') || key === 'authorization' || key === 'proxy-authorization') headers.delete(key);
  const cookies = (headers.get('cookie') ?? '').split(';').map(item => item.trim()).filter(item => item && !item.startsWith('__Host-pneuma-space-'));
  if (cookies.length) headers.set('cookie', cookies.join('; ')); else headers.delete('cookie');
  if (identity) {
    headers.set('x-pneuma-space-subject', actor.user.id);
    headers.set('x-pneuma-space-name', encodeURIComponent(actor.user.name));
    headers.set('x-pneuma-space-owner', String(actor.user.id === app.owner_id));
  }
  headers.set('x-forwarded-prefix', '/apps/' + app.name);
  return headers;
}
export function guestResponse(result: Response): Response {
  const headers = new Headers(result.headers), cookies = headers.getSetCookie();
  headers.delete('set-cookie');
  headers.delete('service-worker-allowed');
  for (const cookie of cookies) {
    const parts = cookie.split(';');
    if (/^__Host-pneuma-space-/i.test(parts[0].trim())) continue;
    headers.append('set-cookie', parts.filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part)).join(';'));
  }
  headers.set('cache-control', 'private, no-store');
  headers.set('referrer-policy', 'same-origin');
  return new Response(result.body, { status: result.status, statusText: result.statusText, headers, ...(result.webSocket ? { webSocket: result.webSocket } : {}) });
}
async function application(request: Request, env: Env, actor: Actor | null, name: string, path: string): Promise<Response> {
  if (!actor) {
    if (request.method === 'GET' && !request.headers.has('authorization') && request.headers.get('upgrade') === null && request.headers.get('accept')?.includes('text/html')) return login(new URL(request.url));
    fail(401, 'unauthorized', 'Sign in to this application.');
  }
  const row = await env.PNEUMA_SPACE_DB.prepare('SELECT id FROM apps WHERE name=? AND purged_at IS NULL').bind(name).first<{ id: string }>();
  const app = await authorizeApp(env, actor, row?.id ?? fail(404, 'app_not_found', 'Application not found.'), 'invoke');
  if (actor.kind === 'session' && (!['GET', 'HEAD'].includes(request.method) || request.headers.get('upgrade')?.toLowerCase() === 'websocket') && request.headers.get('origin') !== env.PNEUMA_SPACE_CONTROL_ORIGIN) fail(403, 'origin', 'The request origin is not allowed.');
  const snapshot = await cellValue<AppSnapshot>(env, app.id, '/inspect');
  if (snapshot.status !== 'registered' || !snapshot.current) fail(409, 'inactive', 'Application is not active.');
  await admitRequest(env, app.tenant_id);
  const realtime = /^\/_pneuma-space\/realtime\/([^/]+)$/.exec(path);
  if (realtime) {
    const target = new URL('/subscribe/' + realtime[1], 'https://cell');
    const headers = guestHeaders(request, actor, false, app);
    headers.set('x-pneuma-space-actor', encodeURIComponent(JSON.stringify({ kind: actor.kind, hash: actor.hash })));
    return env.PNEUMA_SPACE_APPS.getByName(app.id).fetch(new Request(target, { method: 'GET', headers }));
  }
  if (path.startsWith('/_pneuma-space/')) fail(404, 'reserved_path', 'This path is reserved.');
  if (['GET', 'HEAD'].includes(request.method) && snapshot.capabilities.includes('static')) {
    const response = await staticResponse(env, app.id, snapshot.current, request, path);
    if (response) {
      const admission = await cell(env, app.id, '/admit', { expectedGeneration: snapshot.generation });
      if (!admission.ok) { await response.body?.cancel(); return admission; }
      return response;
    }
  }
  if (snapshot.current.manifest.runtime === 'static') fail(404, 'not_found', 'File not found.');
  const body = request.body ? await boundedBody(request) : null;
  const url = new URL(request.url);
  url.pathname = '/_pneuma-space/invoke' + path;
  const result = await env.PNEUMA_SPACE_APPS.getByName(app.id).fetch(new Request(url, {
    method: request.method, headers: guestHeaders(request, actor, snapshot.capabilities.includes('identity'), app), body,
    redirect: 'manual',
  }));
  return guestResponse(result);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (new URL(request.url).origin !== env.PNEUMA_SPACE_CONTROL_ORIGIN) fail(404, 'host', 'Unknown hostname.');
      return await control(request, env);
    } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<Env>;
