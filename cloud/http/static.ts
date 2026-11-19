import { decodeAsset } from '../core/artifacts.ts';
import { sha256 } from '../core/crypto.ts';
import { CloudError } from '../core/errors.ts';
import type { Artifact } from '../core/model.ts';

export async function serveStatic(request: Request, artifact: Artifact, maxBytes: number): Promise<Response | null> {
  if (!artifact.manifest.capabilities.static || !['GET', 'HEAD'].includes(request.method)) return null;
  let path: string;
  try { path = decodeURIComponent(new URL(request.url).pathname).slice(1) || 'index.html'; }
  catch { return new Response('Invalid path.', { status: 400 }); }
  const asset = artifact.assets.find(candidate => candidate.path === path);
  if (!asset) return null;
  const bytes = decodeAsset(asset.body);
  const etag = '"' + await sha256(asset.body) + '"';
  const headers = new Headers({ 'content-type': asset.contentType, etag, 'accept-ranges': 'bytes' });
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  let start = 0;
  let end = bytes.length - 1;
  let status = 200;
  const range = request.headers.get('range');
  if (range && (!request.headers.has('if-range') || request.headers.get('if-range') === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
    if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
    else start = Math.max(0, bytes.length - Number(match[2]));
    if (start > end || start >= bytes.length || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
    }
    status = 206;
    headers.set('content-range', `bytes ${start}-${end}/${bytes.length}`);
  }
  const body = bytes.slice(start, end + 1);
  if (request.method !== 'HEAD' && body.length > maxBytes) throw new CloudError(413, 'body_too_large', 'Static response exceeds the byte limit.');
  headers.set('content-length', String(body.length));
  return new Response(request.method === 'HEAD' ? null : body, { status, headers });
}
