import { createHash, createHmac } from 'node:crypto';
import { need } from './env.ts';

export type Credential = { readonly accessKey: string; readonly secretKey: string };
export type Objects = {
  presignPut(key: string, options?: { contentType?: string; expiresSeconds?: number }): string;
  presignGet(key: string, options?: { expiresSeconds?: number }): string;
  publicUrl(key: string): string;
};

const REGION = 'us-east-1';
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

export function presign(
  cred: Credential,
  method: string,
  url: URL,
  options: { expiresSeconds: number; headers?: Readonly<Record<string, string>>; now?: Date },
): string {
  const stamp = (options.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const headers: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value.trim();
  const names = Object.keys(headers).sort();
  const signed = new URL(url);
  signed.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  signed.searchParams.set('X-Amz-Credential', `${cred.accessKey}/${scope}`);
  signed.searchParams.set('X-Amz-Date', stamp);
  signed.searchParams.set('X-Amz-Expires', String(options.expiresSeconds));
  signed.searchParams.set('X-Amz-SignedHeaders', names.join(';'));
  const query = [...signed.searchParams]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    method,
    signed.pathname,
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + cred.secretKey, day), REGION), 's3'), 'aws4_request');
  return `${signed.origin}${signed.pathname}?${query}&X-Amz-Signature=${createHmac('sha256', key).update(toSign).digest('hex')}`;
}

let shared: Objects | undefined;

export function objects(): Objects {
  if (shared) return shared;
  const { publicEndpoint, bucket, accessKey, secretKey } = need('object');
  const cred = { accessKey, secretKey };
  const url = (key: string) => new URL(`${publicEndpoint.replace(/\/+$/, '')}/${bucket}/${key.split('/').map(rfc3986).join('/')}`);
  shared = {
    presignPut: (key, { contentType, expiresSeconds = 900 } = {}) =>
      presign(cred, 'PUT', url(key), { expiresSeconds, headers: contentType ? { 'content-type': contentType } : {} }),
    presignGet: (key, { expiresSeconds = 900 } = {}) => presign(cred, 'GET', url(key), { expiresSeconds }),
    publicUrl(key) {
      if (!key.startsWith('public/')) throw new Error(`"${key}" is not under public/; use presignGet`);
      return url(key).toString();
    },
  };
  return shared;
}
