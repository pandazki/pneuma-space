// Runtime benchmark against a running stack: one tiny app per runtime; first request after publish, wake after sleep, warm request; one TSV per run.
// node tests/bench/runtimes.ts [--rounds 5] [--out file]; PNEUMA_SPACE_ADMIN and PNEUMA_SPACE_INGRESS name the stack.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const admin = (process.env.PNEUMA_SPACE_ADMIN ?? 'http://127.0.0.1:8081').replace(/\/$/, '');
const ingress = (process.env.PNEUMA_SPACE_INGRESS ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const flag = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : process.argv[i + 1]; };
const rounds = Number(flag('rounds', '5'));
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = join(root, 'tests/acceptance/fixtures');
const OWNER = 'user:bench';
const IMAGE = 'pneuma-space-bench/echo:1';
const CAPABILITIES = { files: {}, db: {} };
const WARM_REQUESTS = 20;

const sh = (file: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
const appctl = (...args: string[]) => sh(process.execPath, [join(root, 'cli/appctl.ts'), ...args], { PNEUMA_SPACE_ADMIN: admin });
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const fmt = (ms: number) => ms.toFixed(ms < 10 ? 1 : 0);

/** `appctl publish` from a scratch directory holding the manifest and whatever `fill` adds; returns the publish arguments. */
function publish(name: string, manifest: unknown, fill: (dir: string) => string[]): void {
  const dir = mkdtempSync(join(tmpdir(), 'pneuma-space-bench-'));
  try {
    writeFileSync(join(dir, 'pneuma-space.json'), JSON.stringify(manifest));
    appctl('publish', name, ...fill(dir), '--owner', OWNER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Target = { path: string; prepare?: () => void; publish: (name: string) => void };
const targets: Record<string, Target> = {
  container: {
    path: '/env',
    prepare: () => sh('docker', ['build', '-q', '-t', IMAGE, join(fixtures, 'echo')]),
    publish: (name) => publish(name, { contract: 1, capabilities: CAPABILITIES }, (dir) => [IMAGE, '--manifest', join(dir, 'pneuma-space.json')]),
  },
  isolate: {
    path: '/',
    publish: (name) => publish(name, { contract: 1, runtime: 'isolate', capabilities: CAPABILITIES }, (dir) => {
      cpSync(join(fixtures, 'isolate/src'), join(dir, 'src'), { recursive: true });
      return [dir];
    }),
  },
  static: {
    path: '/',
    publish: (name) => publish(name, { contract: 1, capabilities: { static: { dir: 'static' } } }, (dir) => {
      cpSync(join(fixtures, 'static-site'), join(dir, 'static'), { recursive: true });
      return [dir];
    }),
  },
};

async function timed(url: string): Promise<number> {
  const started = performance.now();
  const reply = await fetch(url);
  await reply.arrayBuffer();
  if (reply.status !== 200) throw new Error(`${url}: ${reply.status}`);
  return performance.now() - started;
}

async function listing(): Promise<{ name: string; instance: string }[]> {
  const reply = await fetch(`${admin}/api/apps`);
  if (reply.status !== 200) throw new Error(`GET /api/apps: ${reply.status}`);
  return reply.json() as Promise<{ name: string; instance: string }[]>;
}

async function waitAsleep(name: string): Promise<void> {
  for (const until = Date.now() + 60_000; Date.now() < until; await sleep(200)) {
    const state = (await listing()).find((app) => app.name === name)?.instance;
    if (state === 'asleep' || state === 'none') return;
  }
  throw new Error(`${name} did not fall asleep within 60 s`);
}

type Row = { runtime: string; metric: string; n: number; median: number; max: number };
const rows: Row[] = [];
const record = (runtime: string, metric: string, values: number[]) => rows.push({ runtime, metric, n: values.length, median: median(values), max: Math.max(...values) });

async function measure(runtime: string, target: Target): Promise<void> {
  const name = `bench-${runtime}`;
  const url = `${ingress}/apps/${name}${target.path}`;
  try {
    target.prepare?.();
    target.publish(name);
  } catch (error) {
    const text = String((error as { stderr?: string }).stderr ?? error);
    if (/not available/.test(text)) { console.log(`${runtime}: unavailable on this stack, skipped`); return; }
    throw new Error(`${runtime}: publish failed: ${text}`);
  }
  try {
    const warm: number[] = [];
    const warmRound = async () => { for (let i = 0; i < WARM_REQUESTS; i++) warm.push(await timed(url)); };
    if (runtime === 'static') {
      await warmRound();
      record(runtime, 'warm', warm);
      return;
    }
    appctl('policy', name, 'idle_seconds=1');
    const first = await timed(url);
    const wake: number[] = [];
    for (let round = 0; round < rounds; round++) {
      await warmRound();
      await waitAsleep(name);
      wake.push(await timed(url));
      process.stdout.write(`${runtime} round ${round + 1}/${rounds}: wake ${fmt(wake.at(-1)!)} ms, warm ${fmt(median(warm.slice(-WARM_REQUESTS)))} ms\n`);
    }
    record(runtime, 'first', [first]);
    record(runtime, 'wake', wake);
    record(runtime, 'warm', warm);
  } finally {
    for (const verb of [['remove', name], ['purge', name, '--yes']]) {
      try { appctl(...verb); } catch (error) { console.error(`appctl ${verb.join(' ')}: ${(error as { stderr?: string }).stderr ?? error}`); }
    }
  }
}

const commit = (() => { try { return sh('git', ['-C', root, 'rev-parse', '--short', 'HEAD']); } catch { return 'unknown'; } })();
const at = new Date().toISOString();
const load = loadavg()[0].toFixed(1);
console.log(`stack ${admin}, commit ${commit}, host ${hostname()}, load ${load}, rounds ${rounds}`);
for (const [runtime, target] of Object.entries(targets)) await measure(runtime, target);
const apps = await listing();
const listed: number[] = [];
for (let i = 0; i < 10; i++) listed.push(await timed(`${admin}/api/apps`));
record('gateway', `list ${apps.length} apps`, listed);

console.log('\nruntime    metric         n   median ms   max ms');
for (const row of rows) console.log(`${row.runtime.padEnd(10)} ${row.metric.padEnd(14)} ${String(row.n).padStart(2)} ${fmt(row.median).padStart(10)} ${fmt(row.max).padStart(8)}`);
const out = flag('out', join(root, 'tests/bench/results', `${at.slice(0, 10)}-${commit}.tsv`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, ['at\tcommit\thost\tload1\truntime\tmetric\tn\tmedian_ms\tmax_ms',
  ...rows.map((row) => [at, commit, hostname(), load, row.runtime, row.metric, row.n, row.median.toFixed(1), row.max.toFixed(1)].join('\t'))].join('\n') + '\n');
console.log(`\nwritten ${out}`);
