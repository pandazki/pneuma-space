import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { connect } from './client.mjs';
import { parsePackage } from '../src/artifacts.ts';

const [command, ...args] = process.argv.slice(2);
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
} else if (['apps', 'publish', 'action', 'data', 'inspect'].includes(command)) {
  const client = await connect();
  try {
    const tenant = process.env.PNEUMA_SPACE_TENANT ?? client.me.tenants[0]?.id;
    if (!tenant) throw new Error('No tenant selected.');
    if (command === 'apps') console.log(JSON.stringify(await client.api('/tenants/' + tenant + '/apps'), null, 2));
    if (command === 'inspect') console.log(JSON.stringify(await client.api('/apps/' + args[0]), null, 2));
    if (command === 'action') {
      const [appId, type, confirmation] = args;
      if (type === 'purge' && !confirmation) throw new Error('Purge requires the exact application name as the third argument.');
      console.log(JSON.stringify(await client.api('/apps/' + appId + '/actions', { type, ...(confirmation ? { confirmation } : {}) }), null, 2));
    }
    if (command === 'data') console.log(JSON.stringify(await client.api('/apps/' + args[0] + '/data', JSON.parse(await readFile(args[1], 'utf8'))), null, 2));
    if (command === 'publish') {
      const [directory, name] = args;
      if (!directory || !name) throw new Error('Usage: cli.mjs publish DIRECTORY APP_NAME');
      const packed = await packageDirectory(directory);
      const existing = (await client.api('/tenants/' + tenant + '/apps')).items.find(app => app.name === name);
      const app = existing ?? await client.api('/tenants/' + tenant + '/apps', { name });
      const ticket = await client.api('/apps/' + app.id + '/uploads', { manifest: packed.pkg.manifest, digest: packed.digest, bytes: packed.bytes.length });
      const upload = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: packed.bytes, redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!upload.ok) throw new Error('Direct package upload failed: ' + upload.status + ' ' + (/<Code>([^<]+)/.exec(await upload.text())?.[1] ?? 'R2 error'));
      const result = await client.api('/apps/' + app.id + '/releases', { uploadId: ticket.uploadId });
      console.log(JSON.stringify({ id: app.id, url: app.url, release: result.current.number }));
    }
  } finally { await client.close(); }
} else {
  console.log('Commands: package DIRECTORY OUTPUT.json; apps; publish DIRECTORY APP_NAME; inspect APP_ID; action APP_ID TYPE [EXACT_NAME]; data APP_ID COMMAND.json');
  process.exitCode = 2;
}
