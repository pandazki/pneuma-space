import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Authority } from './authz.ts';
import type { HostedConfig } from './hosted-config.ts';
import type { HostedAccount, VerifiedHostedIdentity } from './hosted-model.ts';
import { HostedSessions, hostedHash, hostedSecret } from './hosted-sessions.ts';
import type { Answer, Auth, Failure, Identity } from './identity.ts';
import { LOGIN_PATH, LOGOUT_PATH, subject, type App } from './model.ts';

export const HOSTED_CALLBACK_PATH = '/_pneuma-space/auth/callback';
export const HOSTED_APP_PATH = '/_pneuma-space/auth/app';
export const HOSTED_COMPLETE_PATH = '/_pneuma-space/auth/complete';
export const HOSTED_DEVELOPMENT_PATH = '/_pneuma-space/auth/development';
export const HOSTED_IDENTITY_PATHS = [LOGIN_PATH, LOGOUT_PATH, HOSTED_CALLBACK_PATH, HOSTED_APP_PATH, HOSTED_COMPLETE_PATH, HOSTED_DEVELOPMENT_PATH];
export const HOSTED_COOKIE_NAMES = ['control', 'app', 'login', 'nonce'].flatMap((name) => [`__Host-pneuma-space-${name}`, `pneuma-space-${name}`]);

