import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ADMIN_PATHS, LOGIN_PATH } from '../../gateway/src/model.ts';
import { presign } from './fixtures/echo/server.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Its own project, ports and network, so the suite never touches a developer's stack. */
export const stack = {
  project: 'pneuma-space-acc',
  network: 'pneuma-space-acc',
  httpPort: Number(process.env.PNEUMA_SPACE_ACC_HTTP_PORT ?? 18080),
  adminPort: Number(process.env.PNEUMA_SPACE_ACC_ADMIN_PORT ?? 18081),
  objectPort: Number(process.env.PNEUMA_SPACE_ACC_OBJECT_PORT ?? 19000),
};

export const ingressUrl = `http://127.0.0.1:${stack.httpPort}`;
export const adminUrl = `http://127.0.0.1:${stack.adminPort}`;

export function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '-p', stack.project, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PNEUMA_SPACE_NETWORK: stack.network,
      PNEUMA_SPACE_HTTP_PORT: String(stack.httpPort),
      PNEUMA_SPACE_ADMIN_PORT: String(stack.adminPort),
      PNEUMA_SPACE_OBJECT_PORT: String(stack.objectPort),
    },
  });
}

export async function composeUp(...profiles: string[]): Promise<void> {
  compose(...profiles.flatMap((p) => ['--profile', p]), 'up', '-d', '--build', '--wait');
  await waitFor(async () => (await fetch(adminUrl + ADMIN_PATHS.health).catch(() => null))?.ok, 30_000, 'admin health');
}

/** Keeps volumes, as an operator's `docker compose down` would. */
export function composeDown(): void {
  compose('--profile', 'postgres', '--profile', 'rtc', 'down');
}

export async function waitFor<T>(probe: () => T | Promise<T>, timeoutMs: number, what = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function uniqueName(prefix = 't'): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

export type Reply = { status: number; body: any };

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function call(method: string, path: string, init: RequestInit = {}): Promise<Reply> {
  const response = await fetch(adminUrl + path, { method, ...init });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** The admin endpoints of docs/app-contract.md; replies are returned whatever their status. */
export const adminClient = {
  health: () => call('GET', ADMIN_PATHS.health),
  apps: () => call('GET', ADMIN_PATHS.apps),
  app: (name: string) => call('GET', ADMIN_PATHS.app(name)),
  publish: (name: string, release: { image: string | null; manifest: unknown; bundle?: string | null; owner?: string }) =>
    call('PUT', ADMIN_PATHS.release(name), json({ bundle: null, ...release })),
  uploadBundle: (tar: Uint8Array<ArrayBuffer>) => call('POST', ADMIN_PATHS.bundles, { body: tar }),
  setPolicy: (fields: Record<string, unknown>) => call('PUT', ADMIN_PATHS.policy, json(fields)),
  setAppPolicy: (name: string, fields: Record<string, unknown>) => call('PUT', ADMIN_PATHS.appPolicy(name), json(fields)),
  setOwner: (name: string, owner: string) => call('PUT', ADMIN_PATHS.owner(name), json({ owner })),
  remove: (name: string) => call('POST', ADMIN_PATHS.remove(name)),
  purge: (name: string) => call('POST', ADMIN_PATHS.purge(name)),
  createToken: (name: string) => call('POST', ADMIN_PATHS.tokens, json({ name })),
};

// Fixtures and publishing

export const fixtureDir = (name: string) => fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));
export const images = { echo: 'pneuma-space-acc-fixture/echo:1', echo2: 'pneuma-space-acc-fixture/echo:2' } as const;
export const OWNER = 'user:acc-owner';

export function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Starts the stack with both profiles and builds the fixture images, once per process; every test file calls it first. */
let ready: Promise<void> | undefined;
export const setupSuite = () => (ready ??= (async () => {
  await composeUp('postgres', 'rtc');
  for (const [variant, ref] of [['1', images.echo], ['2', images.echo2]]) {
    docker('build', '-q', '--build-arg', `VARIANT=${variant}`, '-t', ref, fixtureDir('echo'));
  }
})());

export function teardownSuite(): void {
  for (const ref of Object.values(images)) {
    try { docker('rmi', ref); } catch {}
  }
}

export type Capabilities = Record<string, unknown>;
export type PublishOptions = { image: string | null; capabilities: Capabilities; staticDir?: string; owner?: string };

