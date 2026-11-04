import { argon2Sync, createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

export type Credential = { accessKey: string; secretKey: string };
export type Store = { endpoint: string; root: Credential };

const REGION = 'us-east-1';
const UNSIGNED = 'UNSIGNED-PAYLOAD';

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function amzDate(now: Date): { stamp: string; day: string } {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { stamp, day: stamp.slice(0, 8) };
}

function signature(cred: Credential, day: string, stringToSign: string): string {
  const key = ['s3', 'aws4_request'].reduce(
    (k, part) => hmac(k, part),
    hmac(hmac('AWS4' + cred.secretKey, day), REGION),
  );
  return createHmac('sha256', key).update(stringToSign).digest('hex');
}

function canonicalRequest(method: string, url: URL, headers: Record<string, string>, payloadHash: string) {
  const names = Object.keys(headers).sort();
  return {
    signedHeaders: names.join(';'),
    text: [
      method,
      url.pathname.split('/').map((seg) => rfc3986(decodeURIComponent(seg))).join('/'),
      canonicalQuery(url.searchParams),
      names.map((n) => `${n}:${headers[n].trim()}\n`).join(''),
      names.join(';'),
      payloadHash,
    ].join('\n'),
  };
}

export async function signedFetch(
  cred: Credential,
  method: string,
  url: URL,
  body: Uint8Array | string = '',
  extra: Record<string, string> = {},
): Promise<Response> {
  const { stamp, day } = amzDate(new Date());
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': stamp,
    'x-amz-content-sha256': payloadHash,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const req = canonicalRequest(method, url, headers, payloadHash);
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const sig = signature(cred, day, ['AWS4-HMAC-SHA256', stamp, scope, sha256(req.text)].join('\n'));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cred.accessKey}/${scope}, SignedHeaders=${req.signedHeaders}, Signature=${sig}`;
  delete headers.host;
  return fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
}

export function presign(cred: Credential, method: string, url: URL, expiresSeconds: number): string {
  const { stamp, day } = amzDate(new Date());
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const signed = new URL(url);
  signed.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  signed.searchParams.set('X-Amz-Credential', `${cred.accessKey}/${scope}`);
  signed.searchParams.set('X-Amz-Date', stamp);
  signed.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  signed.searchParams.set('X-Amz-SignedHeaders', 'host');
  const req = canonicalRequest(method, signed, { host: signed.host }, UNSIGNED);
  const sig = signature(cred, day, ['AWS4-HMAC-SHA256', stamp, scope, sha256(req.text)].join('\n'));
  signed.searchParams.set('X-Amz-Signature', sig);
  return signed.toString();
}

async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  return res;
}

const objectUrl = (store: Store, bucket: string, key = '', query = '') =>
  new URL(`${store.endpoint}/${bucket}${key ? '/' + key.split('/').map(rfc3986).join('/') : ''}${query}`);

const admin = (store: Store, op: string, params: Record<string, string>) =>
  new URL(`${store.endpoint}/minio/admin/v3/${op}?${new URLSearchParams(params)}`);

// MinIO madmin EncryptData, which add-user requires: salt(32) | 0x00 (argon2id + AES-256-GCM) | nonce(8) | sio-go stream.
// The body fits one sio fragment (< 16 KiB): seq 1, final flag 0x80, AD tag sealed under seq 0.
function sealAdminPayload(secretKey: string, plaintext: string): Buffer {
  if (Buffer.byteLength(plaintext) >= 16384) throw new Error('admin payload exceeds one sio fragment');
  const salt = randomBytes(32);
  const nonce = randomBytes(8);
  const key = argon2Sync('argon2id', { message: secretKey, nonce: salt, parallelism: 4, tagLength: 32, memory: 65536, passes: 1 });
  const seal = (seq: number, data: Buffer, aad: Buffer) => {
    const iv = Buffer.alloc(12);
    nonce.copy(iv);
    iv.writeUInt32LE(seq, 8);
    const c = createCipheriv('aes-256-gcm', key, iv).setAAD(aad);
    const out = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([out, c.getAuthTag()]);
  };
  const adTag = seal(0, Buffer.alloc(0), Buffer.alloc(0));
  const fragment = seal(1, Buffer.from(plaintext), Buffer.concat([Buffer.from([0x80]), adTag]));
  return Buffer.concat([salt, Buffer.from([0x00]), nonce, fragment]);
}

const policyName = (bucket: string) => `pneuma-${bucket}`;

export async function createBucket(store: Store, bucket: string): Promise<void> {
  const res = await signedFetch(store.root, 'PUT', objectUrl(store, bucket));
  if (res.ok) return;
  const text = await res.text();
  if (res.status === 409 && text.includes('BucketAlreadyOwnedByYou')) return;
  throw new Error(`create bucket ${bucket}: ${res.status} ${text}`);
}

export const newCredential = (accessKey: string): Credential => ({ accessKey, secretKey: randomBytes(24).toString('base64url') });

// add-user overwrites the secret and sets status enabled, so re-running it with the stored
// credential is both create and the resume half of ensure.
export async function ensureAppCredential(store: Store, bucket: string, cred: Credential): Promise<void> {
  const policy = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['s3:*'], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`] }],
  };
  await ok(
    await signedFetch(store.root, 'PUT', admin(store, 'add-canned-policy', { name: policyName(bucket) }), JSON.stringify(policy)),
    'add-canned-policy',
  );
  await ok(
    await signedFetch(store.root, 'PUT', admin(store, 'add-user', { accessKey: cred.accessKey }),
      sealAdminPayload(store.root.secretKey, JSON.stringify({ secretKey: cred.secretKey, status: 'enabled' }))),
    'add-user',
  );
  await ok(
    await signedFetch(store.root, 'PUT',
      admin(store, 'set-user-or-group-policy', { policyName: policyName(bucket), userOrGroup: cred.accessKey, isGroup: 'false' })),
    'set-user-or-group-policy',
  );
}

