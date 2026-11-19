import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostedAccountIds } from '../../gateway/src/registry.ts';

const args = process.argv.slice(2);
if (args.some((value) => value !== '--rtc')) throw new Error('Usage: npm run dev:hosted -- [--rtc]');
const httpPort = process.env.PNEUMA_SPACE_HTTP_PORT || '58080';
const adminPort = process.env.PNEUMA_SPACE_ADMIN_PORT || '58081';
const controlOrigin = `http://localhost:${adminPort}`;
const env = {
  ...process.env,
  PNEUMA_SPACE_IDENTITY: 'hosted',
  PNEUMA_SPACE_HOSTED_DEVELOPMENT: 'true',
  PNEUMA_SPACE_HOSTED_DEVELOPMENT_USERS: 'alice,bob,operator',
  PNEUMA_SPACE_HOSTED_CONTROL_ORIGIN: controlOrigin,
  PNEUMA_SPACE_APPS_ORIGIN: `http://*.apps.localhost:${httpPort}`,
  PNEUMA_SPACE_PLATFORM_ADMINS: `user:${hostedAccountIds('development', 'operator').user}`,
  PNEUMA_SPACE_NETWORK: process.env.PNEUMA_SPACE_NETWORK || 'pneuma-space-hosted',
  PNEUMA_SPACE_HTTP_PORT: httpPort,
  PNEUMA_SPACE_ADMIN_PORT: adminPort,
  PNEUMA_SPACE_OBJECT_PORT: process.env.PNEUMA_SPACE_OBJECT_PORT || '59000',
};
execFileSync('docker', ['compose', '-p', 'pneuma-space-hosted', '--profile', 'isolate', '--profile', 'postgres',
  ...(args.includes('--rtc') ? ['--profile', 'rtc'] : []), 'up', '-d', '--build', '--wait'], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)), env, stdio: 'inherit',
});
process.stdout.write(`Console: ${controlOrigin}/\nSign in as operator for platform monitoring, or alice and bob for separate personal spaces.\n`);
