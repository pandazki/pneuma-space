// Wake of an asleep Node app by package size: node scripts/bench-wake.mjs [--rounds N] [--sizes 30000,1048576] [--app ID] [--keep] [--out file.jsonl]
// One ephemeral app holds one release per size; each cycle rolls back to a size, sleeps the app and wakes it with one request.
// It prints no origin, URL or credential. --app reuses an app and its releases; the app is discarded at the end unless --keep.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { connect } from './client.mjs';

const { values: options } = parseArgs({ options: { rounds: { type: 'string', default: '8' }, sizes: { type: 'string', default: '30000,1048576,2516582,4089446' }, app: { type: 'string' }, keep: { type: 'boolean', default: false }, out: { type: 'string' } } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const b64 = text => Buffer.from(text).toString('base64');
const median = values => { const sorted = values.filter(v => v !== null).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null; };
const range = values => { const known = values.filter(v => v !== null); return known.length ? Math.min(...known) + '-' + Math.max(...known) : '-'; };
const MiB = 1024 * 1024;

function build(target) {
  const manifest = { contract: 'pneuma-space.cf/1', runtime: 'node', entry: 'server.mjs', capabilities: { static: { dir: 'public' } } };
  const server = "import http from 'node:http';import {randomUUID} from 'node:crypto';const boot=randomUUID();http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({boot}))}).listen(Number(process.env.PNEUMA_SPACE_PORT),'0.0.0.0');";
  const files = [{ path: 'server.mjs', body: b64(server), contentType: 'text/javascript' }, { path: 'public/index.html', body: b64('<!doctype html><title>wake bench</title>'), contentType: 'text/html' }];
  let staticBytes = 0;
  for (let rest = target - JSON.stringify({ manifest, files }).length, i = 0; rest > 200; rest = target - JSON.stringify({ manifest, files }).length, i++) {
    const raw = Math.min(512 * 1024, Math.floor((rest - 100) * 3 / 4));
    files.push({ path: 'public/blob-' + i + '.bin', body: randomBytes(raw).toString('base64'), contentType: 'application/octet-stream' });
    staticBytes += raw;
  }
  const bytes = Buffer.from(JSON.stringify({ manifest, files }));
  return { manifest, bytes, digest: createHash('sha256').update(bytes).digest('hex'), staticBytes };
}

const client = await connect();
const tenant = client.me.tenants[0].id;
const retrying = async (operation, codes = ['compute_quota', 'ephemeral_quota']) => {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); } catch (error) {
      if (!codes.includes(error.code) || attempt >= 40) throw error;
      console.error('waiting: ' + error.code); await delay(15000);
    }
  }
};
let app, tokenId, errors = 0;
const samples = [];
try {
  const releases = new Map();
  if (options.app) {
    app = await client.api('/apps/' + options.app);
    for (const release of app.releases.filter(r => r.manifest.runtime === 'node')) if (!releases.has(release.bytes)) releases.set(release.bytes, { number: release.number, packageBytes: release.bytes, staticBytes: null });
  } else {
    app = await retrying(() => client.api('/tenants/' + tenant + '/apps', { name: 'wake-bench-' + randomUUID().slice(0, 8), ephemeral: { ttlSeconds: 3600 } }));
    for (const target of options.sizes.split(',').map(Number)) {
      const { manifest, bytes, digest, staticBytes } = build(target);
      const ticket = await client.api('/apps/' + app.id + '/uploads', { manifest, digest, bytes: bytes.length, ephemeral: true });
      const put = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes, signal: AbortSignal.timeout(120000) });
      if (put.status !== 200) throw new Error('Upload answered ' + put.status);
      const snapshot = await retrying(() => client.api('/apps/' + app.id + '/releases', { uploadId: ticket.uploadId, ephemeral: true }));
      releases.set(bytes.length, { number: snapshot.current.number, packageBytes: bytes.length, staticBytes });
    }
  }
  console.error('app ' + app.name + ' (' + app.id + '), releases ' + JSON.stringify([...releases.values()]));
  const created = await client.api('/tenants/' + tenant + '/tokens', { label: 'wake-bench', scopes: ['invoke'], appIds: [app.id], expiresAt: Date.now() + 3600000 });
  tokenId = created.id;
  const sizes = [...releases.values()].sort((a, b) => a.packageBytes - b.packageBytes);
  let current = (await client.api('/apps/' + app.id)).current?.number, lastBoot = null;
  const record = async sample => { samples.push(sample); if (options.out) await appendFile(options.out, JSON.stringify(sample) + '\n'); console.error(JSON.stringify(sample)); };
  for (let round = 0; round < Number(options.rounds); round++) {
    for (let k = 0; k < sizes.length; k++) {
      const size = sizes[(k + round) % sizes.length];
      const base = { round, packageBytes: size.packageBytes, staticBytes: size.staticBytes };
      if (current !== size.number) {
        const before = (await client.api('/apps/' + app.id)).wake?.bootId;
        await retrying(() => client.api('/apps/' + app.id + '/actions', { type: 'rollback', release: size.number }));
        const wake = (await client.api('/apps/' + app.id)).wake;
        current = size.number;
        await record({ ...base, kind: 'publish', ok: wake?.bootId !== before && wake?.outcome === 'ready', wallMs: null, phases: wake?.phases ?? null });
      }
      await client.api('/apps/' + app.id + '/actions', { type: 'sleep' });
      await delay(1500);
      const before = (await client.api('/apps/' + app.id)).wake?.bootId;
      let status, body, wallMs, timing;
      for (let attempt = 0; attempt < 40; attempt++) {
        const started = performance.now();
        const response = await fetch(app.url + 'ping', { headers: { authorization: 'Bearer ' + created.token }, signal: AbortSignal.timeout(60000) });
        body = await response.text(); wallMs = Math.round(performance.now() - started); status = response.status; timing = response.headers.get('server-timing');
        if (status !== 503) break;
        errors++; console.error('waiting: request answered 503 ' + body.slice(0, 120)); await delay(15000);
      }
      let wake;
      for (let poll = 0; poll < 20; poll++) {
        wake = (await client.api('/apps/' + app.id)).wake;
        if (wake?.bootId !== before && wake?.phases.respond !== null) break;
        await delay(250);
      }
      const boot = status === 200 ? JSON.parse(body).boot : null;
      const ok = status === 200 && boot !== lastBoot && wake?.bootId !== before && wake?.outcome === 'ready';
      if (!ok) errors++;
      lastBoot = boot;
      await record({ ...base, kind: 'request', ok, status, wallMs, serverTiming: timing, phases: wake?.phases ?? null });
    }
  }
} finally {
  if (tokenId) await client.api('/tenants/' + tenant + '/tokens/' + tokenId, undefined, 'DELETE');
  if (app && !options.keep) await client.api('/apps/' + app.id + '/actions', { type: 'discard' });
  await client.close();
}

