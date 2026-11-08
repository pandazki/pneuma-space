#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ADMIN_PATHS, ADMIN_PORT, CAPABILITIES, InputError, ManifestError, appName, declaredKinds, parseManifest, subject,
  type Manifest, type RuntimeKind,
} from '../gateway/src/model.ts';
import { assemble } from './scaffold.ts';

const EXIT = { usage: 1, manifest: 2, api: 3, build: 4 } as const;

class Failure extends Error {
  readonly code: number;
  /** The admin API's answer, when there was one. */
  readonly status: number | null;
  constructor(code: number, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const USAGE = `usage:
  appctl publish <name> <dir|image> [--owner <subject>] [--tenant <t>] [--tag <tag>] [--manifest <file>]
  appctl init <dir> [--container|--static]
  appctl list
  appctl show <name>
  appctl logs <name> [--tail <lines>]
  appctl unquarantine <name>
  appctl remove <name>
  appctl purge <name> [--yes|-y]
  appctl policy [<name>] key=value ...
  appctl owner <name> <subject>
  appctl access <name> tenant|org|public
  appctl whoami
  appctl tenant list | create <tenant> <admin-id>... [--display <name>]
  appctl member add <tenant> <user-id> [admin|member] | role <tenant> <user-id> admin|member | remove <tenant> <user-id>
  appctl token create <name>                                     (local)
  appctl token create [<name>] --tenant <t> --kind service|personal [--label <label>]
  appctl token revoke <id> --tenant <t>
  appctl quota <tenant> [key=value ...]
  appctl audit [--tenant <t>] [--since 7d|24h|2026-11-01] [--action <action>] [--actor <subject>] [--json]
admin API: PNEUMA_SPACE_ADMIN (default http://127.0.0.1:${ADMIN_PORT}), PNEUMA_SPACE_TOKEN sent as Authorization: Bearer`;

const usage = (why: string) => new Failure(EXIT.usage, `${why}\n${USAGE}`);
const admin = (process.env.PNEUMA_SPACE_ADMIN ?? `http://127.0.0.1:${ADMIN_PORT}`).replace(/\/$/, '');
const bearer: Record<string, string> = process.env.PNEUMA_SPACE_TOKEN ? { authorization: `Bearer ${process.env.PNEUMA_SPACE_TOKEN}` } : {};

type Options = {
  owner?: string; tag?: string; manifest?: string; container?: boolean; static?: boolean; yes?: boolean; tail?: string;
  tenant?: string; since?: string; action?: string; actor?: string; json?: boolean; kind?: string; label?: string; display?: string;
};

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const tar = body instanceof ReadableStream;
  const init = body === undefined ? { method, headers: bearer } : {
    method,
    headers: { ...bearer, 'content-type': tar ? 'application/x-tar' : 'application/json' },
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
  const quota = parsed?.quota ? `\nquota ${JSON.stringify(parsed.quota)}` : '';
  if (!response.ok) throw new Failure(EXIT.api, `${method} ${path}: ${response.status} ${parsed?.error ?? text}${quota}`, response.status);
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

function needsRuntime(manifest: Manifest): boolean {
  return declaredKinds(manifest).some((kind) => CAPABILITIES[kind].needsRuntime);
}

// Without a declared runtime, a Dockerfile keeps a directory scaffolded before ADR 0017 on the container runtime and its volumes.
function runtimeOf(manifest: Manifest, dir: string): RuntimeKind | null {
  if (manifest.runtime) return manifest.runtime;
  if (!needsRuntime(manifest)) return null;
  return existsSync(join(dir, 'Dockerfile')) ? 'container' : 'isolate';
}

// `.audit` is the decision-trail folder developer tooling leaves in a project.
const NOT_SHIPPED = new Set(['.git', 'node_modules', '.audit', '.npmrc']);
const notShipped = (name: string) => NOT_SHIPPED.has(name) || name.startsWith('.env') || /\.test\.[cm]?[jt]sx?$/.test(name);
const shipped = (rel: string) => !rel.split(sep).some(notShipped) && rel.split(sep)[0] !== 'data';

/** Where `path` really is, or null with a warning when it is a dangling link or leads outside `base`. */
function inside(base: string, path: string, shown: string): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    console.error(`appctl: skipping ${shown}: dangling link`);
    return null;
  }
  const rel = relative(base, real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    console.error(`appctl: skipping ${shown}: links outside ${base}`);
    return null;
  }
  return real;
}

/** Fills `out` with `dir` as the runner loads it: links followed, no local state, secrets or tests, production dependencies installed without their scripts. */
function codeBundle(dir: string, out: string): void {
  try {
    const base = realpathSync(dir);
    cpSync(dir, out, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        const rel = relative(dir, src);
        if (rel === '') return true;
        const real = shipped(rel) && inside(base, src, rel);
        if (!real) return false;
        const target = relative(base, real);
        if (shipped(target)) return true;
        console.error(`appctl: skipping ${rel}: links to ${target}`);
        return false;
      },
    });
    const pkg = join(out, 'package.json');
    if (existsSync(pkg) && Object.keys(JSON.parse(readFileSync(pkg, 'utf8')).dependencies ?? {}).length) {
      try {
        execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: out, stdio: ['ignore', 2, 'inherit'] });
      } catch {
        throw new Error('npm ci --omit=dev --ignore-scripts failed; package-lock.json must match package.json');
      }
    }
  } catch (error) {
    throw new Failure(EXIT.build, `bundling ${dir} failed: ${(error as Error).message.split('\n')[0]}`);
  }
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

