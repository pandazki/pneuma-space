import { CloudError, forbidden, invalid } from '../core/errors.ts';
import type { AppIdentity } from '../core/model.ts';

const reservedCookie = /^(?:__Host-)?pneuma-space-/i;
const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function cookie(request: Request, name: string): string | null {
  const matches = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

export function setCookie(name: string, value: string, secure: boolean, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function requireOrigin(request: Request, expected: string): void {
  if (unsafe.has(request.method) && request.headers.get('origin') !== expected) forbidden('The request origin does not match.');
}

export function requireCsrf(request: Request, expectedOrigin: string, csrf: string): void {
  requireOrigin(request, expectedOrigin);
  if (unsafe.has(request.method) && request.headers.get('x-pneuma-space-csrf') !== csrf) forbidden('Invalid CSRF token.');
}

export function appRequest(request: Request, identity: AppIdentity | null): Request {
  const headers = new Headers(request.headers);
  const nominated = (headers.get('connection') ?? '').split(',').map(value => value.trim().toLowerCase());
  for (const name of [...hopByHop, ...nominated]) if (name) headers.delete(name);
  for (const name of [...headers.keys()]) if (name.startsWith('x-pneuma-space-')) headers.delete(name);
  headers.delete('authorization');
  headers.delete('host');
  const cookies = (headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part && !reservedCookie.test(part.split('=')[0]));
  if (cookies.length) headers.set('cookie', cookies.join('; '));
  else headers.delete('cookie');
  if (identity) {
    headers.set('x-pneuma-space-subject', identity.subject);
    const encodedName = Array.from(new TextEncoder().encode(identity.name), byte => byte >= 32 && byte <= 126 && byte !== 37
      ? String.fromCharCode(byte) : '%' + byte.toString(16).toUpperCase().padStart(2, '0')).join('');
    headers.set('x-pneuma-space-name', encodedName);
    headers.set('x-pneuma-space-owner', identity.owner);
  }
  return new Request(request, { headers });
}

export function appResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  const cookies = headers.getSetCookie();
  headers.delete('set-cookie');
  for (const value of cookies) {
    const parts = value.split(';');
    const name = parts[0]?.split('=')[0].trim();
    if (!name || reservedCookie.test(name)) continue;
    headers.append('set-cookie', parts.filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part)).join(';'));
  }
  for (const header of hopByHop) headers.delete(header);
  headers.delete('service-worker-allowed');
  headers.append('content-security-policy', "worker-src 'none'; frame-ancestors 'none'");
  headers.set('x-frame-options', 'DENY');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cache-control', 'private, no-store');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) invalid('A JSON request body is required.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new CloudError(413, 'body_too_large', 'Request body exceeds the limit.');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { invalid('Invalid JSON.'); }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof CloudError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers: { 'cache-control': 'no-store' } });
  return Response.json({ error: 'internal_error', message: 'The request could not be completed.' }, { status: 500, headers: { 'cache-control': 'no-store' } });
}
