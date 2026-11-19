import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { TokenRestrictions } from '../../gateway/src/hosted-model.ts';

export const control = new URL(process.env.PNEUMA_SPACE_HOSTED_TEST_CONTROL ?? 'http://localhost:58081');
const apps = process.env.PNEUMA_SPACE_HOSTED_TEST_APPS ?? 'http://*.apps.localhost:58080';
export const image = `${process.env.PNEUMA_SPACE_HOSTED_TEST_REGISTRY ? `${process.env.PNEUMA_SPACE_HOSTED_TEST_REGISTRY}/` : ''}pneuma-space-hosted-fixture/echo:${process.pid}`;
export const fixture = (name: string) => fileURLToPath(new URL(`../acceptance/fixtures/${name}/`, import.meta.url));
export const unique = () => `hosted-${randomBytes(5).toString('hex')}`;
export const appOrigin = (name: string) => apps.replace('*', name);
export type Reply = { status: number; headers: IncomingHttpHeaders; text: string };
export type Session = { cookie: string; csrf: string; subject: string; tenant: string };
export type Credential = { id: string; token: string };
export type App = { name: string; id: string; session: Session };
export type Publication = { image: string | null; manifest: unknown; bundle?: string | null };
type Restrictions = Partial<Omit<TokenRestrictions, 'appIds'>> & { appIds?: readonly string[] | null };

