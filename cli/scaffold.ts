import { cpSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Copies `base` to `target`, deletes the `replace` paths there, then copies `overlay` over it. */
export function assemble(target: string, base: string, overlay: string | null, replace: readonly string[] = []): void {
  cpSync(base, target, { recursive: true, filter: (src) => !['node_modules', 'data'].includes(relative(base, src)) });
  for (const path of replace) rmSync(join(target, path), { recursive: true, force: true });
  if (overlay) cpSync(overlay, target, { recursive: true });
}
