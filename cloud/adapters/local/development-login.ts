import type { CloudConfig } from '../../core/config.ts';
import { CloudError } from '../../core/errors.ts';
import type { IdentityProvider } from '../../core/identity-contract.ts';
import { relativeReturnPath } from '../../core/sessions.ts';
import type { CloudBackend } from '../../http/router.ts';
import { cookieNames } from '../../http/tenant.ts';
import { readJson, requireOrigin, setCookie } from '../../http/security.ts';

export function developmentIdentity(controlOrigin: string): IdentityProvider {
  return {
    async begin(returnPath) { return { authorizationUrl: controlOrigin + '/auth/development?return=' + encodeURIComponent(returnPath), cookieValue: '', expiresAt: Date.now() + 600_000 }; },
    async complete() { throw new CloudError(404, 'not_found', 'No OAuth callback is configured for local development.'); },
  };
}

export function developmentLogin(backend: CloudBackend, config: CloudConfig) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.origin !== config.controlOrigin || url.pathname !== '/auth/development') return null;
    if (request.method === 'GET') return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local sign-in</title><style>body{font:16px system-ui;max-width:420px;margin:12vh auto;padding:24px}button{font:inherit;padding:12px 20px;margin:8px 8px 8px 0}p{line-height:1.6}</style><h1>Local sign-in</h1><p>Choose a test account. This sign-in page runs only on your machine.</p><button data-user="alice">Alice</button><button data-user="bob">Bob</button><p role="status" id="status"></p><script>document.querySelectorAll('button').forEach(button=>button.onclick=async()=>{const r=await fetch(location.href,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:button.dataset.user})});if(r.ok)location.href=(await r.json()).location;else document.querySelector('#status').textContent=(await r.json()).message;});</script></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    requireOrigin(request, config.controlOrigin);
    const raw = await readJson(request, 1024);
    if (!raw || typeof raw !== 'object' || !('user' in raw) || (raw.user !== 'alice' && raw.user !== 'bob')) throw new CloudError(400, 'invalid_input', 'Choose Alice or Bob.');
    const account = await backend.register({ provider: 'local', subject: raw.user, name: raw.user === 'alice' ? 'Alice' : 'Bob' });
    const session = await backend.tenant(account.tenant).createSession(account);
    const location = config.controlOrigin + relativeReturnPath(url.searchParams.get('return') ?? '/');
    return Response.json({ location }, { headers: { 'set-cookie': setCookie(cookieNames(false).control, session.credential, false, 7 * 24 * 3600), 'cache-control': 'no-store' } });
  };
}
