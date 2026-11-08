// node deploy/kubernetes/check.mjs: offline checks a schema validator cannot make. Built-in modules only, so it parses
// the YAML subset these files use (block maps and sequences, plain or quoted scalars, flow lists of scalars, {}) and
// rejects anything else.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const NOT_ON_THIS_PLANE = {
  PNEUMA_SPACE_NETWORK: 'Docker network for app containers',
  PNEUMA_SPACE_HTTP_PORT: 'host port compose publishes; subdomain addresses come from PNEUMA_SPACE_APPS_ORIGIN',
  PNEUMA_SPACE_VOLUME_SIZE: 'single-host nominal volume size (ADR 0023)',
  PNEUMA_SPACE_TOKEN: "appctl's platform token, not the gateway's",
  PNEUMA_SPACE_STORE_TEST_RETRY: 'test switch (store-pg.ts)',
};
// Well-known labels on objects the platform does not own (namespaces, kube-dns).
const FOREIGN_SELECTOR_KEYS = new Set(['kubernetes.io/metadata.name', 'k8s-app']);
// Compose service names the gateway and Providers dial; every other object is pneuma-space-*.
const COMPOSE_NAMES = new Set(['postgres', 'redis', 'rustfs', 'coturn', 'runner']);

function scalar(text, where) {
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith("'")) {
    if (!text.endsWith("'")) throw new Error(`${where}: unterminated quote`);
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text === '{}') return {};
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`${where}: flow list must close on its line`);
    const inner = text.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((part) => scalar(part.trim(), where));
  }
  if (/^[|>&*!{]/.test(text)) throw new Error(`${where}: unsupported YAML "${text}"`);
  return text;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i);
  }
  return line;
}

function parseDoc(lines) {
  let i = 0;
  const block = (indent) => (lines[i].text.startsWith('- ') || lines[i].text === '-' ? seq(indent) : map(indent));
  function seq(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      const line = lines[i];
      const rest = line.text.slice(1).trimStart();
      if (rest === '') { i++; out.push(block(lines[i].indent)); continue; }
      if (/^[^\s'"\[][^:]*:(\s|$)/.test(rest)) { lines[i] = { ...line, indent: indent + 2, text: rest }; out.push(map(indent + 2)); continue; }
      i++;
      out.push(scalar(rest, line.where));
    }
    return out;
  }
  function map(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const line = lines[i++];
      const match = /^([^\s'"\[][^:]*?):(?:\s+(.*))?$/.exec(line.text);
      if (!match) throw new Error(`${line.where}: expected "key: value", got "${line.text}"`);
      const [, key, value] = match;
      if (key in out) throw new Error(`${line.where}: duplicate key ${key}`);
      if (value !== undefined) out[key] = scalar(value, line.where);
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text.startsWith('- ')))) out[key] = block(lines[i].indent);
      else out[key] = null;
    }
    return out;
  }
  const doc = block(lines[0].indent);
  if (i !== lines.length) throw new Error(`${lines[i].where}: unexpected indentation`);
  return doc;
}

function parseFile(file) {
  const docs = [];
  let current = [];
  const flush = () => { if (current.length) docs.push(parseDoc(current)); current = []; };
  readFileSync(join(here, file), 'utf8').split('\n').forEach((raw, n) => {
    if (raw.trim() === '---') return flush();
    const text = stripComment(raw).trimEnd();
    if (text.trim() === '') return;
    if (raw.includes('\t')) throw new Error(`${file}:${n + 1}: tab`);
    current.push({ indent: text.length - text.trimStart().length, text: text.trim(), where: `${file}:${n + 1}` });
  });
  flush();
  return docs.map((doc) => ({ file, doc, id: doc.metadata ? `${file} ${doc.kind}/${doc.metadata.namespace ?? ''}/${doc.metadata.name}` : file }));
}

function* walk(node, path = []) {
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    yield [key, value, [...path, key]];
    yield* walk(value, [...path, key]);
  }
}

const failures = [];
const fail = (message) => failures.push(message);

const files = readdirSync(here).filter((name) => /^\d\d-.*\.yaml$/.test(name)).sort();
const objects = files.flatMap(parseFile);
const listed = parseFile('kustomization.yaml')[0].doc.resources;
for (const file of files) if (!listed.includes(file) && !/example|smoke/.test(file)) fail(`kustomization.yaml does not list ${file}`);

for (const { doc, id } of objects) {
  if (doc.metadata?.labels?.['app.kubernetes.io/part-of'] !== 'pneuma-space') fail(`${id}: missing label app.kubernetes.io/part-of=pneuma-space`);
  const name = doc.metadata?.name ?? '';
  if (!name.startsWith('pneuma-space') && !COMPOSE_NAMES.has(name)) fail(`${id}: name is neither pneuma-space-* nor a compose service`);
  for (const [key, value, path] of walk(doc)) {
    if (!/^(selector|podSelector|namespaceSelector|labelSelector)$/.test(key) || value === null) continue;
    if (value.matchExpressions) fail(`${id} ${path.join('.')}: matchExpressions`);
    const labels = doc.kind === 'Service' ? value : value.matchLabels ?? {};
    for (const label of Object.keys(labels)) {
      if (!label.startsWith('pneuma-space.') && !FOREIGN_SELECTOR_KEYS.has(label)) fail(`${id} ${path.join('.')}: selector label ${label} is not pneuma-space.*`);
    }
  }
}