export function appctl(...args: string[]): string {
  return execFileSync(process.execPath, [join(root, 'cli/appctl.ts'), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PNEUMA_SPACE_ADMIN: adminUrl },
  });
}

/** `appctl publish` with a manifest written for this call; the static dir is copied next to it. */
export function publish(name: string, { image, capabilities, staticDir, owner = OWNER }: PublishOptions): string {
  const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-acc-'));
  try {
    const caps = staticDir ? { ...capabilities, static: { dir: 'static' } } : capabilities;
    if (staticDir) cpSync(staticDir, join(dir, 'static'), { recursive: true });
    writeFileSync(join(dir, 'pneuma-space.json'), JSON.stringify({ contract: 1, capabilities: caps }));
    const target = image ? [image, '--manifest', join(dir, 'pneuma-space.json')] : [dir];
    try {
      return appctl('publish', name, ...target, '--owner', owner);
    } catch (error) {
      throw new Error(`appctl publish ${name} failed: ${(error as { stderr?: string }).stderr || (error as Error).message}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type Deployed = { name: string; id: string };

/** Publishes a fresh app and removes and purges it when the test ends. */
export async function deploy(t: TestContext, options: PublishOptions): Promise<Deployed> {
  const name = uniqueName('acc');
  t.after(() => cleanup(name));
  publish(name, options);
  return { name, id: await appId(name) };
}

export async function appId(name: string): Promise<string> {
  const detail = await adminClient.app(name);
  if (detail.status !== 200 || !detail.body?.app?.id) throw new Error(`GET /api/apps/${name}: ${detail.status} ${JSON.stringify(detail.body)}`);
  return detail.body.app.id;
}

/** Remove then purge; if purge fails, sweep what the platform left so the machine stays clean. */
export async function cleanup(name: string): Promise<void> {
  const id = await appId(name).catch(() => null);
  await adminClient.remove(name).catch(() => null);
  const purged = await adminClient.purge(name).catch(() => null);
  if (!id || (purged && purged.status < 300)) return;
  for (const container of docker('ps', '-aq', '--filter', `name=^pneuma-space-${id}-`).split('\n').filter(Boolean)) docker('rm', '-f', container);
  for (const volume of [`pneuma-space-files-${id}`, `pneuma-space-db-${id}`]) {
    try { docker('volume', 'rm', '-f', volume); } catch {}
  }
}

// Ingress

export const appUrl = (name: string, path = '/') => `${ingressUrl}/apps/${name}${path}`;

export async function appJson(name: string, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(appUrl(name, path), init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} /apps/${name}${path}: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export const appPut = (name: string, path: string, body: string) => appJson(name, path, { method: 'PUT', body });

/** Logs in through the local IdentityProvider and returns the `cookie` header value. */
export async function login(user: string): Promise<string> {
  const response = await fetch(ingressUrl + LOGIN_PATH, {
    method: 'POST',
    body: new URLSearchParams({ name: user, next: '/apps/' }),
    redirect: 'manual',
  });
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith('pneuma_space_session='));
  if (!cookie) throw new Error(`login as ${user}: ${response.status}, no pneuma_space_session cookie`);
  return cookie.split(';')[0];
}

export const browser = (cookie: string) => ({ cookie, accept: 'text/html' });

export async function serviceToken(name: string): Promise<string> {
  const reply = await adminClient.createToken(name);
  if (reply.status >= 300 || !reply.body?.token) throw new Error(`POST /api/tokens: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body.token;
}

export type Socket = { ws: WebSocket; next(timeoutMs?: number): Promise<string>; closed: Promise<number> };

export async function connect(name: string, path = '/ws'): Promise<Socket> {
  const ws = new WebSocket(appUrl(name, path).replace(/^http/, 'ws'));
  const inbox: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws.addEventListener('message', (e) => {
    const waiter = waiters.shift();
    if (waiter) waiter(String(e.data));
    else inbox.push(String(e.data));
  });
  const closed = new Promise<number>((ok) => ws.addEventListener('close', (e) => ok(e.code)));
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok);
    ws.addEventListener('error', () => fail(new Error(`WebSocket ${path} on ${name} did not open`)));
  });
  const next = (timeoutMs = 5000) => {
    if (inbox.length) return Promise.resolve(inbox.shift()!);
    return new Promise<string>((ok, fail) => {
      const waiter = (m: string) => (clearTimeout(timer), ok(m));
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        fail(new Error(`no WebSocket message on ${name} within ${timeoutMs} ms`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  return { ws, next, closed };
}

// Platform state seen from outside

export async function summary(name: string): Promise<any> {
  const reply = await adminClient.apps();
  if (reply.status !== 200 || !Array.isArray(reply.body)) throw new Error(`GET /api/apps: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body.find((app: { name: string }) => app.name === name) ?? null;
}

export const waitInstance = (name: string, state: string, timeoutMs: number) =>
  waitFor(async () => (await summary(name))?.instance === state, timeoutMs, `${name} instance ${state}`);

export async function setIdle(name: string, seconds: number): Promise<void> {
  const reply = await adminClient.setAppPolicy(name, { idle_seconds: seconds });
  if (reply.status >= 300) throw new Error(`PUT policy for ${name}: ${reply.status} ${JSON.stringify(reply.body)}`);
}

/** The app's container, running or stopped, by the name the Runtime gives it (`pneuma-space-<id>-<release>`). */
export const containerFor = (id: string): string | null => docker('ps', '-aq', '--filter', `name=^pneuma-space-${id}-`).split('\n')[0] || null;
export const runningContainerFor = (id: string): string | null => docker('ps', '-q', '--filter', `name=^pneuma-space-${id}-`).split('\n')[0] || null;
export const startedAt = (container: string) => Date.parse(docker('inspect', '-f', '{{.State.StartedAt}}', container));
export const dockerExec = (container: string, ...command: string[]) => docker('exec', container, ...command);

export function containerNetBytes(container: string): number {
  const read = (file: string) => Number(dockerExec(container, 'cat', `/sys/class/net/eth0/statistics/${file}`));
  return read('rx_bytes') + read('tx_bytes');
}

export const gatewayContainer = () => compose('ps', '-q', 'gateway').trim();

export function gatewayRss(): number {
  const kb = dockerExec(gatewayContainer(), 'cat', '/proc/1/status').match(/^VmRSS:\s+(\d+) kB/m);
  if (!kb) throw new Error('no VmRSS in the gateway /proc/1/status');
  return Number(kb[1]) * 1024;
}

export async function restartGateway(how: 'restart' | 'kill' = 'restart'): Promise<void> {
  if (how === 'kill') compose('kill', 'gateway');
  compose(...(how === 'kill' ? ['up', '-d', 'gateway'] : ['restart', 'gateway']));
  await waitFor(async () => (await fetch(adminUrl + ADMIN_PATHS.health).catch(() => null))?.ok, 30_000, 'admin health after gateway restart');
}

export const volumeExists = (volume: string) => docker('volume', 'ls', '-q', '--filter', `name=^${volume}$`) === volume;

const rootCredential = {
  accessKey: process.env.PNEUMA_SPACE_OBJECT_ROOT_USER ?? 'pneuma-local',
  secretKey: process.env.PNEUMA_SPACE_OBJECT_ROOT_PASSWORD ?? 'pneuma-local-secret',
};
export const objectUrl = `http://127.0.0.1:${stack.objectPort}`;

export async function bucketExists(bucket: string): Promise<boolean> {
  const url = presign({ ...rootCredential, method: 'HEAD', endpoint: objectUrl, bucket });
  return (await fetch(url, { method: 'HEAD' })).status === 200;
}

/** Runs an ES module in a throwaway container on the stack network and returns its JSON output. */
export function inNetwork(script: string, ...args: string[]): any {
  const out = execFileSync('docker', ['run', '--rm', '-i', '--network', stack.network, 'node:24-alpine', 'node', '--input-type=module', '-', ...args], {
    input: script,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

export const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export const containerIp = (container: string) =>
  docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${stack.network}").IPAddress}}`, container);

/** Admin view of an app's deliveries for one trigger. */
export async function deliveries(name: string, trigger: string): Promise<any[]> {
  const reply = await adminClient.app(name);
  if (reply.status !== 200) throw new Error(`GET /api/apps/${name}: ${reply.status} ${JSON.stringify(reply.body)}`);
  return (reply.body.deliveries ?? []).filter((d: { trigger: string }) => d.trigger === trigger);
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
