import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import type { BundleId, BundleIndex, ByteRange } from './model.ts';
import { serveStatic, staticPath } from './static.ts';

const BYTES = Buffer.from('0123456789');
const INDEX: BundleIndex = {
  id: 'a'.repeat(64) as BundleId,
  files: { 'index.html': { size: BYTES.length, etag: 'sha-1', contentType: 'text/html' } },
};

let opened: (ByteRange | null)[] = [];
const server = http.createServer((req, res) => {
  const path = staticPath(INDEX, req.url!);
  if (path === null) return void res.writeHead(404).end();
  void serveStatic(req, res, {
    async open(_id, _path, range) {
      opened.push(range);
      return Readable.from([range ? BYTES.subarray(range.start, range.end + 1) : BYTES]);
    },
  }, INDEX, path);
});
let port = 0;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

function get(headers: http.OutgoingHttpHeaders, path = '/'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  opened = [];
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('a directory path serves its index.html with the content sha as ETag', async () => {
  const got = await get({});
  assert.equal(got.status, 200);
  assert.equal(got.body, '0123456789');
  assert.equal(got.headers.etag, '"sha-1"');
  assert.equal(got.headers['cache-control'], 'public, max-age=60');
});

test('a matching If-None-Match answers 304 without opening the bundle', async () => {
  const got = await get({ 'if-none-match': '"sha-1"' });
  assert.equal(got.status, 304);
  assert.deepEqual(opened, []);
});

test('Range answers 206 with the inclusive slice', async () => {
  const got = await get({ range: 'bytes=2-5' });
  assert.equal(got.status, 206);
  assert.equal(got.headers['content-range'], 'bytes 2-5/10');
  assert.equal(got.body, '2345');
  assert.deepEqual(opened, [{ start: 2, end: 5 }]);
});

test('an unsatisfiable Range answers 416 without opening the bundle', async () => {
  const got = await get({ range: 'bytes=10-' });
  assert.equal(got.status, 416);
  assert.equal(got.headers['content-range'], 'bytes */10');
  assert.deepEqual(opened, []);
});