type Dependencies = {
  readonly tokens: Pick<Authority, 'token' | 'memberships'>;
  readonly register: (identity: VerifiedHostedIdentity) => Promise<HostedAccount>;
  readonly app: (name: string) => Promise<App | null>;
  readonly authorizeApp: (auth: Extract<Auth, { via: 'hosted' }>, app: App) => Promise<boolean>;
};
type Host = { readonly origin: string; readonly app: App | null };
const safePath = (value: string | null): string => value && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) ? value : '/';
const escape = (text: string): string => text.replace(/[&<>"']/g, (value) => `&#${value.charCodeAt(0)};`);

export class HostedIdentity implements Identity {
  readonly #config: HostedConfig;
  readonly #sessions: HostedSessions;
  readonly #deps: Dependencies;
  constructor(config: HostedConfig, sessions: HostedSessions, deps: Dependencies) { this.#config = config; this.#sessions = sessions; this.#deps = deps; }

  async #host(request: IncomingMessage): Promise<Host | null> {
    const host = request.headers.host;
    if (!host || host !== host.toLowerCase()) return null;
    const control = new URL(this.#config.controlOrigin);
    if (host === control.host) return { origin: control.origin, app: null };
    const { domain, port, scheme } = this.#config.appsOrigin;
    const suffix = `.${domain}${port}`;
    if (!host.endsWith(suffix)) return null;
    const name = host.slice(0, -suffix.length);
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) return null;
    const app = await this.#deps.app(name);
    return app && app.status === 'registered' && app.current !== null ? { origin: `${scheme}://${host}`, app } : null;
  }

  async identify(request: IncomingMessage): Promise<Auth | Failure> {
    const host = await this.#host(request);
    if (!host) return 'invalid';
    if (request.headers.authorization !== undefined) {
      const secret = /^Bearer (\S+)$/i.exec(request.headers.authorization)?.[1];
      const token = secret ? await this.#deps.tokens.token(hostedHash(secret)) : null;
      if (!token || token.revokedAt !== null || (token.restrictions && token.restrictions.expiresAt <= Date.now())) return 'invalid';
      if (token.subject.startsWith('user:') && !(await this.#deps.tokens.memberships(token.subject.slice(5))).some((m) => m.tenant === token.tenant)) return 'invalid';
      return { via: 'token', subject: token.subject, name: token.subject.slice(token.subject.indexOf(':') + 1), token };
    }
    const secret = this.#cookie(request, host, host.app ? 'app' : 'control');
    if (!secret) return 'absent';
    const record = await this.#sessions.read(secret, host.origin, host.app?.id);
    if (!record || (record.data.kind !== 'control' && record.data.kind !== 'app')) return 'invalid';
    return { via: 'hosted', subject: subject(`user:${record.data.user}`), name: record.data.name, sessionHash: record.hash, csrf: record.data.kind === 'control' ? record.data.csrf : null, origin: host.origin };
  }

  challenge(request: IncomingMessage): Answer {
    return request.method === 'GET' && (request.headers.accept ?? '').includes('text/html')
      ? { status: 303, location: `${LOGIN_PATH}?next=${encodeURIComponent(safePath(request.url ?? '/'))}` } : { status: 401 };
  }

  #cookieName(host: Host, name: string): string { return `${host.origin.startsWith('https:') ? '__Host-' : ''}pneuma-space-${name}`; }
  #cookie(request: IncomingMessage, host: Host, name: string): string | null {
    const key = `${this.#cookieName(host, name)}=`;
    const matches = (request.headers.cookie ?? '').split(';').map((value) => value.trim()).filter((value) => value.startsWith(key));
    return matches.length === 1 ? matches[0]!.slice(key.length) : null;
  }
  #setCookie(host: Host, name: string, value: string, seconds: number): string {
    return `${this.#cookieName(host, name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${host.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  #redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
    response.writeHead(303, { location, 'set-cookie': cookies, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();
  }
  #error(response: ServerResponse, status: number, error: string): void { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error })); }

  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = await this.#host(request);
    if (!host) return this.#error(response, 400, 'invalid hosted origin');
    const url = new URL(request.url ?? '/', host.origin);
    if (url.origin !== host.origin) return this.#error(response, 400, 'invalid request target');
    if (url.pathname === LOGOUT_PATH) {
      const auth = await this.identify(request);
      if (request.method !== 'POST' || host.app || typeof auth === 'string' || auth.via !== 'hosted' || request.headers.origin !== host.origin || request.headers['x-pneuma-space-csrf'] !== auth.csrf) return this.#error(response, 403, 'logout requires control session, Origin and CSRF');
      await this.#sessions.revoke(auth.sessionHash);
      response.writeHead(204, { 'set-cookie': this.#setCookie(host, 'control', '', 0), 'cache-control': 'no-store' }).end();
      return;
    }
    if (host.app) return this.#serveApp(request, response, host, url);
    if (url.pathname === HOSTED_DEVELOPMENT_PATH) return this.#development(request, response, host);
    if (request.method !== 'GET') return this.#error(response, 405, 'method not allowed');
    if (url.pathname === HOSTED_CALLBACK_PATH) return this.#callback(request, response, host, url);
    if (url.pathname === HOSTED_APP_PATH) return this.#grant(request, response, host, url);
    if (url.pathname !== LOGIN_PATH) return this.#error(response, 404, 'not found');
    const next = safePath(url.searchParams.get('next'));
    const auth = await this.identify(request);
    if (typeof auth !== 'string' && auth.via === 'hosted') return this.#redirect(response, next);
    const cookie = hostedSecret();
    const verifier = hostedSecret();
    const handshake = await this.#sessions.login(cookie, next, verifier);
    response.setHeader('set-cookie', this.#setCookie(host, 'login', cookie, 600));
    if (this.#config.development) {
      const zh = (request.headers['accept-language'] ?? '').startsWith('zh');
      const buttons = this.#config.developmentUsers.map((user) => `<button name="user" value="${escape(user)}">${escape(user)}</button>`).join('');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }).end(`<!doctype html><html lang="${zh ? 'zh' : 'en'}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${zh ? '登录' : 'Sign in'}</title><style>body{font:16px system-ui;max-width:28rem;margin:10vh auto;padding:24px}button{display:block;width:100%;padding:12px;margin:12px 0;font:inherit}</style><h1>${zh ? '登录 PneumaSpace' : 'Sign in to PneumaSpace'}</h1><p>${zh ? '本地开发账户' : 'Local development accounts'}</p><form method="post" action="${HOSTED_DEVELOPMENT_PATH}"><input type="hidden" name="state" value="${handshake.secret}">${buttons}</form></html>`);
      return;
    }
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.search = new URLSearchParams({ client_id: this.#config.github!.clientId, redirect_uri: `${host.origin}${HOSTED_CALLBACK_PATH}`, state: handshake.secret, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: '', prompt: 'select_account' }).toString();
    this.#redirect(response, authorize.href, [this.#setCookie(host, 'login', cookie, 600)]);
  }

  async #finish(response: ServerResponse, host: Host, identity: VerifiedHostedIdentity, next: string): Promise<void> {
    const account = await this.#deps.register(identity);
    const session = await this.#sessions.control(account.user, account.name, host.origin);
    this.#redirect(response, next, [this.#setCookie(host, 'control', session.secret, 7 * 86400), this.#setCookie(host, 'login', '', 0)]);
  }

  async #development(request: IncomingMessage, response: ServerResponse, host: Host): Promise<void> {
    if (!this.#config.development) return this.#error(response, 404, 'not found');
    if (request.method !== 'POST' || request.headers.origin !== host.origin) return this.#error(response, 403, 'exact Origin required');
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 4096) return this.#error(response, 413, 'form too large'); }
    const form = new URLSearchParams(body);
    const user = form.get('user') ?? '';
    const cookie = this.#cookie(request, host, 'login');
    const login = cookie ? await this.#sessions.consumeLogin(form.get('state') ?? '', cookie) : null;
    if (!login || !this.#config.developmentUsers.includes(user)) return this.#error(response, 401, 'invalid login');
    await this.#finish(response, host, { provider: 'development', subject: user, name: user }, login.returnPath);
  }

  async #callback(request: IncomingMessage, response: ServerResponse, host: Host, url: URL): Promise<void> {
    if (!this.#config.github) return this.#error(response, 404, 'not found');
    const cookie = this.#cookie(request, host, 'login');
    const login = cookie ? await this.#sessions.consumeLogin(url.searchParams.get('state') ?? '', cookie) : null;
    const code = url.searchParams.get('code');
    if (!login || !code || code.length > 2048 || url.searchParams.has('error')) return this.#error(response, 401, 'invalid login callback');
    let identity: VerifiedHostedIdentity;
    try {
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.#config.github.clientId, client_secret: this.#config.github.clientSecret, code, redirect_uri: `${host.origin}${HOSTED_CALLBACK_PATH}`, code_verifier: login.verifier }) });
      const token: unknown = await tokenResponse.json();
      if (!tokenResponse.ok || !token || typeof token !== 'object' || !('access_token' in token) || typeof token.access_token !== 'string') throw new Error('invalid token');
      const userResponse = await fetch('https://api.github.com/user', { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'pneuma-space', 'x-github-api-version': '2022-11-28' } });
      const user: unknown = await userResponse.json();
      if (!userResponse.ok || !user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0 || !('login' in user) || typeof user.login !== 'string') throw new Error('invalid GitHub identity');
      identity = { provider: 'github', subject: String(user.id), name: 'name' in user && typeof user.name === 'string' && user.name ? user.name : user.login };
    } catch { return this.#error(response, 502, 'GitHub sign-in failed'); }
    if (!this.#config.allowedSubjects.includes(identity.subject)) return this.#error(response, 403, 'account is not enabled on this platform');
    await this.#finish(response, host, identity, login.returnPath);
  }

  async #serveApp(request: IncomingMessage, response: ServerResponse, host: Host, url: URL): Promise<void> {
    if (request.method !== 'GET') return this.#error(response, 405, 'method not allowed');
    const app = host.app!;
    if (url.pathname === HOSTED_COMPLETE_PATH) {
      const nonce = this.#cookie(request, host, 'nonce');
      const session = nonce ? await this.#sessions.redeem(url.searchParams.get('code') ?? '', app.id, host.origin, nonce) : null;
      if (!session) return this.#error(response, 401, 'invalid app grant');
      return this.#redirect(response, session.returnPath, [this.#setCookie(host, 'app', session.secret, 7 * 86400), this.#setCookie(host, 'nonce', '', 0)]);
    }
    if (url.pathname !== LOGIN_PATH) return this.#error(response, 404, 'not found');
    const nonce = hostedSecret();
    const central = new URL(HOSTED_APP_PATH, this.#config.controlOrigin);
    central.search = new URLSearchParams({ app: app.name, origin: host.origin, nonce, next: safePath(url.searchParams.get('next')) }).toString();
    this.#redirect(response, central.href, [this.#setCookie(host, 'nonce', nonce, 600)]);
  }

  async #grant(request: IncomingMessage, response: ServerResponse, host: Host, url: URL): Promise<void> {
    const auth = await this.identify(request);
    if (typeof auth === 'string' || auth.via !== 'hosted') return this.#redirect(response, `${LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`);
    const name = url.searchParams.get('app') ?? '';
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) return this.#error(response, 400, 'invalid app name');
    const app = await this.#deps.app(name);
    const { scheme, domain, port } = this.#config.appsOrigin;
    const origin = app ? `${scheme}://${app.name}.${domain}${port}` : '';
    const nonce = url.searchParams.get('nonce') ?? '';
    if (!app || app.status !== 'registered' || app.current === null || url.searchParams.get('origin') !== origin || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return this.#error(response, 400, 'invalid app login');
    if (!await this.#deps.authorizeApp(auth, app)) return this.#error(response, 403, 'app access denied');
    const grant = await this.#sessions.grant(auth.sessionHash, app.id, origin, nonce, safePath(url.searchParams.get('next')));
    if (!grant) return this.#error(response, 401, 'session expired');
    this.#redirect(response, `${origin}${HOSTED_COMPLETE_PATH}?code=${encodeURIComponent(grant.secret)}`);
  }
}