type Entry = { path: string; size: number; name: [prefix: string, name: string] };

function bundleFiles(root: string): Entry[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new ManifestError(`static.dir ${root} is not a directory`);
  const base = realpathSync(root);
  const files: Entry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      const path = dir ? `${dir}/${name}` : name;
      const real = inside(base, join(root, path), path);
      const stat = real && statSync(real);
      if (stat && stat.isDirectory()) walk(path);
      else if (stat && stat.isFile()) files.push({ path, size: stat.size, name: splitPath(path) });
    }
  };
  walk('');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function splitPath(path: string): Entry['name'] {
  if (Buffer.byteLength(path) <= 100) return ['', path];
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return [prefix, name];
  }
  throw new Failure(EXIT.build, `file path too long for a bundle: ${path}`);
}

function header([prefix, name]: Entry['name'], size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
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

async function* tar(root: string, files: Entry[]): AsyncGenerator<Uint8Array> {
  for (const { path, size, name } of files) {
    yield header(name, size);
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
  const runtime = fromDir ? runtimeOf(manifest, target) : 'container';
  const staticRoot = manifest.capabilities.static ? join(root, manifest.capabilities.static.dir) : null;
  const files = staticRoot && runtime !== 'isolate' ? bundleFiles(staticRoot) : null;
  const image = runtime !== 'container' ? null : fromDir ? build(name, target, options.tag) : target;

  const code = runtime === 'isolate' ? mkdtempSync(join(tmpdir(), 'appctl-bundle-')) : null;
  try {
    if (code) codeBundle(target, code);
    const [bundleRoot, bundled] = code ? [code, bundleFiles(code)] : [staticRoot, files];
    const bundle = bundleRoot && bundled ? (await api('POST', ADMIN_PATHS.bundles, ReadableStream.from(tar(bundleRoot, bundled)))).bundle : null;
    const release = await api('PUT', ADMIN_PATHS.release(name), { image, manifest, bundle, ...(owner && { owner }), ...(options.tenant && { tenant: options.tenant }) });
    const listed = (await api('GET', ADMIN_PATHS.apps) as { name: string; address: string }[]).find((app) => app.name === name);
    console.log(`${name}  ${listed?.address ?? '-'}  release ${release.number}`);
  } finally {
    if (code) rmSync(code, { recursive: true, force: true });
  }
}

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));

