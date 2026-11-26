import { HttpError, fail } from './model.ts';

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
export type Failure = { requestId: string; error: string };
/** `keep` stores an unexpected failure where the operator can read it: Workers Logs are sampled and need an API token. */
export async function errorResponse(error: unknown, keep?: (failure: Failure) => Promise<unknown>): Promise<Response> {
  if (error instanceof HttpError) {
    const response = json({ error: { code: error.code, message: error.message, ...(error.requestId && { requestId: error.requestId }) } }, error.status);
    if (error.retryAfter !== undefined) response.headers.set('retry-after', String(error.retryAfter));
    return response;
  }
  const failure: Failure = { requestId: crypto.randomUUID(), error: (error instanceof Error ? error.name + ': ' + error.message : 'Unknown error').slice(0, 1000) };
  console.error(JSON.stringify({ event: 'request-error', id: failure.requestId, message: failure.error }));
  // A parser's SyntaxError quotes its input, which can come from the request.
  await keep?.(error instanceof SyntaxError ? { ...failure, error: 'SyntaxError' } : failure).catch((reason: unknown) => console.error(JSON.stringify({ event: 'request-error-unkept', id: failure.requestId, message: String(reason).slice(0, 1000) })));
  return json({ error: { code: 'internal', message: 'The request could not be completed.', requestId: failure.requestId } }, 500);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'input', 'Expected an object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) fail(400, 'input', 'Invalid ' + name + '.');
  return value;
}
export const NAME = /^[a-z][a-z0-9-]{0,39}$/;
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
