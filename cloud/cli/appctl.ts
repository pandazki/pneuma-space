#!/usr/bin/env node
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareArtifact } from '../core/artifacts.ts';
import { DEFAULT_LIMITS, type Asset } from '../core/model.ts';

const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', woff2: 'font/woff2' };

export async function bundle(directory: string) {
  const root = resolve(directory);
  const manifest: unknown = JSON.parse(await readFile(join(root, 'app.json'), 'utf8'));
  const source = await readFile(join(root, 'app.mjs'), 'utf8');
  const initial = await prepareArtifact({ manifest, source, assets: [] }, DEFAULT_LIMITS);
  const assets: Asset[] = [];
  const declaration = initial.artifact.manifest.capabilities.static;
  if (declaration) {
    const staticRoot = join(root, declaration.dir);
    let total = Buffer.byteLength(source);
    const walk = async (directoryPath: string): Promise<void> => {
      const stat = await lstat(directoryPath);
      if (stat.isSymbolicLink()) throw new Error('Static assets cannot contain symbolic links.');
      if (!stat.isDirectory()) throw new Error('The static directory must be a directory.');
      for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
        const path = join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Static assets cannot contain symbolic links.');
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const body = await readFile(path);
          total += body.length;
          if (total > DEFAULT_LIMITS.artifactBytes || assets.length >= 256) throw new Error('Static assets exceed the artifact limit.');
          assets.push({ path: relative(staticRoot, path).split('\\').join('/'), contentType: TYPES[entry.name.split('.').at(-1) ?? ''] ?? 'application/octet-stream', body: body.toString('base64') });
        } else throw new Error('Static assets must be regular files.');
      }
    };
    await walk(staticRoot);
  }
  return (await prepareArtifact({ manifest, source, assets }, DEFAULT_LIMITS)).artifact;
}

export async function main(args: string[]): Promise<void> {
  const [command, name, path] = args;
  if (!command || command === '--help') {
    process.stdout.write('Usage: node cloud/cli/appctl.ts <command>\n\n  publish <name> <directory> [--key <idempotency-key>]\n  list\n  show <name>\n  remove <name>\n  export <name> <archive.json>\n  import <name> <archive.json> [--key <idempotency-key>]\n\nSet PNEUMA_SPACE_ADMIN and PNEUMA_SPACE_TOKEN. Create or revoke credentials and purge data in the console.\n');
    return;
  }
  const admin = process.env.PNEUMA_SPACE_ADMIN;
  const token = process.env.PNEUMA_SPACE_TOKEN;
  if (!admin || !token) throw new Error('Set PNEUMA_SPACE_ADMIN and PNEUMA_SPACE_TOKEN.');
  const base = new URL(admin);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && (base.hostname === 'localhost' || base.hostname.endsWith('.localhost') || base.hostname === '127.0.0.1'))) {
    throw new Error('The control origin must use HTTPS, except on localhost.');
  }
  if (base.origin !== admin) throw new Error('PNEUMA_SPACE_ADMIN must be an origin without a trailing slash.');
  const namePath = '/api/apps/' + encodeURIComponent(name ?? '');
  let endpoint: string, method = 'GET', body: unknown;
  if (command === 'list') endpoint = '/api/apps';
  else if (command === 'show' && name) endpoint = namePath;
  else if (command === 'remove' && name) { endpoint = namePath + '/remove'; method = 'POST'; body = {}; }
  else if (command === 'publish' && name && path) { endpoint = namePath + '/release'; method = 'PUT'; body = await bundle(path); }
  else if (command === 'export' && name && path) endpoint = namePath + '/export';
  else if (command === 'import' && name && path) { endpoint = namePath + '/import'; method = 'PUT'; body = JSON.parse(await readFile(path, 'utf8')); }
  else throw new Error('Invalid command. Run with --help.');
  const headers = new Headers({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });
  if (method === 'PUT') {
    const keyAt = args.indexOf('--key');
    const key = keyAt >= 0 ? args[keyAt + 1] : crypto.randomUUID();
    if (!key) throw new Error('--key requires an idempotency key.');
    headers.set('idempotency-key', key);
    process.stderr.write(`Idempotency key: ${key}\n`);
  }
  const response = await fetch(new URL(endpoint, admin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  if (command === 'export') { await writeFile(path, text + '\n', { flag: 'wx', mode: 0o600 }); process.stdout.write(`Exported ${name} to ${path}\n`); }
  else process.stdout.write(JSON.stringify(JSON.parse(text), null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; });
}