function init([dir, ...extra]: string[], options: Options): void {
  if (!dir || extra.length) throw usage('init takes <dir>');
  if (options.container && options.static) throw usage('init takes --container or --static, not both');
  const scaffold = join(TEMPLATES, options.static ? 'static' : 'app');
  const overlay = options.container ? join(TEMPLATES, 'container') : null;
  for (const template of [scaffold, overlay]) if (template && !existsSync(template)) throw new Failure(EXIT.usage, `template ${template} not found`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Failure(EXIT.usage, `${dir} is not empty`);
  assemble(dir, scaffold, overlay);
  if (options.container) {
    const manifest = join(dir, 'pneuma-space.json');
    writeFileSync(manifest, `${JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), runtime: 'container' }, null, 2)}\n`);
  }
  console.log(`created ${dir} from ${[scaffold, overlay].filter(Boolean).join(' + ')}`);
}

async function show(args: string[]): Promise<void> {
  const name = one(args, 'show');
  const detail = await api('GET', ADMIN_PATHS.app(name));
  const runtime = detail.releases.find((r: { number: number }) => r.number === detail.app.current)?.runtime ?? 'none';
  const q = detail.quarantine;
  console.error(`runtime ${runtime}${q ? `; quarantined since ${new Date(q.since).toISOString()} after ${q.failures} failures (${q.reason}); appctl unquarantine ${name} lifts it` : ''}`);
  console.log(JSON.stringify(detail, null, 2));
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

function fields(pairs: string[], what: string): Record<string, string | number | null> {
  if (!pairs.length || pairs.some((pair) => !/^[a-z_]+=./.test(pair))) throw usage(`${what} takes key=value pairs`);
  return Object.fromEntries(pairs.map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), policyValue(pair.slice(at + 1))];
  }));
}

async function policy(args: string[]): Promise<void> {
  const name = args[0] && !args[0].includes('=') ? appName(args[0]) : null;
  const result = await api('PUT', name ? ADMIN_PATHS.appPolicy(name) : ADMIN_PATHS.policy, fields(name ? args.slice(1) : args, 'policy'));
  console.log(JSON.stringify(result, null, 2));
}

async function owner(args: string[]): Promise<void> {
  if (args.length !== 2) throw usage('owner takes <name> <subject>');
  const name = appName(args[0]);
  await api('PUT', ADMIN_PATHS.owner(name), { owner: subject(args[1]) });
  console.log(`${name} owner ${args[1]}`);
}

async function token([verb, ...rest]: string[], options: Options): Promise<void> {
  if (verb === 'revoke') {
    if (rest.length !== 1 || !options.tenant) throw usage('token revoke takes <id> --tenant <t>');
    await api('DELETE', ADMIN_PATHS.tenantToken(options.tenant, rest[0]));
    return void console.log(`revoked ${rest[0]}`);
  }
  if (verb !== 'create') throw usage('token takes create or revoke');
  let issued;
  if (!options.tenant) {
    issued = await api('POST', ADMIN_PATHS.tokens, { name: one(rest, 'token create') });
  } else {
    if (rest.length > 1 || (options.kind === 'service') !== (rest.length === 1)) throw usage('token create takes <name> for --kind service and none for --kind personal');
    const body = { kind: options.kind, ...(rest[0] && { name: rest[0] }), ...(options.label && { label: options.label }) };
    issued = await api('POST', ADMIN_PATHS.tenantTokens(options.tenant), body).catch((error: Error) => {
      if (error instanceof Failure && error.status === 403 && process.env.PNEUMA_SPACE_TOKEN) throw new Failure(EXIT.api, 'a token cannot issue a token; sign a personal token in the console', 403);
      throw error;
    });
  }
  console.error(`subject ${issued.subject}, id ${issued.id}; the secret below is shown once and never again`);
  console.log(issued.token);
}

async function whoami(args: string[]): Promise<void> {
  if (args.length) throw usage('whoami takes no arguments');
  const me = await api('GET', ADMIN_PATHS.me);
  if (me.local) return void console.log('local\tplatform admin, unauthenticated');
  const roles = Object.entries(me.roles as Record<string, string>).map(([tenant, role]) => `${tenant}:${role}`);
  console.log([me.subject, me.name, ...roles, ...(me.platformAdmin ? ['platform admin'] : [])].join('\t'));
}

async function tenant([verb, ...rest]: string[], options: Options): Promise<void> {
  if (verb === 'list' && !rest.length) {
    for (const t of await api('GET', ADMIN_PATHS.tenants)) console.log([t.name, t.display].join('\t'));
    return;
  }
  if (verb !== 'create' || rest.length < 2) throw usage('tenant takes list, or create <tenant> <admin-id>...');
  const [name, ...admins] = rest;
  await api('POST', ADMIN_PATHS.tenants, { name, admins, ...(options.display && { display: options.display }) });
  console.log(`created ${name} with admins ${admins.join(', ')}`);
}

