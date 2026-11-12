import { InputError, appName, tenantName, type TenantName } from '../../shared/values.ts';
import type { CloudConfig } from '../core/config.ts';
import { CloudError } from '../core/errors.ts';
import { parseCredential, type IdentityProvider, type VerifiedIdentity } from '../core/identity-contract.ts';
import type { ArtifactStore, PersonalAccount } from '../core/model.ts';
import { runWithDeadline, type FetchRuntime } from '../core/runtime.ts';
import { relativeReturnPath } from '../core/sessions.ts';
import { appRequest, appResponse, cookie, errorResponse, setCookie } from './security.ts';
import { serveStatic } from './static.ts';
import { cookieNames, redirect, type TenantEndpoint } from './tenant.ts';

export interface CloudBackend {
  tenant(name: TenantName): TenantEndpoint;
  register(identity: VerifiedIdentity): Promise<PersonalAccount>;
  artifacts: ArtifactStore;
  runtime: FetchRuntime;
}

export function createRouter(options: { config: CloudConfig; backend: CloudBackend; identity: IdentityProvider; consoleHtml: string }) {
  const { config, backend, identity, consoleHtml } = options;
  const names = cookieNames(config.secureCookies);
  return async function route(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin === config.controlOrigin) {
        if (request.method === 'GET' && url.pathname === '/') return new Response(consoleHtml, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' },
        });
        if (request.method === 'GET' && url.pathname === '/api/profile') return Response.json({
          contract: 2, abi: 'pneuma-space.fetch/1', controlOrigin: config.controlOrigin, appsDomain: config.appsDomain,
          limits: config.limits, enabled: config.enabled,
        }, { headers: { 'cache-control': 'no-store' } });
        if (request.method === 'GET' && url.pathname === '/auth/login') {
          const result = await identity.begin(relativeReturnPath(url.searchParams.get('return') ?? '/'));
          return redirect(result.authorizationUrl, [setCookie(names.oauth, result.cookieValue, config.secureCookies, 600)]);
        }
        if (request.method === 'GET' && url.pathname === '/auth/callback') {
          const result = await identity.complete({ code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') ?? '', cookieValue: cookie(request, names.oauth) ?? '' });
          const account = await backend.register(result.identity);
          const session = await backend.tenant(account.tenant).createSession(account);
          return redirect(config.controlOrigin + result.returnPath, [
            setCookie(names.control, session.credential, config.secureCookies, Math.floor((session.expiresAt - Date.now()) / 1000)),
            setCookie(names.oauth, '', config.secureCookies, 0),
          ]);
        }
        const authorization = request.headers.get('authorization');
        const credential = authorization === null ? cookie(request, names.control)
          : authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
        const parsed = credential ? parseCredential(credential) : null;
        if (!parsed || !['control', 'token'].includes(parsed.kind)) {
          if (url.pathname === '/auth/app' && authorization === null) return redirect(config.controlOrigin + '/auth/login?return=' + encodeURIComponent(url.pathname + url.search));
          throw new CloudError(401, 'unauthorized', 'Sign in or provide a valid deployment credential.');
        }
        try { return await backend.tenant(parsed.tenant).control(request); }
        catch (error) {
          if (url.pathname === '/auth/app' && error instanceof CloudError && error.status === 401) return redirect(config.controlOrigin + '/auth/login?return=' + encodeURIComponent(url.pathname + url.search));
          throw error;
        }
      }
      const suffix = '.' + config.appsDomain;
      if (!url.host.endsWith(suffix)) return new Response('Not found.', { status: 404 });
      const label = url.host.slice(0, -suffix.length);
      const split = label.lastIndexOf('--');
      if (split < 1 || label.length > 63 || label.includes('.')) return new Response('Not found.', { status: 404 });
      const name = appName(label.slice(0, split));
      const tenant = tenantName(label.slice(split + 2));
      if (!/^t[a-f0-9]{16}$/.test(tenant)) return new Response('Not found.', { status: 404 });
      const admission = await backend.tenant(tenant).admit(request, name);
      if (admission instanceof Response) return admission;
      if (admission.release.manifest.capabilities.static) {
        if (admission.expiresAt <= Date.now()) throw new CloudError(504, 'invocation_timeout', 'Invocation deadline exceeded.');
        const staticResponse = await runWithDeadline((async () => {
          const artifact = await backend.artifacts.get(admission.appId, admission.release.digest);
          return serveStatic(request, artifact, config.limits.responseBytes);
        })(), admission.expiresAt - Date.now());
        if (admission.expiresAt <= Date.now()) throw new CloudError(504, 'invocation_timeout', 'Invocation deadline exceeded.');
        if (staticResponse) return appResponse(staticResponse);
      }
      const invocation = backend.runtime.acquire(admission);
      const response = await invocation.fetch(appRequest(request, admission.release.manifest.capabilities.identity ? admission.identity : null));
      return appResponse(response);
    } catch (error) {
      return errorResponse(error instanceof InputError ? new CloudError(400, 'invalid_input', error.message) : error);
    }
  };
}
