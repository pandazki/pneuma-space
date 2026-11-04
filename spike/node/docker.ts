import http from 'node:http';
import assert from 'node:assert/strict';

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const LABEL = 'pneuma.spike=s3-node-relay';
const NAME = 'pneuma-spike-s3-node-relay';

type Reply = { status: number; body: Buffer };

function call(method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      socketPath: SOCKET, method, path,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function json<T>(method: string, path: string, ok: number[], body?: unknown): Promise<T> {
  const r = await call(method, path, body);
  if (!ok.includes(r.status)) throw new Error(`${method} ${path} -> ${r.status} ${r.body}`);
  return (r.body.length ? JSON.parse(r.body.toString()) : null) as T;
}

// Exec output on a non-TTY exec is multiplexed: 8-byte header [stream, 0, 0, 0, size u32 BE] per frame.
function demux(raw: Buffer): { stdout: string; stderr: string } {
  const out = { stdout: '', stderr: '' };
  for (let i = 0; i + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(i + 4);
    const text = raw.subarray(i + 8, i + 8 + size).toString();
    if (raw[i] === 2) out.stderr += text; else out.stdout += text;
    i += 8 + size;
  }
  return out;
}

const timed = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  const r = await f();
  console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`);
  return r;
};

const filters = (f: Record<string, string[]>) => encodeURIComponent(JSON.stringify(f));
let id = '';
const events: http.ClientRequest[] = [];
try {
  const version = await json<{ ApiVersion: string; Version: string }>('GET', '/version', [200]);
  console.log(`docker engine ${version.Version}, api ${version.ApiVersion}, unversioned paths`);

  const listed0 = await json<unknown[]>('GET', `/containers/json?all=1&filters=${filters({ label: [LABEL] })}`, [200]);
  console.log(`list by label before create: ${listed0.length} containers`);

  const created = await timed('create', () => json<{ Id: string }>('POST', `/containers/create?name=${NAME}`, [201], {
    Image: 'redis:7-alpine', Labels: { 'pneuma.spike': 's3-node-relay' },
  }));
  id = created.Id;
  const again = await call('POST', `/containers/create?name=${NAME}`, { Image: 'redis:7-alpine' });
  console.log(`create again with the same name: ${again.status} (treat as exists)`);

  const dieSeen = new Promise<{ action: string; id: string; exitCode: string; at: number }>((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path: `/events?filters=${filters({ type: ['container'], label: [LABEL], event: ['die'] })}` }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer) => {
        buf += c;
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const e = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          resolve({ action: e.Action, id: e.Actor.ID, exitCode: e.Actor.Attributes.exitCode, at: performance.now() });
        }
      });
    });
    req.on('error', (e) => { if (!req.destroyed) reject(e); });
    req.end();
    events.push(req);
  });

  await timed('start', () => json('POST', `/containers/${id}/start`, [204]));
  const startAgain = await call('POST', `/containers/${id}/start`);
  console.log(`start again: ${startAgain.status} (304 = already started)`);

  const inspect = await timed('inspect', () => json<{ State: { Running: boolean }; NetworkSettings: { IPAddress?: string; Networks: Record<string, { IPAddress: string }> } }>('GET', `/containers/${id}/json`, [200]));
  const ip = Object.values(inspect.NetworkSettings.Networks)[0].IPAddress;
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
  console.log(`inspect: running ${inspect.State.Running}, network IP ${ip}, top-level NetworkSettings.IPAddress ${JSON.stringify(inspect.NetworkSettings.IPAddress)}`);

  const listed1 = await json<{ Id: string; Labels: Record<string, string> }[]>('GET', `/containers/json?filters=${filters({ label: [LABEL] })}`, [200]);
  assert.equal(listed1.length, 1);
  assert.equal(listed1[0].Id, id);
  console.log(`list by label after start: 1 container, labels ${JSON.stringify(listed1[0].Labels)}`);

  const exec = await json<{ Id: string }>('POST', `/containers/${id}/exec`, [201], { Cmd: ['redis-cli', 'ping'], AttachStdout: true, AttachStderr: true });
  const execOut = await timed('exec start (attached)', () => call('POST', `/exec/${exec.Id}/start`, { Detach: false, Tty: false }));
  const execInfo = await json<{ ExitCode: number }>('GET', `/exec/${exec.Id}/json`, [200]);
  const out = demux(execOut.body);
  assert.equal(out.stdout.trim(), 'PONG');
  console.log(`exec redis-cli ping: status ${execOut.status}, stdout ${JSON.stringify(out.stdout)}, exit ${execInfo.ExitCode}`);

  const stopAt = performance.now();
  await timed('stop t=1', () => json('POST', `/containers/${id}/stop?t=1`, [204]));
  const die = await dieSeen;
  assert.equal(die.id, id);
  console.log(`events: ${die.action} for ${die.id.slice(0, 12)} exitCode ${die.exitCode}, ${(die.at - stopAt).toFixed(0)} ms after stop was sent`);
} finally {
  for (const r of events) r.destroy();
  const target = id || NAME;
  const removed = await call('DELETE', `/containers/${target}?force=1&v=1`);
  console.log(`remove: ${removed.status}`);
  const left = await json<unknown[]>('GET', `/containers/json?all=1&filters=${filters({ label: [LABEL] })}`, [200]);
  console.log(`list by label after remove: ${left.length} containers`);
}
