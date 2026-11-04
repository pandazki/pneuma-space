import { randomBytes, createHash } from 'node:crypto';
import * as s3 from './s3.ts';

const store: s3.Store = {
  endpoint: 'http://127.0.0.1:9100',
  root: { accessKey: 'pneumaroot', secretKey: 'pneumaroot-secret' },
};
const id = randomBytes(4).toString('hex');
const bucket = `app-${id}`;
const accessKey = `app-${id}`;
const browserOrigin = 'http://127.0.0.1:8080';
const anon = (key: string, headers: Record<string, string> = {}) => fetch(`${store.endpoint}/${bucket}/${key}`, { headers });

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`FAIL: ${what}`);
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${store.endpoint}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('RustFS not ready');
}

async function step(n: number, name: string, body: () => Promise<void>): Promise<void> {
  await body();
  console.log(`PASS ${n} ${name}`);
}

await waitReady();
let app!: s3.Credential;

await step(1, 'root credential creates bucket (idempotent)', async () => {
  await s3.createBucket(store, bucket);
  await s3.createBucket(store, bucket);
  check((await s3.signedFetch(store.root, 'HEAD', new URL(`${store.endpoint}/${bucket}`))).status === 200, 'bucket exists');
});

await step(2, 'per-app credential limited to its bucket', async () => {
  app = s3.newCredential(accessKey);
  await s3.ensureAppCredential(store, bucket, app);
  await s3.createBucket(store, 'pneuma-bundles');
  const own = await s3.signedFetch(app, 'PUT', new URL(`${store.endpoint}/${bucket}/private/a.txt`), 'secret');
  check(own.status === 200, `app PUT own bucket: ${own.status}`);
  check((await (await s3.getObject(store, app, bucket, 'private/a.txt')).text()) === 'secret', 'app GET own bucket');
  const other = await s3.signedFetch(app, 'PUT', new URL(`${store.endpoint}/pneuma-bundles/x`), 'x');
  check(other.status === 403, `app PUT other bucket denied: ${other.status}`);
  const list = await s3.signedFetch(app, 'GET', new URL(`${store.endpoint}/pneuma-bundles?list-type=2`));
  check(list.status === 403, `app LIST other bucket denied: ${list.status}`);
  const mk = await s3.signedFetch(app, 'PUT', new URL(`${store.endpoint}/app-${id}-extra`));
  check(mk.status === 403, `app CreateBucket denied: ${mk.status}`);
});

await step(3, 'anonymous GET allowed on public/*, denied elsewhere', async () => {
  await s3.setPublicRead(store, bucket);
  await s3.signedFetch(store.root, 'PUT', new URL(`${store.endpoint}/${bucket}/public/hello.txt`), 'hello');
  const pub = await anon('public/hello.txt');
  check(pub.status === 200 && (await pub.text()) === 'hello', `anon public GET: ${pub.status}`);
  check((await anon('private/a.txt')).status === 403, 'anon private GET denied');
  const listing = await fetch(`${store.endpoint}/${bucket}?list-type=2`);
  check(listing.status === 403, `anon LIST denied: ${listing.status}`);
});

await step(4, `CORS lets ${browserOrigin} PUT`, async () => {
  await s3.setCors(store, bucket, [browserOrigin]);
  const preflight = (origin: string) =>
    fetch(`${store.endpoint}/${bucket}/public/upload.bin`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    });
  const yes = await preflight(browserOrigin);
  check(yes.headers.get('access-control-allow-origin') === browserOrigin, `preflight allow-origin: ${yes.status} ${yes.headers.get('access-control-allow-origin')}`);
  check(/PUT/.test(yes.headers.get('access-control-allow-methods') ?? ''), `preflight allow-methods: ${yes.headers.get('access-control-allow-methods')}`);
  const no = await preflight('http://evil.example');
  check(no.headers.get('access-control-allow-origin') !== 'http://evil.example', 'other origin not allowed');
});

