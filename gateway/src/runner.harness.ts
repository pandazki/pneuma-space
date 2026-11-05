import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';

const SRC = import.meta.dirname;
// Node 25 also gates the network behind the permission model; the image's Node 24 has no such flag.
const NET = process.allowedNodeEnvironmentFlags.has('--allow-net') ? ['--allow-net'] : [];

/** Every route the runner and IsolateRuntime tests drive; plain JS so a worker starts without type stripping. */
export const APP = `import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
const env = process.env;
if (env.START_FIFO) readFileSync(env.START_FIFO);
for (const end = Date.now() + Number(env.START_BUSY_MS ?? 0); Date.now() < end;);
const routes = {
  '/': () => env.PNEUMA_SPACE_APP + ' ' + env.PNEUMA_SPACE_RELEASE,
  '/hang': () => { for (;;) {} },
  '/heap': () => { const a = []; for (;;) a.push(new Array(1e5).fill(Math.random())); },
  '/buffers': () => { globalThis.held = [0, 1, 2, 3].map(() => Buffer.alloc(64 * 2 ** 20, 1)); return 'held'; },
  '/fifo': () => readFileSync(env.FIFO),
  '/escape': () => {
    let child = 'allowed';
    try { process.getBuiltinModule('node:child_process').execFileSync('true'); } catch (error) { child = error.code; }
    return JSON.stringify({ kill: typeof process.kill, abort: typeof process.abort, child });
  },
  '/worker': () => {
    const attempt = (W) => { try { new W('process.kill(process.pid, "SIGKILL")', { eval: true }); return 'started'; } catch (error) { return error.code; } };
    return JSON.stringify({ imported: attempt(Worker), builtin: attempt(process.getBuiltinModule('node:worker_threads').Worker) });
  },
  '/exit': () => process.exit(3),
  '/files': () => { writeFileSync(env.PNEUMA_SPACE_FILES_DIR + '/kept', 'kept'); return env.PNEUMA_SPACE_FILES_DIR; },
};
console.log('fixture ready');
createServer((q, s) => s.end(String(routes[q.url]()))).listen(Number(env.PNEUMA_SPACE_PORT), '0.0.0.0');
process.on('SIGTERM', () => process.exit(0));
`;

export const tempDir = (t: TestContext, prefix: string): string => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Serves a ustar of `files` the way the object store serves a presigned GET. */
export async function serveBundle(t: TestContext, files: Record<string, string> = { 'app.mjs': APP }): Promise<string> {
  const dir = tempDir(t, 'pneuma-space-bundle-');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const tar = execFileSync('tar', ['--format', 'ustar', '-cf', '-', '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const server = createServer((_q, s) => s.end(tar)).listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/bundle.tar`;
}

/** `exited` resolves with the signal that ended the runner, or its exit code. */
export type RunnerProcess = { readonly url: string; readonly data: string; readonly exited: Promise<string | number | null>; stop(): Promise<void> };

/** The runner as compose runs it, with the permission flags, on an ephemeral port and a scratch /data. */
export async function startRunner(t: TestContext, env: Record<string, string> = {}, data = tempDir(t, 'pneuma-space-runner-')): Promise<RunnerProcess> {
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning', '--disable-warning=SecurityWarning',
    '--permission', `--allow-fs-read=${data}`, `--allow-fs-read=${SRC}`, `--allow-fs-write=${data}`, '--allow-worker', ...NET, join(SRC, 'runner.ts'),
  ], { env: { ...process.env, PNEUMA_SPACE_DATA: data, PNEUMA_SPACE_RUNNER_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<string | number | null>((ok) => child.once('exit', (code, signal) => ok(signal ?? code)));
  const stop = async () => {
    child.kill('SIGKILL');
    await exited;
  };
  t.after(stop);
  for await (const line of createInterface({ input: child.stdout! })) {
    const event = JSON.parse(line);
    if (event.ev === 'runner-ready') {
      child.stdout!.resume();
      return { url: `http://127.0.0.1:${event.port}`, data, exited, stop };
    }
  }
  throw new Error('runner exited before it was ready');
}

/** Probes `url` every 50 ms until stopped; resolves with the number of failed probes. */
export function witness(url: string): () => Promise<number> {
  let failures = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const ok = await fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
      if (!ok) failures++;
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  return async () => {
    running = false;
    await loop;
    return failures;
  };
}
