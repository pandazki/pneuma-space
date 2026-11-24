import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
const example = new URL('../examples/notebook/', import.meta.url), output = new URL('../.build/notebook/', import.meta.url);
await mkdir(output, { recursive: true });
await build({ entryPoints: [new URL('src/main.ts', example).pathname], outfile: new URL('main.mjs', output).pathname, bundle: true, platform: 'node', format: 'esm', target: 'node24' });
await cp(new URL('public', example), new URL('public', output), { recursive: true });
await cp(new URL('pneuma-space.json', example), new URL('pneuma-space.json', output));
console.log('Built .build/notebook');
