import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function extractPackage(bytes, digest, directory) {
  if (bytes.length > 4 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Package digest or size mismatch');
  const pkg = JSON.parse(bytes.toString('utf8'));
  if (pkg.manifest?.contract !== 'pneuma-space.cf/1' || pkg.manifest.runtime !== 'node' || !Array.isArray(pkg.files) || pkg.files.length > 256) throw new Error('Invalid package');
  const paths = new Set();
  for (const file of pkg.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.length > 300 || /[\\\x00-\x1f]/.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(file.path)) throw new Error('Invalid package path');
    if (typeof file.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.body)) throw new Error('Invalid base64');
    paths.add(file.path);
  }
  if (!paths.has(pkg.manifest.entry)) throw new Error('Missing entry');
  for (const file of pkg.files) {
    const path = join(directory, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(file.body, 'base64'), { flag: 'wx' });
  }
  return pkg.manifest;
}