const data = randomBytes(50 * 1024 * 1024);
await step(5, 'presigned PUT 50 MB, public Range GET 206, private GET 403', async () => {
  const url = s3.presignPut(store, app, bucket, 'public/upload.bin');
  const put = await fetch(url, { method: 'PUT', body: data, headers: { origin: browserOrigin, 'content-type': 'application/octet-stream' } });
  check(put.status === 200, `presigned PUT: ${put.status} ${await put.clone().text()}`);
  check(put.headers.get('access-control-allow-origin') === browserOrigin, `PUT response allow-origin: ${put.headers.get('access-control-allow-origin')}`);
  const head = await s3.signedFetch(store.root, 'HEAD', new URL(`${store.endpoint}/${bucket}/public/upload.bin`));
  check(head.headers.get('content-length') === String(data.length), `stored size: ${head.headers.get('content-length')}`);
  const ranged = await anon('public/upload.bin', { range: 'bytes=1000-1999' });
  const bytes = Buffer.from(await ranged.arrayBuffer());
  check(ranged.status === 206, `range status: ${ranged.status}`);
  check(bytes.equals(data.subarray(1000, 2000)), 'range bytes match');
  check(ranged.headers.get('content-range') === `bytes 1000-1999/${data.length}`, `content-range: ${ranged.headers.get('content-range')}`);
  const full = await anon('public/upload.bin');
  const digest = createHash('sha256').update(Buffer.from(await full.arrayBuffer())).digest('hex');
  check(digest === createHash('sha256').update(data).digest('hex'), 'full body matches');
  const privUrl = s3.presignPut(store, app, bucket, 'private/upload.bin');
  check((await fetch(privUrl, { method: 'PUT', body: 'p' })).status === 200, 'presigned PUT private');
  check((await anon('private/upload.bin')).status === 403, 'anon private GET denied');
  const expired = s3.presign(app, 'GET', new URL(`${store.endpoint}/${bucket}/private/upload.bin`), 1);
  await new Promise((r) => setTimeout(r, 2100));
  check((await fetch(expired)).status === 403, 'expired presigned URL denied');
});

await step(6, 'suspend, ensure, destroy (each idempotent)', async () => {
  const appGet = () => s3.getObject(store, app, bucket, 'private/a.txt');
  const disabled = async (res: Response) => res.status === 400 && (await res.text()).includes('ErrAccessKeyDisabled');
  await s3.suspend(store, bucket, accessKey);
  await s3.suspend(store, bucket, accessKey);
  check(await disabled(await appGet()), 'suspended credential denied');
  check((await anon('public/hello.txt')).status === 403, 'suspended public GET denied');
  check(await disabled(await fetch(s3.presignPut(store, app, bucket, 'public/z'), { method: 'PUT', body: 'z' })), 'suspended presigned PUT denied');

  await s3.ensure(store, bucket, app, [browserOrigin]);
  await s3.ensure(store, bucket, app, [browserOrigin]);
  check((await appGet()).status === 200, 'ensured credential works');
  check((await anon('public/hello.txt')).status === 200, 'ensured public GET works');

  await s3.destroy(store, bucket, accessKey);
  await s3.destroy(store, bucket, accessKey);
  check((await s3.signedFetch(store.root, 'HEAD', new URL(`${store.endpoint}/${bucket}`))).status === 404, 'bucket gone');
  const users = await s3.signedFetch(store.root, 'GET', new URL(`${store.endpoint}/minio/admin/v3/list-users`));
  check(users.ok, `list-users: ${users.status}`);
  check(!(await users.text()).includes(accessKey), 'credential gone');
  check((await anon('public/hello.txt')).status === 403, 'anon GET after destroy denied');
  check((await s3.getObject(store, store.root, bucket, 'public/hello.txt')).status === 404, 'object gone');
});

await step(7, 'platform credential Range GET on pneuma-bundles/<sha>/<path>', async () => {
  const bundle = Buffer.from('<!doctype html><title>bundle</title>'.repeat(100));
  const sha = createHash('sha256').update(bundle).digest('hex');
  const key = `${sha}/assets/index.html`;
  const put = await s3.signedFetch(store.root, 'PUT', new URL(`${store.endpoint}/pneuma-bundles/${key}`), bundle, { 'content-type': 'text/html' });
  check(put.status === 200, `bundle PUT: ${put.status}`);
  const res = await s3.getObject(store, store.root, 'pneuma-bundles', key, 'bytes=10-99');
  check(res.status === 206, `bundle range status: ${res.status}`);
  check(Buffer.from(await res.arrayBuffer()).equals(bundle.subarray(10, 100)), 'bundle range bytes match');
  check(res.headers.get('content-type') === 'text/html', `content-type kept: ${res.headers.get('content-type')}`);
  const missing = await s3.getObject(store, store.root, 'pneuma-bundles', `${sha}/nope.js`);
  check(missing.status === 404, `missing bundle path 404: ${missing.status}`);
});
