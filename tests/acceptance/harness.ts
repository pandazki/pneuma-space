import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ADMIN_PATHS } from '../../gateway/src/model.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Its own project, ports and network, so the suite never touches a developer's stack. */
export const stack = {
  project: 'pneuma-acc',
  network: 'pneuma-acc',
  httpPort: Number(process.env.PNEUMA_ACC_HTTP_PORT ?? 18080),
  adminPort: Number(process.env.PNEUMA_ACC_ADMIN_PORT ?? 18081),
  objectPort: Number(process.env.PNEUMA_ACC_OBJECT_PORT ?? 19000),
};

export const ingressUrl = `http://127.0.0.1:${stack.httpPort}`;
export const adminUrl = `http://127.0.0.1:${stack.adminPort}`;

export function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '-p', stack.project, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PNEUMA_NETWORK: stack.network,
      PNEUMA_HTTP_PORT: String(stack.httpPort),
      PNEUMA_ADMIN_PORT: String(stack.adminPort),
      PNEUMA_OBJECT_PORT: String(stack.objectPort),
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
