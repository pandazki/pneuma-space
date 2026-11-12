import { asObject, capabilitiesFor, onlyKeys, runtimesFor } from '../../shared/catalog.ts';
import { InputError } from '../../shared/values.ts';
import { sha256 } from './crypto.ts';
import { invalid, quota } from './errors.ts';
import type { Artifact, Asset, CloudManifest, Limits, PreparedArtifact } from './model.ts';
import type { RecordsSnapshot } from './records-contract.ts';
import { validateRecordsSnapshot } from './records.ts';

export type Archive = { format: 1; artifact: Artifact; records: RecordsSnapshot; checksum: string };
const encoder = new TextEncoder();

export function assetPath(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 512 || /[\\\p{Cc}%?#]/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')
    || value.startsWith('_pneuma-space/')) invalid('Invalid asset path.');
  return value;
}

function manifest(raw: unknown): CloudManifest {
  const input = asObject(raw, 'manifest');
  onlyKeys(input, ['contract', 'runtime', 'abi', 'entry', 'capabilities'], 'manifest');
  if (input.contract !== 2 || input.runtime !== 'fetch' || !(input.runtime in runtimesFor(2))
    || input.abi !== 'pneuma-space.fetch/1' || input.entry !== 'app.mjs') invalid('Unsupported cloud application profile.');
  const declarations = asObject(input.capabilities, 'capabilities');
  const catalog = capabilitiesFor(2);
  onlyKeys(declarations, Object.keys(catalog), 'capabilities');
  const capabilities: CloudManifest['capabilities'] = {};
  for (const kind of Object.keys(catalog)) {
    if (!Object.hasOwn(declarations, kind)) continue;
    const declaration = declarations[kind];
    if (kind === 'records') capabilities.records = catalog.records.parse(declaration, kind);
    else if (kind === 'identity') {
      onlyKeys(asObject(declaration, kind), [], kind);
      capabilities.identity = {};
    } else if (kind === 'static') {
      const parsed = catalog.static.parse(declaration, kind);
      capabilities.static = { dir: assetPath(parsed.dir) };
    } else invalid('Route is implicit.');
  }
  return { contract: 2, runtime: 'fetch', abi: 'pneuma-space.fetch/1', entry: 'app.mjs', capabilities };
}

export function decodeAsset(body: string): Uint8Array {
  let decoded: string;
  try { decoded = atob(body); } catch { invalid('Invalid asset base64.'); }
  if (btoa(decoded) !== body) invalid('Asset base64 must be canonical.');
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

export async function prepareArtifact(raw: unknown, limits: Limits): Promise<PreparedArtifact> {
  try {
    if (encoder.encode(JSON.stringify(raw)).byteLength > limits.artifactBytes) quota('Artifact exceeds the byte limit.');
    const input = asObject(raw, 'artifact');
    onlyKeys(input, ['manifest', 'source', 'assets'], 'artifact');
    const parsed = manifest(input.manifest);
    if (typeof input.source !== 'string' || !input.source.trim() || !input.source.isWellFormed()) invalid('Source must be a JavaScript module.');
    if (!Array.isArray(input.assets) || input.assets.length > 256) invalid('Invalid asset list.');
    if (input.assets.length && !parsed.capabilities.static) invalid('Static assets require the static capability.');
    const paths = new Set<string>();
    const assets: Asset[] = input.assets.map(rawAsset => {
      const asset = asObject(rawAsset, 'asset');
      onlyKeys(asset, ['path', 'contentType', 'body'], 'asset');
      const path = assetPath(asset.path);
      if (paths.has(path)) invalid('Asset paths must be unique.');
      paths.add(path);
      if (typeof asset.contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+(?:; charset=utf-8)?$/.test(asset.contentType)) invalid('Invalid asset content type.');
      if (typeof asset.body !== 'string') invalid('Asset body must be base64.');
      decodeAsset(asset.body);
      return { path, contentType: asset.contentType, body: asset.body };
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const artifact: Artifact = { manifest: parsed, source: input.source, assets };
    const serialized = JSON.stringify(artifact);
    const bytes = encoder.encode(serialized).byteLength;
    if (bytes > limits.artifactBytes) quota('Artifact exceeds the byte limit.');
    return { artifact, digest: await sha256(serialized), bytes };
  } catch (error) {
    if (error instanceof InputError) invalid(error.message);
    throw error;
  }
}

export async function createArchive(artifact: Artifact, records: RecordsSnapshot): Promise<Archive> {
  const content = { format: 1 as const, artifact, records };
  return { ...content, checksum: await sha256(JSON.stringify(content)) };
}

export async function parseArchive(raw: unknown, limits: Limits): Promise<{ prepared: PreparedArtifact; records: RecordsSnapshot }> {
  const archive = asObject(raw, 'archive');
  onlyKeys(archive, ['format', 'artifact', 'records', 'checksum'], 'archive');
  if (archive.format !== 1 || typeof archive.checksum !== 'string') invalid('Unsupported archive.');
  const prepared = await prepareArtifact(archive.artifact, limits);
  const records = validateRecordsSnapshot(archive.records, limits.records);
  if (!prepared.artifact.manifest.capabilities.records && records.records.length) invalid('Archive has undeclared records.');
  const expected = await createArchive(prepared.artifact, records);
  if (expected.checksum !== archive.checksum) invalid('Archive checksum does not match.');
  return { prepared, records };
}