export async function disableCredential(store: Store, accessKey: string): Promise<void> {
  await ok(await signedFetch(store.root, 'PUT', admin(store, 'set-user-status', { accessKey, status: 'disabled' })), 'set-user-status');
}

export async function setPublicRead(store: Store, bucket: string): Promise<void> {
  const policy = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/public/*`] }],
  };
  await ok(await signedFetch(store.root, 'PUT', objectUrl(store, bucket, '', '?policy'), JSON.stringify(policy)), 'put bucket policy');
}

export async function revokePublicRead(store: Store, bucket: string): Promise<void> {
  const res = await signedFetch(store.root, 'DELETE', objectUrl(store, bucket, '', '?policy'));
  if (!res.ok && res.status !== 404) throw new Error(`delete bucket policy: ${res.status} ${await res.text()}`);
}

export async function setCors(store: Store, bucket: string, origins: string[]): Promise<void> {
  const xml =
    '<CORSConfiguration><CORSRule>' +
    origins.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join('') +
    ['GET', 'PUT', 'HEAD'].map((m) => `<AllowedMethod>${m}</AllowedMethod>`).join('') +
    '<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>' +
    '</CORSRule></CORSConfiguration>';
  const md5 = createHash('md5').update(xml).digest('base64');
  await ok(await signedFetch(store.root, 'PUT', objectUrl(store, bucket, '', '?cors'), xml, { 'content-md5': md5 }), 'put bucket cors');
}

export function presignPut(store: Store, cred: Credential, bucket: string, key: string, expiresSeconds = 900): string {
  return presign(cred, 'PUT', objectUrl(store, bucket, key), expiresSeconds);
}

export async function getObject(store: Store, cred: Credential, bucket: string, key: string, range?: string): Promise<Response> {
  return signedFetch(cred, 'GET', objectUrl(store, bucket, key), '', range ? { range } : {});
}

const xmlText = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function deleteAllObjects(store: Store, bucket: string): Promise<void> {
  for (;;) {
    const list = await ok(await signedFetch(store.root, 'GET', objectUrl(store, bucket, '', '?list-type=2&max-keys=1000')), 'list objects');
    const keys = [...(await list.text()).matchAll(/<Key>(.*?)<\/Key>/gs)].map((m) => xmlText(m[1]));
    if (keys.length === 0) return;
    const xml = `<Delete><Quiet>true</Quiet>${keys.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('')}</Delete>`;
    const md5 = createHash('md5').update(xml).digest('base64');
    await ok(await signedFetch(store.root, 'POST', objectUrl(store, bucket, '', '?delete'), xml, { 'content-md5': md5 }), 'delete objects');
  }
}

export async function destroy(store: Store, bucket: string, accessKey: string): Promise<void> {
  const head = await signedFetch(store.root, 'HEAD', objectUrl(store, bucket));
  if (head.ok) {
    await deleteAllObjects(store, bucket);
    await ok(await signedFetch(store.root, 'DELETE', objectUrl(store, bucket)), 'delete bucket');
  }
  const user = await signedFetch(store.root, 'GET', admin(store, 'user-info', { accessKey }));
  if (user.ok) {
    await ok(await signedFetch(store.root, 'DELETE', admin(store, 'remove-user', { accessKey })), 'remove-user');
  } else if (user.status !== 404) {
    throw new Error(`user-info: ${user.status} ${await user.text()}`);
  }
  await ok(await signedFetch(store.root, 'DELETE', admin(store, 'remove-canned-policy', { name: policyName(bucket) })), 'remove-canned-policy');
}

export async function ensure(store: Store, bucket: string, cred: Credential, corsOrigins: string[]): Promise<void> {
  await createBucket(store, bucket);
  await ensureAppCredential(store, bucket, cred);
  await setPublicRead(store, bucket);
  await setCors(store, bucket, corsOrigins);
}

export async function suspend(store: Store, bucket: string, accessKey: string): Promise<void> {
  await revokePublicRead(store, bucket);
  await disableCredential(store, accessKey);
}