const sources = new Map();
const define = (key, where) => sources.set(key, [...(sources.get(key) ?? []), where]);
const byName = (kind, namespace, name) => objects.find(({ doc }) => doc.kind === kind && doc.metadata.name === name && doc.metadata.namespace === namespace)?.doc;
for (const { doc, id } of objects) {
  if (doc.kind === 'ConfigMap') for (const key of Object.keys(doc.data ?? {})) define(key, id);
  if (doc.kind === 'Secret') for (const key of Object.keys(doc.stringData ?? {})) define(key, id);
  for (const [key, value, path] of walk(doc)) {
    if (key === 'env' && Array.isArray(value)) {
      for (const entry of value) if ('value' in entry || entry.valueFrom?.fieldRef) define(entry.name, `${id} ${path.join('.')}`);
    }
    const ns = doc.metadata.namespace;
    if (key === 'secretKeyRef' && byName('Secret', ns, value.name)?.stringData?.[value.key] === undefined) fail(`${id}: no key ${value.key} in Secret ${value.name}`);
    if (key === 'configMapKeyRef' && byName('ConfigMap', ns, value.name)?.data?.[value.key] === undefined) fail(`${id}: no key ${value.key} in ConfigMap ${value.name}`);
    if (key === 'secretRef' && !byName('Secret', ns, value.name)) fail(`${id}: no Secret ${value.name}`);
    if (key === 'configMapRef' && !byName('ConfigMap', ns, value.name)) fail(`${id}: no ConfigMap ${value.name}`);
  }
}

const READ = /\b(?:env|required|list)(?:\.|\[['"]|\(['"])(PNEUMA_SPACE_[A-Z0-9_]+)\b(?!['"]?\]?\s*=[^=])/g;
const gatewayFiles = readdirSync(join(root, 'gateway/src')).filter((name) => name.endsWith('.ts') && !/\.test\.ts$|\.harness\.ts$/.test(name));
const reads = new Set(gatewayFiles.flatMap((name) => [...readFileSync(join(root, 'gateway/src', name), 'utf8').matchAll(READ)].map((m) => m[1])));
const adrFiles = readdirSync(join(root, 'docs/adr')).filter((name) => /^00(19|2\d)-/.test(name));
const named = new Set(adrFiles.flatMap((name) => readFileSync(join(root, 'docs/adr', name), 'utf8').match(/PNEUMA_SPACE_[A-Z0-9_]+/g) ?? []));
const required = new Set([...reads, ...named].filter((key) => !(key in NOT_ON_THIS_PLANE)));
const compose = new Set(readFileSync(join(root, 'compose.yaml'), 'utf8').match(/PNEUMA_SPACE_[A-Z0-9_]+/g));

for (const key of [...required].sort()) {
  const where = sources.get(key) ?? [];
  if (where.length !== 1) fail(`${key} (${reads.has(key) ? 'read by the gateway' : 'named by an ADR'}) is set ${where.length} times${where.length ? `: ${where.join('; ')}` : ''}`);
}
for (const key of sources.keys()) {
  if (key.startsWith('PNEUMA_SPACE_') && !required.has(key) && !compose.has(key)) fail(`${key} is set but neither the gateway, an ADR nor compose.yaml names it`);
}

const config = byName('ConfigMap', 'pneuma-space', 'pneuma-space-gateway');
const cidrs = config.data.PNEUMA_SPACE_K8S_CLUSTER_CIDRS.split(',').sort().join(',');
for (const { doc, id } of objects) {
  for (const [key, value] of walk(doc)) {
    if (key === 'except' && [...value].sort().join(',') !== cidrs) fail(`${id}: ipBlock.except [${value}] differs from PNEUMA_SPACE_K8S_CLUSTER_CIDRS`);
  }
}

const placeholders = new Map();
for (const { doc, id } of [...objects, ...parseFile('kustomization.yaml')]) {
  for (const [, value, path] of walk(doc)) {
    if (typeof value !== 'string') continue;
    const key = path.filter((part) => Number.isNaN(Number(part))).at(-1);
    for (const token of value.match(/REPLACE_ME[A-Z_]*/g) ?? []) placeholders.set(token, [...new Set([...(placeholders.get(token) ?? []), `${id} ${key}`])]);
  }
}

console.log(`${objects.length} objects in ${files.length} files; ${required.size} env keys each set once (${reads.size} read by the gateway, ${named.size} named by ADRs 0019-0025)`);
for (const [key, why] of Object.entries(NOT_ON_THIS_PLANE)) console.log(`not set on Kubernetes: ${key} (${why})`);
for (const [token, where] of [...placeholders].sort()) console.log(`fill in: ${token}  ${where.join('; ')}`);
if (failures.length) {
  for (const message of failures) console.error(`FAIL ${message}`);
  process.exit(1);
}
console.log('ok');
