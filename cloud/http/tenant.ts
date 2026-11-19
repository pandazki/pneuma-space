import { asObject, onlyKeys } from '../../shared/catalog.ts';
import { appName, type AppId, type TenantName } from '../../shared/values.ts';
import { createArchive, parseArchive, prepareArtifact } from '../core/artifacts.ts';
import type { CloudConfig } from '../core/config.ts';
import { randomSecret, sha256 } from '../core/crypto.ts';
import { CloudError, forbidden, invalid, missing } from '../core/errors.ts';
import { parseCredential, type AuthenticatedSession, type CreatedSession } from '../core/identity-contract.ts';
import { ACTIONS, type Actor, type Invocation, type PersonalAccount } from '../core/model.ts';
import type { Registry, TokenInput } from '../core/registry.ts';
import { relativeReturnPath, type Sessions } from '../core/sessions.ts';
import { cookie, readJson, requireCsrf, requireOrigin, setCookie } from './security.ts';

export interface TenantEndpoint {
  ensureOwner(account: PersonalAccount): Promise<void>;
  createSession(account: PersonalAccount): Promise<CreatedSession>;
  control(request: Request): Promise<Response>;
  admit(request: Request, name: string): Promise<Invocation | Response>;
}

export function cookieNames(secure: boolean) {
  const prefix = secure ? '__Host-' : '';
  return { control: prefix + 'pneuma-space-control', app: prefix + 'pneuma-space-app', nonce: prefix + 'pneuma-space-nonce', oauth: prefix + 'pneuma-space-oauth' };
}

export function appOrigin(config: CloudConfig, tenant: TenantName, name: string): string {
  return `${new URL(config.controlOrigin).protocol}//${appName(name)}--${tenant}.${config.appsDomain}`;
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
}

function tokenInput(raw: unknown): TokenInput {
  const value = asObject(raw, 'token');
  onlyKeys(value, ['label', 'scopes', 'appIds', 'expiresAt'], 'token');
  if (typeof value.label !== 'string' || typeof value.expiresAt !== 'number' || !Array.isArray(value.scopes)
    || !value.scopes.every(scope => ACTIONS.includes(scope))
    || (value.appIds !== null && (!Array.isArray(value.appIds) || !value.appIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id))))) {
    invalid('Invalid token request.');
  }
  return { label: value.label, scopes: value.scopes, appIds: value.appIds as AppId[] | null, expiresAt: value.expiresAt };
}

export class TenantHttp implements TenantEndpoint {
  readonly #tenant: TenantName;
  readonly #registry: Registry;
  readonly #sessions: Sessions;
  readonly #config: CloudConfig;

  constructor(tenant: TenantName, registry: Registry, sessions: Sessions, config: CloudConfig) {
    this.#tenant = tenant; this.#registry = registry; this.#sessions = sessions; this.#config = config;
  }