export function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
export function string(value: unknown): string { assert.ok(typeof value === 'string'); return value; }
export function rows(value: unknown): Record<string, unknown>[] { assert.ok(Array.isArray(value)); return value.map(record); }
export const json = (reply: Reply): unknown => JSON.parse(reply.text);
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const cookie = (reply: Reply, name: string): string => {
  const secure = control.protocol === 'https:';
  const key = secure ? `__Host-${name}` : name;
  const entry = reply.headers['set-cookie']?.find((value) => value.startsWith(`${key}=`));
  assert.ok(entry, `missing ${key} cookie from ${reply.status}`);
  if (secure) {
    assert.match(entry, /; Secure(?:;|$)/);
    assert.match(entry, /; HttpOnly(?:;|$)/);
    assert.match(entry, /; Path=\/(?:;|$)/);
    assert.doesNotMatch(entry, /; Domain=/i);
    assert.ok(!reply.headers['set-cookie']?.some((value) => value.startsWith(`${name}=`)));
  }
  return entry.split(';')[0]!;
};
export function request(target: URL, options: RequestOptions, response?: (value: IncomingMessage) => void) {
  assert.ok(['http:', 'https:'].includes(target.protocol));
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return transport({ host: '127.0.0.1', port: target.port || (target.protocol === 'https:' ? 443 : 80),
    servername: target.hostname, path: target.pathname + target.search, ...options,
    headers: { host: target.host, ...options.headers } }, response);
}
export function call(url: string | URL, method = 'GET', headers: Record<string, string> = {}, body?: string | Buffer, port?: number): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(target, { ...(port && { port }), method,
      headers: { connection: 'close', ...headers }, signal: AbortSignal.timeout(30_000) }, (response) => {
      const parts: Buffer[] = [];
      response.on('data', (part: Buffer) => parts.push(part));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
export function admin(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return call(new URL(path, control), method, { cookie: session.cookie, origin: control.origin, 'x-pneuma-space-csrf': session.csrf,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body === undefined ? undefined : JSON.stringify(body));
}
export async function login(user: string): Promise<Session> {
  const start = await call(new URL('/_pneuma-space/login', control));
  assert.equal(start.status, 200);
  const state = /name="state" value="([^"]+)"/.exec(start.text)?.[1];
  assert.ok(state);
  const finish = await call(new URL('/_pneuma-space/auth/development', control), 'POST', {
    cookie: cookie(start, 'pneuma-space-login'), origin: control.origin, 'content-type': 'application/x-www-form-urlencoded',
  }, new URLSearchParams({ state, user }).toString());
  assert.equal(finish.status, 303, finish.text);
  const sessionCookie = cookie(finish, 'pneuma-space-control');
  const reply = await call(new URL('/api/me', control), 'GET', { cookie: sessionCookie });
  assert.equal(reply.status, 200, reply.text);
  const me = record(json(reply));
  const tenant = Object.keys(record(me.roles))[0];
  assert.ok(tenant);
  return { cookie: sessionCookie, csrf: string(me.csrf), subject: string(me.subject), tenant };
}
export async function logout(session: Session): Promise<void> {
  const reply = await admin(session, 'POST', '/_pneuma-space/logout');
  assert.equal(reply.status, 204, reply.text);
}
export async function credential(t: TestContext, session: Session, restrictions?: Restrictions): Promise<Credential> {
  const path = `/api/tenants/${session.tenant}/tokens`;
  const reply = await admin(session, 'POST', path, { kind: 'personal', label: unique(), ...(restrictions && { restrictions }) });
  assert.equal(reply.status, 200, reply.text);
  const body = record(json(reply));
  const created = { id: string(body.id), token: string(body.token) };
  t.after(async () => {
    const revoked = await admin(session, 'DELETE', `${path}/${created.id}`);
    assert.equal(revoked.status, 200, revoked.text);
  });
  return created;
}
export async function publish(session: Session, name: string, publication: Publication): Promise<Reply> {
  return admin(session, 'PUT', `/api/apps/${name}/release`, { bundle: null, ...publication, tenant: session.tenant });
}
export async function deploy(t: TestContext, session: Session, publication: Publication): Promise<App> {
  const name = unique();
  const reply = await publish(session, name, publication);
  assert.equal(reply.status, 200, reply.text);
  t.after(async () => {
    const removed = await admin(session, 'POST', `/api/apps/${name}/remove`);
    assert.equal(removed.status, 200, removed.text);
    const purged = await admin(session, 'POST', `/api/apps/${name}/purge`, { confirm: name });
    assert.equal(purged.status, 200, purged.text);
  });
  const detail = await admin(session, 'GET', `/api/apps/${name}`);
  assert.equal(detail.status, 200, detail.text);
  return { name, id: string(record(record(json(detail)).app).id), session };
}
export async function bundle(session: Session, directory: string): Promise<string> {
  const tar = execFileSync('tar', ['--format', 'ustar', '-cf', '-', '-C', directory, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const reply = await call(new URL('/api/bundles', control), 'POST', { cookie: session.cookie, origin: control.origin, 'x-pneuma-space-csrf': session.csrf }, tar);
  assert.equal(reply.status, 200, reply.text);
  return string(record(json(reply)).bundle);
}
export async function appLogin(app: App, session = app.session): Promise<{ cookie: string; completion: string; nonce: string }> {
  const start = await call(`${appOrigin(app.name)}/_pneuma-space/login?next=%2F`);
  assert.equal(start.status, 303, start.text);
  const nonce = cookie(start, 'pneuma-space-nonce');
  const grant = await call(string(start.headers.location), 'GET', { cookie: session.cookie });
  assert.equal(grant.status, 303, grant.text);
  const completion = string(grant.headers.location);
  const finish = await call(completion, 'GET', { cookie: nonce });
  assert.equal(finish.status, 303, finish.text);
  assert.equal(finish.headers.location, '/');
  return { cookie: cookie(finish, 'pneuma-space-app'), completion, nonce };
}
export const visit = (app: App, token: string, path = '/', method = 'GET', body?: string) => call(appOrigin(app.name) + path, method, bearer(token), body);
export async function waitFor<T>(probe: () => Promise<T | null | false>, label: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}
export async function websocket(app: App, headers: Record<string, string>): Promise<{ status: number; socket: Socket | null }> {
  const target = new URL(`${appOrigin(app.name)}/ws?mode=echo`);
  return new Promise((resolve, reject) => {
    const req = request(target, {
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers }, signal: AbortSignal.timeout(10_000) });
    req.on('upgrade', (response, socket) => resolve({ status: response.statusCode ?? 0, socket }));
    req.on('response', (response) => { response.resume(); resolve({ status: response.statusCode ?? 0, socket: null }); });
    req.on('error', reject);
    req.end();
  });
}
export async function echo(socket: Socket, value: string): Promise<string> {
  const data = Buffer.from(value);
  assert.ok(data.length < 126);
  const mask = randomBytes(4);
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, Buffer.from(data.map((byte, i) => byte ^ mask[i % 4]!))]);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('no WebSocket echo')), 5000);
    socket.once('error', reject);
    let received = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 2 || received.length < 2 + (received[1]! & 0x7f)) return;
      clearTimeout(timeout);
      socket.off('data', read);
      resolve(received.subarray(2, 2 + (received[1]! & 0x7f)).toString());
    };
    socket.on('data', read);
    socket.write(frame);
  });
}

export function firstEvent(app: App, headers: Record<string, string>): Promise<string> {
  const target = new URL(appOrigin(app.name) + '/events');
  return new Promise((resolve, reject) => {
    const req = request(target, {
      headers, signal: AbortSignal.timeout(5000) }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`SSE answered ${response.statusCode}`)); return; }
      let text = '';
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const end = text.indexOf('\n\n');
        if (end === -1) return;
        resolve(text.slice(0, end));
        req.destroy();
      });
    });
    req.on('error', reject);
    req.end();
  });
}
