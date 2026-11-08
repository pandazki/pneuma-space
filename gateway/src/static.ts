import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import type { BundleIndex, BundleStore, ByteRange } from './model.ts';

/** The bundle file a request path names under `root`, with a directory meaning its index.html; null when the bundle has none. */
export function staticPath(index: BundleIndex, rest: string, root = ''): string | null {
  let path: string;
  try {
    path = root + decodeURIComponent(rest.slice(1));
  } catch {
    return null;
  }
  if (path === '' || path.endsWith('/')) path += 'index.html';
  return Object.hasOwn(index.files, path) ? path : null;
}

function byteRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null;
  const [, from, to] = match;
  const start = from === '' ? Math.max(0, size - Number(to)) : Number(from);
  const end = from === '' || to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return start > end || (from === '' && Number(to) === 0) ? 'unsatisfiable' : { start, end };
}

/** Path C: GET and HEAD of a bundle file, with no Lease (INV-10). A file not `shared` must stay out of CDNs and shared caches (ADR 0022 item 6). */
export async function serveStatic(
  req: IncomingMessage, res: ServerResponse, bundles: Pick<BundleStore, 'open'>, index: BundleIndex, path: string, shared: boolean,
): Promise<void> {
  const file = index.files[path];
  const etag = `"${file.etag}"`;
  const headers = { etag, 'cache-control': shared ? 'public, max-age=60' : 'private, no-cache', 'accept-ranges': 'bytes' };
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch?.split(',').some((tag) => [etag, `W/${etag}`, '*'].includes(tag.trim()))) {
    return void res.writeHead(304, headers).end();
  }
  const ifRange = req.headers['if-range'];
  const range = ifRange === undefined || ifRange === etag ? byteRange(req.headers.range, file.size) : null;
  if (range === 'unsatisfiable') return void res.writeHead(416, { ...headers, 'content-range': `bytes */${file.size}` }).end();
  const body = req.method === 'HEAD' ? null : await bundles.open(index.id, path, range);
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'content-type': file.contentType,
    'content-length': range ? range.end - range.start + 1 : file.size,
    ...(range && { 'content-range': `bytes ${range.start}-${range.end}/${file.size}` }),
  });
  if (body) pipeline(body, res, () => {});
  else res.end();
}