  async ensureOwner(account: PersonalAccount): Promise<void> { this.#registry.ensurePersonalOwner(account); }
  async createSession(account: PersonalAccount): Promise<CreatedSession> { return this.#sessions.createControl(account); }

  async #controlAuth(request: Request): Promise<{ actor: Actor; session: AuthenticatedSession | null }> {
    const authorization = request.headers.get('authorization');
    if (authorization !== null) {
      const parsed = authorization.startsWith('Bearer ') ? parseCredential(authorization.slice(7)) : null;
      if (!parsed || parsed.kind !== 'token' || parsed.tenant !== this.#tenant) throw new CloudError(401, 'unauthorized', 'A valid credential is required.');
      return { actor: { kind: 'token', tokenHash: await sha256(parsed.secret) }, session: null };
    }
    const credential = cookie(request, cookieNames(this.#config.secureCookies).control);
    const session = credential ? await this.#sessions.authenticate(credential, { kind: 'control', origin: this.#config.controlOrigin }) : null;
    if (!session) throw new CloudError(401, 'unauthorized', 'Sign in to continue.');
    requireCsrf(request, this.#config.controlOrigin, session.csrf);
    return { actor: session.actor, session };
  }

  async control(request: Request): Promise<Response> {
    const { actor, session } = await this.#controlAuth(request);
    const url = new URL(request.url);
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
    if (url.pathname === '/api/me' && request.method === 'GET') {
      if (!session) forbidden();
      return json({ user: session.account, csrf: session.csrf });
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      if (!session) forbidden();
      this.#sessions.revoke(session.actor.sessionHash);
      return new Response(null, { status: 204, headers: { 'set-cookie': setCookie(cookieNames(this.#config.secureCookies).control, '', this.#config.secureCookies, 0) } });
    }
    if (url.pathname === '/auth/app' && request.method === 'GET') {
      if (!session || url.searchParams.get('tenant') !== this.#tenant) missing();
      const name = appName(url.searchParams.get('app') ?? '');
      const app = this.#registry.get(actor, name);
      if (app.status !== 'active') missing();
      const origin = appOrigin(this.#config, this.#tenant, name);
      const grant = await this.#sessions.createGrant(actor, {
        appId: app.id, origin, nonceHash: url.searchParams.get('nonce') ?? '',
        returnPath: relativeReturnPath(url.searchParams.get('return') ?? '/'),
      });
      return redirect(origin + '/_pneuma-space/callback?code=' + encodeURIComponent(grant.code));
    }
    if (url.pathname === '/api/apps' && request.method === 'GET') return json(this.#registry.list(actor));
    if (url.pathname === '/api/tokens' && request.method === 'GET') return json(this.#registry.listTokens(actor));
    if (url.pathname === '/api/tokens' && request.method === 'POST') return json(await this.#registry.createToken(actor, tokenInput(await readJson(request, 8192))), 201);
    if (url.pathname === '/api/usage' && request.method === 'GET') return json(this.#registry.usage(actor));
    if (url.pathname === '/api/audit' && request.method === 'GET') return json(this.#registry.audit(actor));
    const revoke = /^\/api\/tokens\/([^/]+)\/revoke$/.exec(url.pathname);
    if (revoke && request.method === 'POST') { this.#registry.revokeToken(actor, revoke[1]); return json({ ok: true }); }
    const match = /^\/api\/apps\/([^/]+)(?:\/(release|remove|purge|export|import))?$/.exec(url.pathname);
    if (!match) missing();
    const name = appName(match[1]);
    const action = match[2];
    if (!action && request.method === 'GET') return json(this.#registry.get(actor, name));
    if (action === 'release' && request.method === 'PUT') {
      if (!this.#config.enabled) throw new CloudError(503, 'disabled', 'Publishing is temporarily unavailable.');
      const prepared = await prepareArtifact(await readJson(request, this.#config.limits.artifactBytes), this.#config.limits);
      return json(await this.#registry.publish(actor, name, prepared, request.headers.get('idempotency-key') ?? ''));
    }
    if (action === 'remove' && request.method === 'POST') return json(await this.#registry.remove(actor, name));
    if (action === 'purge' && request.method === 'POST') {
      const body = asObject(await readJson(request, 1024), 'confirmation');
      onlyKeys(body, ['confirm'], 'confirmation');
      if (typeof body.confirm !== 'string') invalid('Type the application name to confirm.');
      await this.#registry.purge(actor, name, body.confirm);
      return json({ ok: true });
    }
    if (action === 'export' && request.method === 'GET') {
      const exported = await this.#registry.exportApp(actor, name);
      return json(await createArchive(exported.artifact, exported.records));
    }
    if (action === 'import' && request.method === 'PUT') {
      if (!this.#config.enabled) throw new CloudError(503, 'disabled', 'Publishing is temporarily unavailable.');
      const max = this.#config.limits.artifactBytes + this.#config.limits.records.totalBytes * 2 + 256 * 1024;
      const archive = await parseArchive(await readJson(request, max), this.#config.limits);
      return json(await this.#registry.importApp(actor, name, archive.prepared, archive.records, request.headers.get('idempotency-key') ?? ''));
    }
    return new Response(null, { status: 405 });
  }

  async admit(request: Request, rawName: string): Promise<Invocation | Response> {
    const name = appName(rawName);
    const id = this.#registry.lookupId(name);
    if (!id) missing();
    const url = new URL(request.url);
    const origin = appOrigin(this.#config, this.#tenant, name);
    if (url.origin !== origin) missing();
    const names = cookieNames(this.#config.secureCookies);
    if (url.pathname === '/_pneuma-space/callback') {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      const result = await this.#sessions.consumeGrant(url.searchParams.get('code') ?? '', { appId: id, origin, nonce: cookie(request, names.nonce) ?? '' });
      return redirect(origin + result.returnPath, [
        setCookie(names.app, result.credential, this.#config.secureCookies, Math.floor((result.expiresAt - Date.now()) / 1000)),
        setCookie(names.nonce, '', this.#config.secureCookies, 0),
      ]);
    }
    if (url.pathname.startsWith('/_pneuma-space/')) missing();
    const authorization = request.headers.get('authorization');
    let actor: Actor | null = null;
    if (authorization !== null) {
      const parsed = authorization.startsWith('Bearer ') ? parseCredential(authorization.slice(7)) : null;
      if (!parsed || parsed.kind !== 'token') throw new CloudError(401, 'unauthorized', 'A valid credential is required.');
      if (parsed.tenant !== this.#tenant) missing();
      actor = { kind: 'token', tokenHash: await sha256(parsed.secret) };
    } else {
      const credential = cookie(request, names.app);
      if (credential) {
        const parsed = parseCredential(credential);
        if (parsed && parsed.tenant !== this.#tenant) missing();
        const session = await this.#sessions.authenticate(credential, { kind: 'app', origin, appId: id });
        if (session) { requireOrigin(request, origin); actor = session.actor; }
      }
    }
    if (!actor) {
      if (request.method !== 'GET' || request.headers.get('sec-fetch-mode') !== 'navigate') {
        throw new CloudError(401, 'unauthorized', 'Sign in to access this application.');
      }
      const nonce = randomSecret();
      const target = new URL('/auth/app', this.#config.controlOrigin);
      target.search = new URLSearchParams({ app: name, tenant: this.#tenant, nonce: await sha256(nonce), return: url.pathname + url.search }).toString();
      return redirect(target.href, [setCookie(names.nonce, nonce, this.#config.secureCookies, 600)]);
    }
    if (!this.#config.enabled) throw new CloudError(503, 'disabled', 'Application access is temporarily unavailable.');
    if (request.headers.has('upgrade') || request.headers.get('sec-fetch-dest') === 'serviceworker') forbidden('This request type is not supported.');
    return this.#registry.admit(actor, name);
  }
}
