import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { connect } from './client.mjs';
import { parsePackage } from '../src/artifacts.ts';
import { MANAGER_HEADER, managerChange } from '../src/manager.ts';

const { positionals: [command, ...args], values: options } = parseArgs({ allowPositionals: true, options: { ephemeral: { type: 'boolean' }, ttl: { type: 'string' }, manager: { type: 'string' }, 'manager-url': { type: 'string' }, app: { type: 'string' } } });
if (options.ttl !== undefined && (!options.ephemeral || !/^[1-9]\d*$/.test(options.ttl))) throw new Error('--ttl takes whole seconds and needs --ephemeral.');
if (options['manager-url'] !== undefined && !options.manager) throw new Error('--manager-url needs --manager.');
// --manager names the manager on every request and, on publish, also sets it (ADR 0039).
const manager = options.manager === undefined ? null : managerChange({ name: options.manager, ...(options['manager-url'] !== undefined && { url: options['manager-url'] }) });
const ephemeral = options.ephemeral ? { ephemeral: true } : {};
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
async function packageDirectory(directory) {
  const root = resolve(directory), manifest = JSON.parse(await readFile(join(root, 'pneuma-space.json'), 'utf8')), files = [];
  async function walk(directory, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'pneuma-space.json') continue;
      const path = prefix + item.name, source = join(directory, item.name), stat = await lstat(source);
      if (stat.isSymbolicLink()) throw new Error('Packages cannot contain symlinks: ' + path);
      if (stat.isDirectory()) await walk(source, path + '/');
      else if (stat.isFile()) files.push({ path, body: (await readFile(source)).toString('base64'), contentType: mime[extname(path)] ?? 'application/octet-stream' });
    }
  }
  await walk(root);
  const pkg = parsePackage({ manifest, files });
  const bytes = Buffer.from(JSON.stringify(pkg));
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Package exceeds 4 MiB.');
  return { pkg, bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}
if (command === 'package') {
  if (args.length !== 2) throw new Error('Usage: cli.mjs package DIRECTORY OUTPUT.json');
  const { bytes, digest } = await packageDirectory(args[0]); await writeFile(args[1], bytes);
  console.log(JSON.stringify({ path: resolve(args[1]), bytes: bytes.length, digest }));
} else if (['apps', 'publish', 'action', 'data', 'inspect', 'discard', 'unmanage'].includes(command)) {
  const client = await connect(undefined, manager ? { [MANAGER_HEADER]: manager.name } : {});
  try {
    const tenant = process.env.PNEUMA_SPACE_TENANT ?? client.me.tenants[0]?.id;
    if (!tenant) throw new Error('No tenant selected.');
    const named = async name => (await client.api('/tenants/' + tenant + '/apps')).items.find(app => app.name === name) ?? (() => { throw new Error('No application is named ' + name + '.'); })();
    if (command === 'apps') console.log(JSON.stringify(await client.api('/tenants/' + tenant + '/apps'), null, 2));
    if (command === 'inspect') console.log(JSON.stringify(await client.api('/apps/' + args[0]), null, 2));
    if (command === 'action') {
      const [appId, type, confirmation] = args;
      if (type === 'purge' && !confirmation) throw new Error('Purge requires the exact application name as the third argument.');
      console.log(JSON.stringify(await client.api('/apps/' + appId + '/actions', { type, ...(confirmation ? { confirmation } : {}) }), null, 2));
    }
    if (command === 'discard') {
      // An id names one app for good; a retry after the end gets 404 and never meets a later app of the same name.
      const id = options.app ?? (await named(args[0])).id;
      const result = await client.api('/apps/' + id + '/actions', { type: 'discard' });
      console.log(JSON.stringify({ id, ...(result.pending ? { status: 'purging', retryAt: new Date(result.retryAt).toISOString() } : { status: result.status }) }));
    }
    if (command === 'unmanage') {
      const { id } = await named(args[0]);
      console.log(JSON.stringify({ id, ...await client.api('/apps/' + id + '/manager', undefined, 'DELETE') }));
    }
    if (command === 'data') console.log(JSON.stringify(await client.api('/apps/' + args[0] + '/data', JSON.parse(await readFile(args[1], 'utf8'))), null, 2));
    if (command === 'publish') {
      const [directory, name] = args;
      if (!directory || !name) throw new Error('Usage: cli.mjs publish DIRECTORY APP_NAME');
      const packed = await packageDirectory(directory);
      const existing = (await client.api('/tenants/' + tenant + '/apps')).items.find(app => app.name === name);
      const app = existing ?? await client.api('/tenants/' + tenant + '/apps', { name, ...(options.ephemeral && { ephemeral: options.ttl ? { ttlSeconds: Number(options.ttl) } : {} }), ...(manager && { manager }) });
      const ticket = await client.api('/apps/' + app.id + '/uploads', { manifest: packed.pkg.manifest, digest: packed.digest, bytes: packed.bytes.length, ...ephemeral });
      const upload = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: packed.bytes, redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!upload.ok) throw new Error('Direct package upload failed: ' + upload.status + ' ' + (/<Code>([^<]+)/.exec(await upload.text())?.[1] ?? 'R2 error'));
      const result = await client.api('/apps/' + app.id + '/releases', { uploadId: ticket.uploadId, ...ephemeral, ...(manager && { manager }) });
      console.log(JSON.stringify({ id: app.id, url: app.url, release: result.current.number, expiresAt: result.expiresAt === null ? null : new Date(result.expiresAt).toISOString() }));
    }
  } finally { await client.close(); }
} else {
  console.log('Commands: package DIRECTORY OUTPUT.json; apps; publish DIRECTORY APP_NAME [--ephemeral [--ttl SECONDS]] [--manager NAME [--manager-url URL]]; inspect APP_ID; action APP_ID TYPE [EXACT_NAME]; discard APP_NAME [--app APP_ID]; unmanage APP_NAME; data APP_ID COMMAND.json. --manager NAME names the manager of a managed app on any write.');
  process.exitCode = 2;
}
