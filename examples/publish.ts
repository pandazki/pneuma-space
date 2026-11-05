import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const [name, ...args] = process.argv.slice(2);
const here = fileURLToPath(new URL('.', import.meta.url));
const overlay = join(here, name ?? '');
if (!name || !existsSync(join(overlay, 'pneuma-space.json'))) {
  console.error('usage: node examples/publish.ts <example> [--assemble-only] [appctl publish options]');
  process.exit(2);
}

const kind = existsSync(join(overlay, 'site')) ? 'static' : 'app';
const scaffold = join(here, '../templates', kind);
const build = join(here, '.build', name);
rmSync(build, { recursive: true, force: true });
cpSync(scaffold, build, { recursive: true, filter: (src) => !['node_modules', 'data'].includes(relative(scaffold, src)) });
for (const business of ['pneuma-space.json', kind === 'static' ? 'site' : 'src']) rmSync(join(build, business), { recursive: true, force: true });
cpSync(overlay, build, { recursive: true });
console.log(`assembled ${build}`);

if (!args.includes('--assemble-only')) {
  const appctl = join(here, '../cli/appctl.ts');
  process.exit(spawnSync(process.execPath, [appctl, 'publish', name, build, ...args], { stdio: 'inherit' }).status ?? 1);
}
