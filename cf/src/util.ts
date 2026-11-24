import { HttpError, fail } from './model.ts';

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
  const id = crypto.randomUUID();
  console.error(JSON.stringify({ event: 'request-error', id, message: error instanceof Error ? error.message : 'Unknown error' }));
  return json({ error: { code: 'internal', message: 'The request could not be completed.', requestId: id } }, 500);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'input', 'Expected an object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) fail(400, 'input', 'Invalid ' + name + '.');
  return value;
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(400, 'input', 'Invalid ' + name + '.');
  return value;
}
export async function boundedBody(request: Request, limit = 1024 * 1024): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > limit) { await reader.cancel(); fail(413, 'body_limit', 'Request is too large.'); }
    parts.push(part.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export async function input(request: Request, limit?: number): Promise<Record<string, unknown>> {
  const bytes = await boundedBody(request, limit);
  try { return record(JSON.parse(new TextDecoder().decode(bytes))); }
  catch (error) { if (error instanceof HttpError) throw error; return fail(400, 'json', 'Invalid JSON.'); }
}
export function hex(bytes: ArrayBuffer): string { return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join(''); }
export async function sha(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
export function secret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}
export function id(prefix: string): string { return prefix + '_' + crypto.randomUUID().replaceAll('-', ''); }
export function safePath(value: unknown): string {
  const path = text(value, 'path', 300);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) fail(400, 'path', 'Invalid relative path.');
  return path;
}
export function cookie(request: Request, name: string): string | null {
  const item = (request.headers.get('cookie') ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return item ? item.slice(name.length + 1) : null;
}
export function noSecrets<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/hash|secret|credential/i.test(key)));
}
