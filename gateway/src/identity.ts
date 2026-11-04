import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  LOGIN_PATH, LOGOUT_PATH, subject,
  type Challenge, type IdentityProvider, type Principal, type Subject, type Token,
} from './model.ts';

const COOKIE = 'pneuma_space_session';
const COOKIE_ATTRIBUTES = 'HttpOnly; SameSite=Lax; Path=/';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SECRET_BYTES = 32;
const USER_NAME = /^[a-z0-9_-]{1,32}$/;
const FORM_LIMIT = 4096;

export function loadOrCreateSecret(path: string): Buffer {
  try {
    writeFileSync(path, randomBytes(SECRET_BYTES), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  const secret = readFileSync(path);
  if (secret.length !== SECRET_BYTES) {
    throw new Error(`${path} holds ${secret.length} bytes, expected ${SECRET_BYTES}; delete it to generate a new one, which signs every browser out`);
  }
  return secret;
}

/** The Registry stores `hash` and shows `token` once. */
export function issueToken(name: string): { readonly token: string; readonly hash: string; readonly subject: Subject } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token), subject: subject(`service:${name}`) };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** M1 stub: the login name is self-reported, so a user subject identifies and does not authenticate (ADR 0008). */
export class LocalIdentity implements IdentityProvider {
  readonly #secret: Buffer;
  readonly #tokenByHash: (hash: string) => Token | null;

  constructor(secret: Buffer, tokenByHash: (hash: string) => Token | null) {
    this.#secret = secret;
    this.#tokenByHash = tokenByHash;
  }

  async authenticate(request: IncomingMessage): Promise<Principal | Challenge> {
    return this.#principal(request) ?? challenge(request);
  }

  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://gateway');
    if (url.pathname === LOGIN_PATH && request.method === 'GET') {
      page(response, 200, loginPage(safeNext(url.searchParams.get('next')), ''));
    } else if (url.pathname === LOGIN_PATH && request.method === 'POST') {
      await this.#login(request, response);
    } else if (url.pathname === LOGOUT_PATH) {
      redirect(response, LOGIN_PATH, `${COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`);
    } else {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
    }
  }

  #principal(request: IncomingMessage): Principal | null {
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const token = /^Bearer (\S+)$/i.exec(authorization)?.[1];
      const row = token === undefined ? null : this.#tokenByHash(sha256(token));
      return row && { subject: row.subject, name: row.subject.slice(row.subject.indexOf(':') + 1) };
    }
    return this.#session(request.headers.cookie);
  }

  #session(cookieHeader: string | undefined): Principal | null {
    const value = cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    const [payload, signature, extra] = value?.slice(COOKIE.length + 1).split('.') ?? [];
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.#sign(payload));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const session: { sub: Subject; name: string; iat: number } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!(Date.now() - session.iat < SESSION_SECONDS * 1000)) return null;
    return { subject: session.sub, name: session.name };
  }

  #sign(payload: string): string {
    return createHmac('sha256', this.#secret).update(payload).digest('base64url');
  }

  async #login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of request) if (body.length <= FORM_LIMIT) body += chunk;
    const form = new URLSearchParams(body);
    const name = form.get('name') ?? '';
    const next = safeNext(form.get('next'));
    if (!USER_NAME.test(name)) {
      page(response, 400, loginPage(next, 'Use 1 to 32 characters: lowercase letters, digits, _ and -.'));
      return;
    }
    const payload = Buffer.from(JSON.stringify({ sub: `user:${name}`, name, iat: Date.now() })).toString('base64url');
    redirect(response, next, `${COOKIE}=${payload}.${this.#sign(payload)}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_SECONDS}`);
  }
}

function challenge(request: IncomingMessage): Challenge {
  const browser = request.method === 'GET' && (request.headers.accept ?? '').includes('text/html');
  return browser ? { status: 303, location: `${LOGIN_PATH}?next=${encodeURIComponent(request.url ?? '/')}` } : { status: 401 };
}

/** Only app paths, so the login page cannot redirect off this gateway. */
function safeNext(next: string | null): string {
  return next !== null && /^\/apps\/[\x21-\x7e]*$/.test(next) ? next : '/';
}

function redirect(response: ServerResponse, location: string, cookie: string): void {
  response.writeHead(303, { location, 'set-cookie': cookie }).end();
}

function page(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(html);
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function loginPage(next: string, error: string): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · PneumaSpace</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:22rem;margin:18vh auto;padding:0 1rem;color:#1d1d1f}
input,button{font:inherit;padding:.5rem .6rem;border-radius:6px;border:1px solid #bbb;width:100%;box-sizing:border-box}
button{margin-top:.75rem;background:#1d1d1f;color:#fff;border-color:#1d1d1f;cursor:pointer}
.hint{color:#666;font-size:.875rem}.error{color:#b3261e}
</style>
<form method="post" action="${LOGIN_PATH}">
<h1>Sign in</h1>
<p class="hint">Apps on this machine see the name you type. There is no password.</p>
${error && `<p class="error">${escape(error)}</p>`}
<label>Name <input name="name" required pattern="[a-z0-9_\\-]{1,32}" maxlength="32" autocomplete="username" autofocus></label>
<input type="hidden" name="next" value="${escape(next)}">
<button>Continue</button>
</form>
</html>
`;
}
