import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
const APP = 'survey';
const INTERNAL = 'pneuma-space-survey.internal';
const CONTENT_TYPE = 'text/csv; charset=utf-8';
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const bytes = (value) => new TextEncoder().encode(value);
const hex = (data) => [...new Uint8Array(data)].map((v) => v.toString(16).padStart(2, '0')).join('');
const sha = async (value) => hex(await crypto.subtle.digest('SHA-256', bytes(value)));
const validSubject = (s) => typeof s === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(s);
const validAnswer = (a) => a && ['great', 'ok', 'poor'].includes(a.q1) && ['office', 'hybrid', 'remote'].includes(a.q2) && ['pay', 'growth', 'culture'].includes(a.q3);
const answerRow = (r) => r && ({ subject: r.subject, q1: r.q1, q2: r.q2, q3: r.q3, submittedAt: r.submitted_at });
const objectKey = (id) => `apps/${APP}/exports/${id}.csv`;
const signerReady = (env) => !!(env.PNEUMA_SPACE_R2_ACCOUNT_ID && env.PNEUMA_SPACE_R2_ACCESS_KEY_ID && env.PNEUMA_SPACE_R2_SECRET_ACCESS_KEY);
const languageCookie = (request) => /(?:^|;\s*)lang=(en|zh)(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1];
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, bytes(value));
}
async function ticket(env, method, id) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const host = `${env.PNEUMA_SPACE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${env.PNEUMA_SPACE_OBJECT_BUCKET}/${objectKey(id)}`;
  const signedHeaders = method === 'PUT' ? 'content-type;host' : 'host';
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.PNEUMA_SPACE_R2_ACCESS_KEY_ID}/${day}/auto/s3/aws4_request`,
    'X-Amz-Date': stamp, 'X-Amz-Expires': '180', 'X-Amz-SignedHeaders': signedHeaders,
  });
  query.sort();
  const canonicalHeaders = method === 'PUT' ? `content-type:${CONTENT_TYPE}\nhost:${host}\n` : `host:${host}\n`;
  const canonical = [method, path, query.toString(), canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha(canonical)].join('\n');
  let key = bytes(`AWS4${env.PNEUMA_SPACE_R2_SECRET_ACCESS_KEY}`);
  for (const part of [day, 'auto', 's3', 'aws4_request']) key = await hmac(key, part);
  query.set('X-Amz-Signature', hex(await hmac(key, stringToSign)));
  return { url: `https://${host}${path}?${query}`, headers: method === 'PUT' ? { 'content-type': CONTENT_TYPE } : {}, expiresAt: new Date(now.getTime() + 180000).toISOString() };
}
async function boundedText(request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(result);
}
async function input(request) {
  const raw = await boundedText(request);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export class SurveyStorage extends WorkerEntrypoint {
  async fetch(request) {
    if (new URL(request.url).host !== INTERNAL) return json({ error: 'host' }, 404);
    const app = this.ctx.props.app;
    if (app !== APP) return json({ error: 'scope' }, 403);
    const path = new URL(request.url).pathname;
    const db = this.env.PNEUMA_SPACE_DB;
    if (path === '/mine' && request.method === 'POST') {
      const value = await input(request);
      if (!validSubject(value?.subject)) return json({ error: 'subject' }, 400);
      const row = await db.prepare('SELECT subject,q1,q2,q3,submitted_at FROM answer WHERE app=? AND subject=?').bind(app, value.subject).first();
      return json(answerRow(row));
    }
    if (path === '/save' && request.method === 'POST') {
      const value = await input(request);
      if (!validSubject(value?.subject) || !validAnswer(value?.answer)) return json({ error: 'answer' }, 400);
      const a = value.answer;
      await db.prepare('INSERT INTO answer (app,subject,q1,q2,q3,submitted_at) VALUES (?,?,?,?,?,?) ON CONFLICT(app,subject) DO UPDATE SET q1=excluded.q1,q2=excluded.q2,q3=excluded.q3,submitted_at=excluded.submitted_at')
        .bind(app, value.subject, a.q1, a.q2, a.q3, new Date().toISOString()).run();
      return json({ ok: true });
    }
    if (path === '/results' && request.method === 'GET') {
      const rows = await db.prepare('SELECT subject,q1,q2,q3,submitted_at FROM answer WHERE app=? ORDER BY subject LIMIT 101').bind(app).all();
      return rows.results.length > 100 ? json({ error: 'result limit' }, 409) : json({ answers: rows.results.map(answerRow) });
    }
    if (path === '/export-state' && request.method === 'GET') {
      const r = await db.prepare("SELECT id,bytes,created_at FROM export WHERE app=? AND status='ready' ORDER BY created_at DESC,id DESC LIMIT 1").bind(app).first();
      return json(r ? { status: 'ready', value: { id: r.id, bytes: r.bytes, createdAt: r.created_at } } : { status: 'none' });
    }
    return json({ error: 'operation' }, 404);
  }
}
export class SurveyContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container.running) ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(30000));
  }
  async start() {
    const c = this.ctx.container;
    if (!c.running) {
      await c.interceptOutboundHttp(INTERNAL, this.ctx.exports.SurveyStorage({ props: { app: APP } }));
      const image = await this.ctx.storage.get('image') ?? 'v1';
      c.start({ image: c.images[image], instance: 'lite', enableInternet: false });
      await this.ctx.storage.put('lastStart', { image, at: new Date().toISOString() });
    }
    await c.setInactivityTimeout(30000);
    const port = c.getTcpPort(8080);
    for (let i = 0; i < 100; i++) {
      try {
        const r = await port.fetch('http://container/_pneuma-space/meta', { signal: AbortSignal.timeout(1000) });
        await r.body?.cancel();
        if (r.ok) return port;
      } catch {}
      await scheduler.wait(200);
    }
    throw new Error('survey container did not start');
  }
  async fetch(request) {
    const url = new URL(request.url);
    const c = this.ctx.container;
    if (url.pathname === '/_pneuma-space/control/status') return json({ running: c.running, image: await this.ctx.storage.get('image') ?? 'v1', lastStart: await this.ctx.storage.get('lastStart'), calls: await this.ctx.storage.get('calls') ?? 0 });
    const calls = (await this.ctx.storage.get('calls') ?? 0) + 1;
    await this.ctx.storage.put('calls', calls);
    if (calls > Number(this.env.PNEUMA_SPACE_MAX_REQUESTS ?? 2000)) return json({ error: 'request limit' }, 429);
    if (url.pathname === '/_pneuma-space/budget' && request.method === 'POST') return new Response(null, { status: 204 });
    if (url.pathname === '/_pneuma-space/control/kill' && request.method === 'POST') {
      if (c.running) { c.signal(9); try { await c.monitor(); } catch {} }
      return json({ running: c.running });
    }
    if ((url.pathname === '/_pneuma-space/control/image/v1' || url.pathname === '/_pneuma-space/control/image/v2') && request.method === 'POST') {
      if (c.running) await c.destroy();
      const image = url.pathname.endsWith('/v1') ? 'v1' : 'v2';
      await this.ctx.storage.put('image', image);
      return json({ image });
    }
    const port = await this.start();
    url.protocol = 'http:'; url.host = 'container';
    const forwarded = new Request(url, request);
    for (const h of [...forwarded.headers.keys()]) if (h.startsWith('x-pneuma-space-') || ['authorization', 'cookie', 'host'].includes(h)) forwarded.headers.delete(h);
    const lang = languageCookie(request);
    if (lang) forwarded.headers.set('cookie', `lang=${lang}`);
    forwarded.headers.set('x-pneuma-space-subject', request.headers.get('x-pneuma-space-trusted-subject'));
    forwarded.headers.set('x-pneuma-space-name', request.headers.get('x-pneuma-space-trusted-name'));
    forwarded.headers.set('x-pneuma-space-owner', request.headers.get('x-pneuma-space-trusted-owner'));
    const response = await port.fetch(forwarded);
    const headers = new Headers(response.headers); headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
}
async function cookieSignature(env, value) {
  return hex(await hmac(bytes(env.PNEUMA_SPACE_COOKIE_KEY), value));
}
async function identity(request, env) {
  const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (token) {
    const digest = await sha(token);
    if (digest === env.PNEUMA_SPACE_OWNER_TOKEN_HASH) return { subject: 'pandazki', name: 'pandazki', owner: true };
    if (digest === env.PNEUMA_SPACE_MEMBER_TOKEN_HASH) return { subject: 'member', name: 'Member', owner: false };
    return null;
  }
  const cookie = /(?:^|; )pneuma-space-session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
  if (!cookie) return null;
  const [role, expiry, signature] = cookie.split('.');
  if (!['owner', 'member'].includes(role) || !/^\d{13}$/.test(expiry) || Number(expiry) < Date.now()) return null;
  if (signature !== await cookieSignature(env, `${role}.${expiry}`)) return null;
  return role === 'owner' ? { subject: 'pandazki', name: 'pandazki', owner: true } : { subject: 'member', name: 'Member', owner: false };
}
async function operator(request, env) {
  const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  return !!token && await sha(token) === env.PNEUMA_SPACE_OPERATOR_TOKEN_HASH;
}
async function ownerApi(request, env, path) {
  if (path === '/_pneuma-space/export/availability' && request.method === 'GET') return json({ enabled: signerReady(env), reason: signerReady(env) ? null : 'Scoped R2 S3 signing credentials are not configured' });
  if (path === '/_pneuma-space/export/rows' && request.method === 'GET') {
    const rows = await env.PNEUMA_SPACE_DB.prepare('SELECT subject,q1,q2,q3,submitted_at FROM answer WHERE app=? ORDER BY subject LIMIT 101').bind(APP).all();
    return rows.results.length > 100 ? json({ error: 'result limit' }, 409) : json({ answers: rows.results.map(answerRow) });
  }
  if (!['POST /_pneuma-space/export/begin', 'POST /_pneuma-space/export/complete', 'GET /_pneuma-space/export/download'].includes(`${request.method} ${path}`)) return json({ error: 'operation' }, 404);
  if (!signerReady(env)) return json({ error: 'R2 signing credentials unavailable' }, 503);
  if (path === '/_pneuma-space/export/begin' && request.method === 'POST') {
    const value = await input(request);
    if (!Number.isSafeInteger(value?.bytes) || value.bytes < 1 || value.bytes > 65536) return json({ error: 'export size' }, 400);
    const id = crypto.randomUUID();
    await env.PNEUMA_SPACE_DB.prepare("INSERT INTO export (app,id,status,bytes,created_at) VALUES (?,?,'pending',?,?)").bind(APP, id, value.bytes, new Date().toISOString()).run();
    return json({ id, ...await ticket(env, 'PUT', id) });
  }
  if (path === '/_pneuma-space/export/complete' && request.method === 'POST') {
    const value = await input(request);
    if (!/^[0-9a-f-]{36}$/.test(value?.id ?? '')) return json({ error: 'export id' }, 400);
    const r = await env.PNEUMA_SPACE_DB.prepare('SELECT id,status,bytes,created_at FROM export WHERE app=? AND id=?').bind(APP, value.id).first();
    if (!r) return json({ error: 'export id' }, 404);
    if (r.status === 'pending') {
      const object = await env.PNEUMA_SPACE_OBJECTS.head(objectKey(r.id));
      if (!object || object.size !== r.bytes || object.httpMetadata?.contentType !== CONTENT_TYPE) return json({ error: 'upload missing or does not match size and type' }, 409);
      await env.PNEUMA_SPACE_DB.prepare("UPDATE export SET status='ready' WHERE app=? AND id=? AND status='pending'").bind(APP, r.id).run();
    }
    return json({ id: r.id, bytes: r.bytes, createdAt: r.created_at });
  }
  if (path === '/_pneuma-space/export/download' && request.method === 'GET') {
    const r = await env.PNEUMA_SPACE_DB.prepare("SELECT id FROM export WHERE app=? AND status='ready' ORDER BY created_at DESC,id DESC LIMIT 1").bind(APP).first();
    return r ? json(await ticket(env, 'GET', r.id)) : json({ error: 'no saved export' }, 404);
  }
  return json({ error: 'operation' }, 404);
}
export default {
  async fetch(request, env, ctx) {
    if (Date.now() > Number(env.PNEUMA_SPACE_EXPIRES)) return json({ error: 'demo expired' }, 410);
    const url = new URL(request.url);
    const path = url.pathname;
    if (['/app.css', '/ui.css', '/ui.js', '/export.js', '/csv.js'].includes(path) && request.method === 'GET') return env.PNEUMA_SPACE_ASSETS.fetch(request);
    if (path === '/login' && request.method === 'GET') {
      const zh = languageCookie(request) === 'zh' || /^\s*zh/i.test(request.headers.get('accept-language') ?? '');
      return new Response(`<!doctype html><html lang="${zh ? 'zh' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${zh ? '问卷登录' : 'Survey login'}</title><style>body{font:16px system-ui;max-width:24rem;margin:12vh auto;padding:1.5rem;color:#17213b}form{display:grid;gap:1rem}input,button{font:inherit;padding:.65rem;border-radius:.4rem}button{background:#17213b;color:white;cursor:pointer}</style><h1>${zh ? '公司问卷' : 'Company survey'}</h1><form method="post"><input type="hidden" name="user" value="owner"><label>${zh ? '访问密钥' : 'Access key'}<input name="key" type="password" required autocomplete="current-password"></label><button>${zh ? '登录' : 'Sign in'}</button></form></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path === '/login' && request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'origin' }, 403);
      const raw = await boundedText(request); if (raw === null) return json({ error: 'body limit' }, 413);
      const form = new URLSearchParams(raw); const role = form.get('user'); const key = form.get('key') ?? '';
      const expected = role === 'owner' ? env.PNEUMA_SPACE_OWNER_TOKEN_HASH : role === 'member' ? env.PNEUMA_SPACE_MEMBER_TOKEN_HASH : '';
      if (!expected || await sha(key) !== expected) return json({ error: 'unauthorized' }, 401);
      const expiry = String(Date.now() + 12 * 3600000);
      const value = `${role}.${expiry}.${await cookieSignature(env, `${role}.${expiry}`)}`;
      return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `pneuma-space-session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200` } });
    }
    if (path.startsWith('/_pneuma-space/control/')) {
      if (!await operator(request, env)) return json({ error: 'unauthorized' }, 401);
      if (path === '/_pneuma-space/control/storage-probe' && request.method === 'GET') {
        const fixture = await env.PNEUMA_SPACE_DB.prepare('SELECT q1,q2,q3 FROM answer WHERE app=? AND subject=?').bind('other', 'cf-other-scope-probe').first();
        const mineRequest = new Request(`http://${INTERNAL}/mine`, { method: 'POST', body: JSON.stringify({ subject: 'cf-other-scope-probe' }) });
        const allowed = await ctx.exports.SurveyStorage({ props: { app: APP } }).fetch(mineRequest.clone());
        const forbidden = await ctx.exports.SurveyStorage({ props: { app: 'other' } }).fetch(mineRequest);
        const unknown = await ctx.exports.SurveyStorage({ props: { app: APP } }).fetch(new Request(`http://${INTERNAL}/sql`, { method: 'POST', body: JSON.stringify({ sql: 'DROP TABLE answer', app: 'other' }) }));
        return json({ fixturePresent: fixture?.q1 === 'poor' && fixture.q2 === 'remote' && fixture.q3 === 'culture', allowed: { status: allowed.status, foreignSubjectAbsent: await allowed.json() === null }, forbidden: forbidden.status, unknown: unknown.status });
      }
      return env.PNEUMA_SPACE_CONTAINER.getByName('only-survey-instance').fetch(request);
    }
    const user = await identity(request, env);
    if (!user) return request.headers.get('accept')?.includes('text/html') ? Response.redirect(url.origin + '/login', 303) : json({ error: 'unauthorized' }, 401);
    if (request.method !== 'GET' && !request.headers.has('authorization') && request.headers.get('origin') !== url.origin) return json({ error: 'origin' }, 403);
    if (request.headers.has('origin') && request.headers.get('origin') !== url.origin) return json({ error: 'origin' }, 403);
    if (path === '/results' || path.startsWith('/_pneuma-space/export/')) {
      if (!user.owner) return json({ error: 'owner only' }, 403);
      if (path.startsWith('/_pneuma-space/export/')) {
        const instance = env.PNEUMA_SPACE_CONTAINER.getByName('only-survey-instance');
        const budget = await instance.fetch('https://container/_pneuma-space/budget', { method: 'POST' });
        if (!budget.ok) return budget;
        return ownerApi(request, env, path);
      }
    }
    if (!['GET /', 'POST /answer', 'GET /results', 'GET /_pneuma-space/meta'].includes(`${request.method} ${path}`)) return json({ error: 'path' }, 404);
    if (path === '/answer' && request.method === 'POST') {
      const raw = await boundedText(request);
      if (raw === null) return json({ error: 'body limit' }, 413);
      const headers = new Headers(request.headers); headers.delete('content-length');
      request = new Request(request.url, { method: request.method, headers, body: raw, redirect: 'manual' });
    }
    const forwarded = new Request(request);
    for (const h of [...forwarded.headers.keys()]) if (h.startsWith('x-pneuma-space-') || ['authorization', 'cookie'].includes(h)) forwarded.headers.delete(h);
    const lang = languageCookie(request);
    if (lang) forwarded.headers.set('cookie', `lang=${lang}`);
    forwarded.headers.set('x-pneuma-space-trusted-subject', user.subject);
    forwarded.headers.set('x-pneuma-space-trusted-name', user.name);
    forwarded.headers.set('x-pneuma-space-trusted-owner', user.owner ? '1' : '0');
    return env.PNEUMA_SPACE_CONTAINER.getByName('only-survey-instance').fetch(forwarded);
  },
};