const phase = (s, name) => s.phases?.[name] ?? null;
const sum = (s, names) => names.some(n => phase(s, n) === null) ? null : names.reduce((t, n) => t + phase(s, n), 0);
console.log(['kind', 'package MiB', 'n', 'fetch', 'unpack', 'fetch+unpack', 'listen', 'container', 'wall'].join('\t'));
const groups = Map.groupBy(samples.filter(s => s.ok), s => s.kind + ' ' + s.packageBytes);
for (const [, group] of [...groups].sort()) {
  const cell = values => median(values) + ' (' + range(values) + ')';
  console.log([group[0].kind, (group[0].packageBytes / MiB).toFixed(2), group.length, cell(group.map(s => phase(s, 'fetch'))), cell(group.map(s => phase(s, 'unpack'))), cell(group.map(s => sum(s, ['fetch', 'unpack']))), cell(group.map(s => phase(s, 'listen'))), cell(group.map(s => phase(s, 'container'))), group[0].kind === 'request' ? cell(group.map(s => s.wallMs)) : '-'].join('\t'));
}
const points = samples.filter(s => s.ok && sum(s, ['fetch', 'unpack']) !== null).map(s => [s.packageBytes / MiB, sum(s, ['fetch', 'unpack'])]);
const mx = points.reduce((t, [x]) => t + x, 0) / points.length, my = points.reduce((t, [, y]) => t + y, 0) / points.length;
const slope = points.reduce((t, [x, y]) => t + (x - mx) * (y - my), 0) / points.reduce((t, [x]) => t + (x - mx) ** 2, 0);
console.log(JSON.stringify({ samples: samples.length, errors, fetchUnpackMsPerPackageMiB: Math.round(slope), interceptMs: Math.round(my - slope * mx) }));
