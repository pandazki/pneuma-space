import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedAccountIds } from '../../gateway/src/registry.ts';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
const project = 'pneuma-space-tls-check';
if (execFileSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' }).trim()) {
  throw new Error(`${project} still has containers; stop the previous verification before starting another`);
}
const directory = mkdtempSync(join(tmpdir(), 'pneuma-space-tls-'));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PNEUMA_SPACE_') && !key.startsWith('COMPOSE_'))),
  PNEUMA_SPACE_IDENTITY: 'hosted',
  PNEUMA_SPACE_HOSTED_DEVELOPMENT: 'true',
  PNEUMA_SPACE_HOSTED_DEVELOPMENT_USERS: 'alice,bob,operator',
  PNEUMA_SPACE_HOSTED_CONTROL_ORIGIN: 'https://localhost:54443',
  PNEUMA_SPACE_APPS_ORIGIN: 'https://*.apps.localhost:54443',
  PNEUMA_SPACE_OBJECT_PUBLIC_ENDPOINT: 'https://objects.localhost:54443',
  PNEUMA_SPACE_PLATFORM_ADMINS: `user:${hostedAccountIds('development', 'operator').user}`,
  PNEUMA_SPACE_NETWORK: project,
  PNEUMA_SPACE_HTTP_PORT: '48080',
  PNEUMA_SPACE_ADMIN_PORT: '48081',
  PNEUMA_SPACE_OBJECT_PORT: '49000',
  PNEUMA_SPACE_TLS_TEST_CERTS: directory,
};
const compose = ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'compose.yaml', '-f', 'deploy/hosted/tls.compose.yaml', '--profile', 'isolate', '--profile', 'postgres'];
let active: ChildProcess | null = null;
const interrupt = (signal: NodeJS.Signals) => { active?.kill(signal); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const run = (command: string, args: string[], overrides: NodeJS.ProcessEnv = env): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env: overrides, stdio: 'inherit' });
  active = child;
  child.once('error', reject);
  child.once('close', (code, signal) => {
    active = null;
    if (code === 0) resolve();
    else reject(new Error(`${command} ended with ${signal ?? code}`));
  });
});
try {
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.crt'),
    '-days', '1', '-subj', '/CN=PneumaSpace local TLS acceptance', '-addext', 'subjectAltName=DNS:localhost,DNS:*.apps.localhost,DNS:objects.localhost']);
  for (const site of ['control', 'apps', 'objects']) {
    mkdirSync(join(directory, site));
    for (const file of ['tls.crt', 'tls.key']) copyFileSync(join(directory, file), join(directory, site, file));
  }
  await run('docker', [...compose, 'up', '-d', '--build', '--wait']);
  await run('docker', [...compose, 'exec', '-T', 'tls', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile']);
  await run(process.execPath, ['--test', '--test-concurrency=1', 'tests/hosted/hosted.test.ts', 'tests/hosted/tls.test.ts'], {
    ...env,
    NODE_EXTRA_CA_CERTS: join(directory, 'tls.crt'),
    PNEUMA_SPACE_HOSTED_TEST_CONTROL: env.PNEUMA_SPACE_HOSTED_CONTROL_ORIGIN,
    PNEUMA_SPACE_HOSTED_TEST_APPS: env.PNEUMA_SPACE_APPS_ORIGIN,
    PNEUMA_SPACE_TLS_TEST_PROJECT: project,
  });
} finally {
  try { await run('docker', [...compose, 'down']); }
  finally {
    rmSync(directory, { recursive: true, force: true });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
