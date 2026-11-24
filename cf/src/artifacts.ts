import { CAPABILITIES, type Actor, type AppPackage, type AppRow, type AppSnapshot, type Artifact, type Manifest, type PackageFile, fail } from './model.ts';
import { authorizeApp } from './auth.ts';
import { cellValue, audit } from './directory.ts';
import { nextSchedule } from './cron.ts';
import { signR2 } from './s3.ts';
import { boundedBody, id, integer, record, safePath, sha, text } from './util.ts';

const PACKAGE_LIMIT = 4 * 1024 * 1024;
export function parseManifest(value: unknown): Manifest {
  const input = record(value);
  if (Object.keys(input).some(k => !['contract', 'runtime', 'entry', 'capabilities'].includes(k))) fail(400, 'manifest', 'Unknown manifest field.');
  if (input.contract !== 'pneuma-space.cf/1' || !['node', 'static'].includes(String(input.runtime))) fail(400, 'manifest', 'Unsupported application contract or runtime.');
  const runtime = input.runtime === 'node' ? 'node' : 'static';
  const entry = safePath(input.entry ?? (runtime === 'node' ? 'app.mjs' : 'public/index.html'));
  const raw = record(input.capabilities ?? {});
  const capabilities: Manifest['capabilities'] = {};
  for (const [name, declaration] of Object.entries(raw)) {
    if (!Object.hasOwn(CAPABILITIES, name)) fail(400, 'capability', 'Unknown capability: ' + name);
    const config = record(declaration);
    if (name === 'static') {
      if (Object.keys(config).some(k => k !== 'dir')) fail(400, 'static', 'Unknown static option.');
      capabilities.static = { dir: safePath(config.dir ?? 'public') };
    } else if (name === 'cron') {
      if (Object.keys(config).some(k => k !== 'triggers')) fail(400, 'cron', 'Unknown trigger option.');
      const triggers: Record<string, { schedule?: string }> = {};
      const entries = Object.entries(record(config.triggers));
      if (entries.length > 16) fail(400, 'cron', 'At most 16 triggers are allowed.');
      for (const [trigger, options] of entries) {
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(trigger)) fail(400, 'cron', 'Invalid trigger name.');
        const item = record(options);
        if (Object.keys(item).some(k => k !== 'schedule')) fail(400, 'cron', 'Unknown trigger option.');
        if (item.schedule === undefined) triggers[trigger] = {};
        else {
          const schedule = text(item.schedule, 'schedule', 100);
          nextSchedule(schedule, Date.now());
          triggers[trigger] = { schedule };
        }
      }
      capabilities.cron = { triggers };
    } else if (name === 'identity') {
      if (Object.keys(config).some(k => k !== 'required') || (config.required !== undefined && typeof config.required !== 'boolean')) fail(400, 'identity', 'Invalid identity declaration.');
      capabilities.identity = config.required === undefined ? {} : { required: config.required };
    } else {
      if (Object.keys(config).length) fail(400, 'capability', 'Capability declaration must be empty.');
      Object.assign(capabilities, { [name]: {} });
    }
  }
  if (runtime === 'static' && (Object.keys(capabilities).some(k => k !== 'static') || !capabilities.static)) fail(400, 'runtime', 'Static sites declare only static assets.');
  const manifest: Manifest = { contract: 'pneuma-space.cf/1', runtime, entry, capabilities };
  if (JSON.stringify(manifest).length > 4096) fail(400, 'manifest', 'Manifest is too large.');
  return manifest;
}
export function parsePackage(value: unknown): AppPackage {
  const input = record(value), manifest = parseManifest(input.manifest);
  if (Object.keys(input).some(k => !['manifest', 'files'].includes(k)) || !Array.isArray(input.files) || !input.files.length || input.files.length > 256) fail(400, 'package', 'Package must contain 1–256 files.');
  const seen = new Set<string>(), files: PackageFile[] = [];
  let size = 0;
  for (const value of input.files) {
    const file = record(value), path = safePath(file.path);
    if (seen.has(path)) fail(400, 'package', 'Duplicate package path.');
    seen.add(path);
    if (typeof file.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.body)) fail(400, 'package', 'File body must be base64.');
    size += file.body.length;
    if (size > PACKAGE_LIMIT) fail(413, 'package', 'Package is too large.');
    files.push({ path, body: file.body, contentType: text(file.contentType ?? 'application/octet-stream', 'content type', 150) });
  }
  if (manifest.runtime === 'node' && !seen.has(manifest.entry)) fail(400, 'entry', 'Application entry file is missing.');
  if (manifest.capabilities.static && !files.some(file => file.path.startsWith(manifest.capabilities.static!.dir + '/'))) fail(400, 'static', 'No static files were found.');
  return { manifest, files };
}
export async function readPackage(env: Env, artifact: Artifact): Promise<AppPackage> {
  const object = await env.PNEUMA_SPACE_ARTIFACTS.get(artifact.key);
  if (!object || object.size > PACKAGE_LIMIT || object.size !== artifact.bytes) fail(409, 'artifact', 'Application package is missing or has changed.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha(bytes) !== artifact.digest) fail(409, 'digest', 'Application package checksum does not match.');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return fail(400, 'package', 'Package is not valid JSON.'); }
  const parsed = parsePackage(value);
  if (JSON.stringify(parsed.manifest) !== JSON.stringify(artifact.manifest)) fail(409, 'manifest', 'Package manifest does not match its release.');
  return parsed;
}
export async function beginUpload(env: Env, actor: Actor, app: AppRow, body: Record<string, unknown>): Promise<unknown> {
  const manifest = parseManifest(body.manifest), digest = text(body.digest, 'digest', 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) fail(400, 'digest', 'Use a SHA-256 digest.');
  const bytes = integer(body.bytes, 'package size', 1, PACKAGE_LIMIT);
  if (manifest.capabilities.rtc && (!env.PNEUMA_SPACE_TURN_KEY_ID || !env.PNEUMA_SPACE_TURN_API_TOKEN)) fail(409, 'rtc_unconfigured', 'TURN has not been configured.');
  const snapshot = await cellValue<AppSnapshot>(env, app.id, '/inspect');
  if (snapshot.status === 'purging' || snapshot.status === 'purged') fail(409, 'purging', 'Application is being purged.');
  const uploadId = id('up'), key = 'apps/' + app.id + '/uploads/' + uploadId + '.json';
  const ticket = await signR2(env, env.PNEUMA_SPACE_ARTIFACT_BUCKET, key, 'PUT', { contentType: 'application/json', contentLength: bytes, expiresSeconds: 180 });
  const now = Date.now();
  const result = await env.PNEUMA_SPACE_DB.prepare('INSERT INTO uploads(id,app_id,actor_hash,digest,bytes,manifest_json,generation,object_key,created_at,expires_at,ticket_expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM uploads WHERE app_id=? AND expires_at>?)<20 AND (SELECT count(*) FROM uploads WHERE app_id=?)<200 AND (SELECT coalesce(sum(bytes),0) FROM uploads WHERE app_id=?)+?<=(SELECT storage_bytes FROM apps WHERE id=? AND purged_at IS NULL)').bind(uploadId, app.id, actor.hash, digest, bytes, JSON.stringify(manifest), snapshot.generation, key, now, now + 600000, ticket.expiresAt, app.id, now, app.id, app.id, bytes, app.id).run();
  if (!result.meta.changes) {
    const live = await env.PNEUMA_SPACE_DB.prepare('SELECT count(*) AS count FROM uploads WHERE app_id=? AND expires_at>?').bind(app.id, now).first<{ count: number }>();
    if ((live?.count ?? 0) >= 20) fail(429, 'upload_limit', 'Too many pending uploads. Wait for older tickets to expire.');
    fail(409, 'artifact_quota', 'The application has reached its retained package storage or upload limit.');
  }
  const current = await cellValue<AppSnapshot>(env, app.id, '/inspect');
  if (current.generation !== snapshot.generation || current.status === 'purging' || current.status === 'purged') fail(409, 'app_changed', 'Application changed while preparing this upload.');
  return { uploadId, ...ticket };
}
export async function artifactPurgeDeadline(env: Env, appId: string): Promise<number | null> {
  const row = await env.PNEUMA_SPACE_DB.prepare('SELECT max(ticket_expires_at) AS expires FROM uploads WHERE app_id=?').bind(appId).first<{ expires: number | null }>();
  return row?.expires ? row.expires + 2000 : null;
}
export async function artifactUsage(env: Env, appId: string) {
  const row = await env.PNEUMA_SPACE_DB.prepare('SELECT a.storage_bytes,(SELECT coalesce(sum(bytes),0) FROM uploads WHERE app_id=a.id) AS bytes,(SELECT count(*) FROM uploads WHERE app_id=a.id) AS uploads FROM apps a WHERE a.id=?').bind(appId).first<{ storage_bytes: number; bytes: number; uploads: number }>();
  if (!row) fail(404, 'app_not_found', 'Application not found.');
  return { reservedBytes: row.bytes * 3, limitBytes: row.storage_bytes * 3, uploads: row.uploads, maxUploads: 200 };
}
export async function publishUpload(env: Env, actor: Actor, app: AppRow, uploadInput: unknown, operation: string): Promise<unknown> {
  const result = await cellValue<AppSnapshot>(env, app.id, '/publish-upload', { actor, uploadId: text(uploadInput, 'upload', 80), idempotencyKey: operation });
  await audit(env, actor, 'app.publish', app.tenant_id, app.id, 'ok', 'release ' + result.current?.number);
  return result;
}
export async function prepareUploadArtifact(env: Env, actor: Actor, appId: string, uploadInput: unknown, generation: number): Promise<Artifact> {
  const uploadId = text(uploadInput, 'upload', 80);
  const upload = await env.PNEUMA_SPACE_DB.prepare('SELECT * FROM uploads WHERE id=? AND app_id=? AND actor_hash=?').bind(uploadId, appId, actor.hash).first<{ digest: string; bytes: number; manifest_json: string; object_key: string; generation: number; expires_at: number }>();
  if (!upload) fail(404, 'upload', 'Upload not found.');
  if (upload.generation !== generation) fail(409, 'retired', 'Application changed after this upload began.');
  const manifest = parseManifest(JSON.parse(upload.manifest_json));
  const key = 'apps/' + appId + '/artifacts/' + upload.digest + '/package.json';
  let object = await env.PNEUMA_SPACE_ARTIFACTS.get(key);
  if (!object) {
    if (upload.expires_at < Date.now()) fail(409, 'upload_expired', 'Upload has expired.');
    object = await env.PNEUMA_SPACE_ARTIFACTS.get(upload.object_key);
    if (!object || object.size !== upload.bytes || object.size > PACKAGE_LIMIT) fail(409, 'upload_missing', 'Package upload is missing or has an unexpected size.');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await sha(bytes) !== upload.digest) fail(409, 'digest', 'Package checksum does not match.');
    const pkg = parsePackage(JSON.parse(new TextDecoder().decode(bytes)));
    if (JSON.stringify(pkg.manifest) !== JSON.stringify(manifest)) fail(409, 'manifest', 'Uploaded manifest does not match.');
    await authorizeApp(env, actor, appId, 'publish');
    await env.PNEUMA_SPACE_ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagDoesNotMatch: '*' } });
  }
  const artifact: Artifact = { digest: upload.digest, bytes: upload.bytes, key, manifest };
  const pkg = await readPackage(env, artifact);
  const dir = manifest.capabilities.static?.dir;
  if (dir) for (const file of pkg.files.filter(file => file.path.startsWith(dir + '/'))) {
    const bytes = Uint8Array.from(atob(file.body), c => c.charCodeAt(0));
    await env.PNEUMA_SPACE_ARTIFACTS.put('apps/' + appId + '/artifacts/' + artifact.digest + '/static/' + file.path.slice(dir.length + 1), bytes, { httpMetadata: { contentType: file.contentType }, onlyIf: { etagDoesNotMatch: '*' } });
  }
  return artifact;
}
export async function staticResponse(env: Env, appId: string, artifact: Artifact, request: Request, pathname: string): Promise<Response | null> {
  let path: string;
  try { path = decodeURIComponent(pathname).slice(1); } catch { return null; }
  path = path.endsWith('/') || path === '' ? path + 'index.html' : path;
  if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const key = 'apps/' + appId + '/artifacts/' + artifact.digest + '/static/' + path;
  const metadata = await env.PNEUMA_SPACE_ARTIFACTS.head(key);
  if (!metadata) return null;
  const headers = new Headers({ 'cache-control': 'private, no-cache', 'etag': metadata.httpEtag, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' });
  metadata.writeHttpMetadata(headers);
  if (request.headers.get('if-none-match') === metadata.httpEtag) return new Response(null, { status: 304, headers });
  let offset = 0, length = metadata.size, status = 200;
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + metadata.size } });
    offset = match[1] ? Number(match[1]) : Math.max(0, metadata.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(metadata.size - 1, Number(match[2])) : metadata.size - 1;
    if (offset >= metadata.size || end < offset) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + metadata.size } });
    length = end - offset + 1; status = 206;
    headers.set('content-range', 'bytes ' + offset + '-' + end + '/' + metadata.size);
  }
  headers.set('content-length', String(length));
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const object = await env.PNEUMA_SPACE_ARTIFACTS.get(key, { range: { offset, length } });
  return object ? new Response(object.body, { status, headers }) : null;
}