async function member([verb, tenant, user, role, ...extra]: string[]): Promise<void> {
  if (!tenant || !user || extra.length) throw usage('member takes add|role|remove <tenant> <user-id>');
  if (verb === 'remove' && role === undefined) {
    await api('DELETE', ADMIN_PATHS.member(tenant, user));
    return void console.log(`removed ${user} from ${tenant}`);
  }
  if (!(verb === 'add' || (verb === 'role' && role !== undefined))) throw usage('member takes add <tenant> <user-id> [role], role <tenant> <user-id> <role>, or remove <tenant> <user-id>');
  await api('PUT', ADMIN_PATHS.member(tenant, user), { role: role ?? 'member' });
  console.log(`${user} is ${role ?? 'member'} of ${tenant}`);
}

async function quota([tenant, ...pairs]: string[]): Promise<void> {
  if (!tenant) throw usage('quota takes <tenant> [key=value ...]');
  const result = pairs.length
    ? await api('PUT', ADMIN_PATHS.quota(tenant), fields(pairs, 'quota'))
    : await api('GET', ADMIN_PATHS.quota(tenant));
  console.log(JSON.stringify(result, null, 2));
}

const SPAN_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function since(raw: string): number {
  const [, count, unit] = /^(\d+)([mhd])$/.exec(raw) ?? [];
  if (count) return Date.now() - Number(count) * SPAN_MS[unit as keyof typeof SPAN_MS];
  const at = /^\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isNaN(at)) throw usage(`--since takes 30m, 24h, 7d or a date like 2026-11-01, got "${raw}"`);
  return at;
}

// The server keeps at most 1000; asking for all of them keeps a week's answer from stopping at the default 100.
async function audit(args: string[], options: Options): Promise<void> {
  if (args.length) throw usage('audit takes only options');
  const query = new URLSearchParams({ limit: '1000' });
  if (options.tenant) query.set('tenant', options.tenant);
  if (options.since) query.set('from', String(since(options.since)));
  if (options.action) query.set('action', options.action);
  if (options.actor) query.set('actor', options.actor);
  const rows: { at: number; actor: string; action: string; target: string; result: string }[] = await api('GET', `${ADMIN_PATHS.audit}?${query}`);
  if (options.json) return void console.log(JSON.stringify(rows, null, 2));
  for (const row of rows) console.log([new Date(row.at).toISOString(), row.actor, row.action, row.target, row.result].join('\t'));
}

const COMMANDS: Record<string, (args: string[], options: Options) => unknown> = {
  publish,
  init,
  list,
  show,
  logs: async (args, options) => {
    const query = options.tail === undefined ? '' : `?tail=${encodeURIComponent(options.tail)}`;
    process.stdout.write(await api('GET', ADMIN_PATHS.logs(one(args, 'logs')) + query));
  },
  unquarantine: async (args) => {
    const name = one(args, 'unquarantine');
    await api('POST', ADMIN_PATHS.unquarantine(name));
    console.log(`${name} unquarantined; the next request wakes it`);
  },
  remove: async (args) => {
    const name = one(args, 'remove');
    await api('POST', ADMIN_PATHS.remove(name));
    console.log(`removed ${name}; data kept, purge deletes it`);
  },
  purge,
  policy,
  owner,
  access: async (args) => {
    if (args.length !== 2) throw usage('access takes <name> tenant|org|public');
    const name = appName(args[0]);
    await api('PUT', ADMIN_PATHS.access(name), { access: args[1] });
    console.log(`${name} access ${args[1]}`);
  },
  whoami,
  tenant,
  member,
  token,
  quota,
  audit,
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
        container: { type: 'boolean' },
        static: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        tail: { type: 'string' },
        tenant: { type: 'string' },
        since: { type: 'string' },
        action: { type: 'string' },
        actor: { type: 'string' },
        json: { type: 'boolean' },
        kind: { type: 'string' },
        label: { type: 'string' },
        display: { type: 'string' },
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
