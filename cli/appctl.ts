#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ADMIN_PATHS, ADMIN_PORT, APPS_PATH, CAPABILITIES, InputError, ManifestError, appName, declaredKinds, parseManifest, subject,
  type Manifest,
} from '../gateway/src/model.ts';

const EXIT = { usage: 1, manifest: 2, api: 3, build: 4 } as const;

class Failure extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const USAGE = `usage:
  appctl publish <name> <dir|image> [--owner <subject>] [--tag <tag>] [--manifest <file>]
  appctl init <dir> [--static]
  appctl list
  appctl show <name>
  appctl logs <name> [--tail <lines>]
  appctl remove <name>
  appctl purge <name> [--yes]
  appctl policy [<name>] key=value ...
  appctl owner <name> <subject>
  appctl token create <name>
admin API: PNEUMA_SPACE_ADMIN (default http://127.0.0.1:${ADMIN_PORT})`;

const usage = (why: string) => new Failure(EXIT.usage, `${why}\n${USAGE}`);
const admin = (process.env.PNEUMA_SPACE_ADMIN ?? `http://127.0.0.1:${ADMIN_PORT}`).replace(/\/$/, '');

type Options = { owner?: string; tag?: string; manifest?: string; static?: boolean; yes?: boolean; tail?: string };

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const tar = body instanceof ReadableStream;
  const init = body === undefined ? { method } : {
    method,
    headers: { 'content-type': tar ? 'application/x-tar' : 'application/json' },
    body: tar ? body : JSON.stringify(body),
    duplex: 'half',
  };
  const response = await fetch(admin + path, init).catch((error: Error) => {
    throw new Failure(EXIT.api, `admin API at ${admin} unreachable: ${error.cause ?? error.message}`);
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text };
  }
  if (!response.ok) throw new Failure(EXIT.api, `${method} ${path}: ${response.status} ${parsed?.error ?? text}`);
  return response.headers.get('content-type')?.startsWith('text/plain') ? text : parsed;
}

function readManifest(file: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ManifestError(`${file}: ${(error as Error).message}`);
  }
  return parseManifest(raw);
}

function needsImage(manifest: Manifest): boolean {
  return declaredKinds(manifest).some((kind) => CAPABILITIES[kind].needsImage);
}

