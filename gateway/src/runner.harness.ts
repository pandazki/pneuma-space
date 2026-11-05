import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { register } from 'node:module';
import v8 from 'node:v8';
import { MessageChannel, parentPort, Worker } from 'node:worker_threads';
const env = process.env;
if (env.START_FIFO) readFileSync(env.START_FIFO);
for (const end = Date.now() + Number(env.START_BUSY_MS ?? 0); Date.now() < end;);
if (env.START_BUFFERS) {
  globalThis.held = [0, 1, 2, 3].map(() => Buffer.alloc(64 * 2 ** 20, 1));
  await new Promise((r) => setTimeout(r, 60_000));
}
if (env.DECOY) createServer((q, s) => s.end('decoy')).listen(0);
const routes = {
  '/': () => env.PNEUMA_SPACE_APP + ' ' + env.PNEUMA_SPACE_RELEASE,
  '/hang': () => { for (;;) {} },
  // 1.5 s of CPU time, not wall time, so a stopped process does not shorten it.
  '/busy': () => {
    const cpu = () => { const { user, system } = process.threadCpuUsage(); return user + system; };
    for (const end = cpu() + 1.5e6; cpu() < end;);
    return 'busy';
  },
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
  '/register': () => {
    try { register('data:text/javascript,' + encodeURIComponent('process.kill(process.pid, "SIGKILL")')); return 'registered'; } catch (error) { return error.code; }
  },
  '/flags': () => {
    try { v8.setFlagsFromString('--allow-natives-syntax'); } catch (error) { return error.code; }
    return new Function('%AbortJS("flags")')();
  },
  '/parent': () => String(parentPort),
  // Every function on the chain, Object.prototype's too, notes a MessagePort it is called on that is not the app's own.
  '/patched': async () => {
    const own = new MessageChannel();
    let handed = false;
    const restore = [];
    for (let proto = Object.getPrototypeOf(own.port1); proto; proto = Object.getPrototypeOf(proto)) {
      for (const key of Reflect.ownKeys(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, key);
        if (key === 'constructor' || key === '__proto__' || typeof d.value !== 'function' || !d.configurable) continue;
        Object.defineProperty(proto, key, { ...d, value: function (...args) {
          if (this?.constructor?.name === 'MessagePort' && this !== own.port1 && this !== own.port2) handed = true;
          return d.value.apply(this, args);
        } });
        restore.push(() => Object.defineProperty(proto, key, d));
      }
    }
    console.log('patched');
    await new Promise((r) => setTimeout(r, 1500));
    for (const undo of restore) undo();
    own.port1.close();
    return String(handed);
  },
  '/stdio': () => JSON.stringify([process.stdin, process.stdout, process.stderr, console._stdout, console._stderr].flatMap((s) => Object.getOwnPropertySymbols(s).map(String)).filter((k) => k === 'Symbol(kPort)')),
  '/partial': () => { process.stdout.write('par'); process.stdout.write('tial\\n'); return 'written'; },
  '/chatter': () => { for (const end = Date.now() + 1500; Date.now() < end;) console.log('chatter'); return 'printed'; },
  '/forge': () => { globalThis.reached.shim.postMessage({ type: 'log', lines: 1 }); return 'posted'; },
  '/bogus': () => { globalThis.reached.stdio.postMessage({ type: 'bogus' }); return 'posted'; },
  '/blank': () => { for (let i = 0; i < 1e5; i++) console.log(''); return 'printed'; },
  '/burst': () => { process.stdout.write(Buffer.alloc(64 * 2 ** 20, 10)); return 'written'; },
  '/exit': () => process.exit(3),
  '/files': () => { writeFileSync(env.PNEUMA_SPACE_FILES_DIR + '/kept', 'kept'); return env.PNEUMA_SPACE_FILES_DIR; },
};
console.log('fixture ready');
createServer(async (q, s) => s.end(String(await routes[q.url]()))).listen(Number(env.PNEUMA_SPACE_PORT), '0.0.0.0');
process.on('SIGTERM', () => process.exit(0));
`;

/** Runs in each worker before the shim: what an app would hold had it reached the shim's port and Node's stdio port anyway. */
export const REACHED = `import { parentPort } from 'node:worker_threads';
const kPort = Object.getOwnPropertySymbols(process.stdout).find((key) => key.description === 'kPort');
globalThis.reached = { shim: parentPort, stdio: process.stdout[kPort] };
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
export type RunnerProcess = { readonly url: string; readonly data: string; readonly pid: number; readonly exited: Promise<string | number | null>; stop(): Promise<void> };

/** The runner as compose runs it, with the permission flags, on an ephemeral port and a scratch /data; `preamble` runs in each worker before the shim. */
export async function startRunner(t: TestContext, env: Record<string, string> = {}, data = tempDir(t, 'pneuma-space-runner-'), preamble?: string): Promise<RunnerProcess> {
  let src = SRC;
  if (preamble !== undefined) {
    src = tempDir(t, 'pneuma-space-src-');
    cpSync(SRC, src, { recursive: true });
    renameSync(join(src, 'isolate-shim.ts'), join(src, 'isolate-shim.next.ts'));
    writeFileSync(join(src, 'isolate-shim.ts'), `${preamble}await import('./isolate-shim.next.ts');\n`);
  }
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning', '--disable-warning=SecurityWarning',
    '--permission', `--allow-fs-read=${data}`, `--allow-fs-read=${src}`, `--allow-fs-write=${data}`, '--allow-worker', ...NET, join(src, 'runner.ts'),
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
      return { url: `http://127.0.0.1:${event.port}`, data, pid: child.pid!, exited, stop };
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
