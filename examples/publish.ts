import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from '../cli/scaffold.ts';

const [name, ...args] = process.argv.slice(2);
const here = fileURLToPath(new URL('.', import.meta.url));
const overlay = join(here, name ?? '');
if (!name || !existsSync(join(overlay, 'pneuma-space.json'))) {
  console.error('usage: node examples/publish.ts <example> [--assemble-only] [appctl publish options]');
  process.exit(2);
}

let dir = overlay;
if (!existsSync(join(overlay, 'Dockerfile'))) {
  const kind = existsSync(join(overlay, 'site')) ? 'static' : 'app';
  dir = join(here, '.build', name);
  rmSync(dir, { recursive: true, force: true });
  assemble(dir, join(here, '../templates', kind), overlay, ['pneuma-space.json', kind === 'static' ? 'site' : 'src']);
  console.log(`assembled ${dir}`);
}

if (!args.includes('--assemble-only')) {
  const appctl = join(here, '../cli/appctl.ts');
  process.exit(spawnSync(process.execPath, [appctl, 'publish', name, dir, ...args], { stdio: 'inherit' }).status ?? 1);
}
