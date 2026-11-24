import { fail } from './model.ts';
import { hex, sha } from './util.ts';

const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
async function hmac(key: Uint8Array | string, value: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const imported = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(value)));
}

export async function signR2(env: Env, bucket: string, key: string, method: 'GET' | 'PUT', options: { contentType?: string; contentLength?: number; expiresSeconds?: number } = {}): Promise<{ url: string; headers: Record<string, string>; expiresAt: number }> {
  if (!env.PNEUMA_SPACE_R2_ACCESS_KEY_ID || !env.PNEUMA_SPACE_R2_SECRET_ACCESS_KEY) fail(503, 'unconfigured', 'R2 signing is not configured.');
  const seconds = options.expiresSeconds ?? 300;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) fail(400, 'ticket_ttl', 'Invalid ticket lifetime.');
  if (options.contentLength !== undefined && (!Number.isSafeInteger(options.contentLength) || options.contentLength < 0)) fail(400, 'ticket_bytes', 'Invalid transfer length.');
  const now = Date.now();
  const timestamp = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const scope = date + '/auto/s3/aws4_request';
  const host = env.PNEUMA_SPACE_ACCOUNT_ID + '.r2.cloudflarestorage.com';
  const path = '/' + encode(bucket) + '/' + key.split('/').map(encode).join('/');
  const headers: Record<string, string> = {};
  if (options.contentType) headers['content-type'] = options.contentType;
  const signingHeaders = { ...headers, host, ...(options.contentLength === undefined ? {} : { 'content-length': String(options.contentLength) }) };
  const signedHeaders = Object.keys(signingHeaders).sort().join(';');
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': env.PNEUMA_SPACE_R2_ACCESS_KEY_ID + '/' + scope,
    'X-Amz-Date': timestamp, 'X-Amz-Expires': String(seconds), 'X-Amz-SignedHeaders': signedHeaders,
  });
  const canonicalQuery = Array.from(query.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => encode(k) + '=' + encode(v)).join('&');
  const canonicalHeaders = Object.entries(signingHeaders).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => name + ':' + value.trim().replace(/\s+/g, ' ') + '\n').join('');
  const canonical = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const signingKey = await hmac(await hmac(await hmac(await hmac('AWS4' + env.PNEUMA_SPACE_R2_SECRET_ACCESS_KEY, date), 'auto'), 's3'), 'aws4_request');
  const signature = await hmac(signingKey, 'AWS4-HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + await sha(canonical));
  return { url: 'https://' + host + path + '?' + canonicalQuery + '&X-Amz-Signature=' + hex(signature.buffer), headers, expiresAt: Math.floor(now / 1000) * 1000 + seconds * 1000 };
}