function build(name: string, dir: string, tag: string | undefined): string {
  const ref = `pneuma-space-app/${name}:${tag ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  try {
    return execFileSync('docker', ['build', '-q', '-t', ref, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  } catch (error) {
    throw new Failure(EXIT.build, `docker build ${dir} failed: ${(error as Error).message}`);
  }
}

// ustar, regular files only. Sorted paths, mode 0644, uid/gid 0 and mtime 0 so the same tree always gives the same bytes and bundle id.

const BLOCK = 512;

function bundleFiles(root: string): { path: string; size: number }[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new ManifestError(`static.dir ${root} is not a directory`);
  return (readdirSync(root, { recursive: true }) as string[])
    .map((path) => path.split('\\').join('/'))
    .filter((path) => statSync(join(root, path)).isFile())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, size: statSync(join(root, path)).size }));
}

function splitPath(path: string): [prefix: string, name: string] {
  if (Buffer.byteLength(path) <= 100) return ['', path];
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return [prefix, name];
  }
  throw new ManifestError(`static file path too long for a bundle: ${path}`);
}

function header(path: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const [prefix, name] = splitPath(path);
  const field = (offset: number, length: number, value: string) => block.write(value, offset, length, 'utf8');
  const octal = (offset: number, length: number, value: number) => field(offset, length, value.toString(8).padStart(length - 1, '0'));
  field(0, 100, name);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  field(148, 8, ' '.repeat(8));
  field(156, 1, '0');
  field(257, 6, 'ustar\0');
  field(263, 2, '00');
  field(345, 155, prefix);
  const sum = block.reduce((total, byte) => total + byte, 0);
  field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

async function* tar(root: string, files: { path: string; size: number }[]): AsyncGenerator<Uint8Array> {
  for (const { path, size } of files) {
    yield header(path, size);
    yield* createReadStream(join(root, path));
    if (size % BLOCK) yield Buffer.alloc(BLOCK - (size % BLOCK));
  }
  yield Buffer.alloc(BLOCK * 2);
}

async function publish([rawName, target, ...extra]: string[], options: Options): Promise<void> {
  if (!rawName || !target || extra.length) throw usage('publish takes <name> <dir|image>');
  const name = appName(rawName);
  const owner = options.owner ?? (process.env.PNEUMA_SPACE_OWNER || undefined);
  if (owner !== undefined) subject(owner);
  const fromDir = existsSync(target) && statSync(target).isDirectory();
  const manifestFile = fromDir ? join(target, 'pneuma-space.json') : resolve(options.manifest ?? 'pneuma-space.json');
  const manifest = readManifest(manifestFile);
  const root = dirname(manifestFile);
  const staticRoot = manifest.capabilities.static ? join(root, manifest.capabilities.static.dir) : null;
  const files = staticRoot ? bundleFiles(staticRoot) : null;

  const image = !fromDir ? target : needsImage(manifest) ? build(name, target, options.tag) : null;
  let bundle: string | null = null;
  if (staticRoot && files) bundle = (await api('POST', ADMIN_PATHS.bundles, ReadableStream.from(tar(staticRoot, files)))).bundle;
  const release = await api('PUT', ADMIN_PATHS.release(name), { image, manifest, bundle, ...(owner && { owner }) });
  console.log(`${name}  ${APPS_PATH}/${name}/  release ${release.number}`);
}

function init([dir, ...extra]: string[], options: Options): void {
  if (!dir || extra.length) throw usage('init takes <dir>');
  const template = fileURLToPath(new URL(`../templates/${options.static ? 'static' : 'app'}/`, import.meta.url));
  if (!existsSync(template)) throw new Failure(EXIT.usage, `template ${template} not found`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Failure(EXIT.usage, `${dir} is not empty`);
  cpSync(template, dir, { recursive: true });
  console.log(`created ${dir} from ${template}`);
}

function one(args: string[], what: string): string {
  if (args.length !== 1) throw usage(`${what} takes <name>`);
  return appName(args[0]);
}

async function list(args: string[]): Promise<void> {
  if (args.length) throw usage('list takes no arguments');
  for (const app of await api('GET', ADMIN_PATHS.apps)) {
    console.log([app.name, app.address, `release ${app.release ?? '-'}`, app.status, app.instance].join('\t'));
  }
}

async function purge(args: string[], options: Options): Promise<void> {
  const name = one(args, 'purge');
  if (!options.yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await prompt.question(`purge deletes every volume, database, key and object of ${name}. Type its name to confirm: `);
    prompt.close();
    if (answer.trim() !== name) throw new Failure(EXIT.usage, 'purge not confirmed');
  }
  await api('POST', ADMIN_PATHS.purge(name));
  console.log(`purged ${name}`);
}

function policyValue(raw: string): string | number | null {
  if (raw === 'null') return null;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

async function policy(args: string[]): Promise<void> {
  const name = args[0] && !args[0].includes('=') ? appName(args[0]) : null;
  const pairs = name ? args.slice(1) : args;
  if (!pairs.length || pairs.some((pair) => !/^[a-z_]+=./.test(pair))) throw usage('policy takes key=value pairs');
  const fields = Object.fromEntries(pairs.map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), policyValue(pair.slice(at + 1))];
  }));
  const result = await api('PUT', name ? ADMIN_PATHS.appPolicy(name) : ADMIN_PATHS.policy, fields);
  console.log(JSON.stringify(result, null, 2));
}

async function owner(args: string[]): Promise<void> {
  if (args.length !== 2) throw usage('owner takes <name> <subject>');
  const name = appName(args[0]);
  await api('PUT', ADMIN_PATHS.owner(name), { owner: subject(args[1]) });
  console.log(`${name} owner ${args[1]}`);
}

async function token([verb, ...rest]: string[]): Promise<void> {
  if (verb !== 'create') throw usage('token takes create <name>');
  const name = one(rest, 'token create');
  const issued = await api('POST', ADMIN_PATHS.tokens, { name });
  console.error(`subject ${issued.subject}; the secret below is shown once and never again`);
  console.log(issued.token);
}

const COMMANDS: Record<string, (args: string[], options: Options) => unknown> = {
  publish,
  init,
  list,
  show: async (args) => console.log(JSON.stringify(await api('GET', ADMIN_PATHS.app(one(args, 'show'))), null, 2)),
  logs: async (args, options) => {
    const query = options.tail === undefined ? '' : `?tail=${encodeURIComponent(options.tail)}`;
    process.stdout.write(await api('GET', ADMIN_PATHS.logs(one(args, 'logs')) + query));
  },
  remove: async (args) => {
    const name = one(args, 'remove');
    await api('POST', ADMIN_PATHS.remove(name));
    console.log(`removed ${name}; data kept, purge deletes it`);
  },
  purge,
  policy,
  owner,
  token,
};

async function main(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        owner: { type: 'string' },
        tag: { type: 'string' },
        manifest: { type: 'string' },
        static: { type: 'boolean' },
        yes: { type: 'boolean' },
        tail: { type: 'string' },
      },
    });
  } catch (error) {
    throw usage((error as Error).message);
  }
  const [command, ...args] = parsed.positionals;
  const run = command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!run) throw usage(command ? `unknown command "${command}"` : 'no command');
  await run(args, parsed.values);
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(`appctl: ${error.message}`);
  process.exitCode =
    error instanceof Failure ? error.code
    : error instanceof ManifestError ? EXIT.manifest
    : error instanceof InputError ? EXIT.usage
    : 1;
  if (!(error instanceof Failure || error instanceof InputError)) console.error(error.stack);
});
