// Docker Engine API 1.52 over the unix socket (spike/node/findings.md). The only module that talks to Docker.
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ImageId, JobResult, Mount } from './model.ts';

export class DockerError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`docker ${method} ${path} answered ${status}: ${body.trim()}`);
    this.status = status;
  }
}

export type Labels = Readonly<Record<string, string>>;
export type Filters = Readonly<Record<string, readonly string[]>>;
type Networks = Readonly<Record<string, { readonly IPAddress: string }>>;

export type ContainerSummary = {
  readonly Id: string;
  readonly State: string;
  readonly Labels: Labels;
  readonly NetworkSettings: { readonly Networks: Networks };
};
export type ContainerInfo = {
  readonly Id: string;
  readonly State: { readonly Running: boolean };
  readonly Config: { readonly Labels: Labels };
  readonly NetworkSettings: { readonly Networks: Networks };
};
export type ContainerSpec = {
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Labels;
  readonly mounts: readonly Mount[];
  readonly network: string;
};
export type DockerEvent = { readonly action: string; readonly id: string; readonly labels: Labels; readonly time: number };

type Reply = { readonly status: number; readonly body: Buffer };

const query = (filters: Filters) => encodeURIComponent(JSON.stringify(filters));

/** Non-TTY attached streams are framed: [stream, 0, 0, 0, size u32 BE] then size bytes; stream 2 is stderr. */
export function demux(raw: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  for (let i = 0; i + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(i + 4);
    (raw[i] === 2 ? err : out).push(raw.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

export class Docker {
  readonly socketPath: string;

  constructor(socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock') {
    this.socketPath = socketPath;
  }

  request(method: string, path: string, body?: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
      const req = http.request({ socketPath: this.socketPath, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  private async expect<T>(method: string, path: string, ok: readonly number[], body?: unknown): Promise<{ status: number; json: T }> {
    const reply = await this.request(method, path, body);
    if (!ok.includes(reply.status)) throw new DockerError(method, path, reply.status, reply.body.toString());
    return { status: reply.status, json: (reply.body.length ? JSON.parse(reply.body.toString()) : null) as T };
  }

  async list(filters: Filters): Promise<ContainerSummary[]> {
    return (await this.expect<ContainerSummary[]>('GET', `/containers/json?all=1&filters=${query(filters)}`, [200])).json;
  }

  async inspect(idOrName: string): Promise<ContainerInfo | null> {
    const { status, json } = await this.expect<ContainerInfo>('GET', `/containers/${idOrName}/json`, [200, 404]);
    return status === 404 ? null : json;
  }

  /** Returns the container id; an existing container of that name counts as created. */
  async create(name: string, spec: ContainerSpec): Promise<string> {
    const { status, json } = await this.expect<{ Id: string }>('POST', `/containers/create?name=${name}`, [201, 409], {
      Image: spec.image,
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      Labels: spec.labels,
      HostConfig: {
        NetworkMode: spec.network,
        Mounts: spec.mounts.map((mount) => ({ Type: 'volume', Source: mount.volume, Target: mount.target })),
      },
    });
    if (status === 201) return json.Id;
    const existing = await this.inspect(name);
    if (!existing) throw new DockerError('POST', `/containers/create?name=${name}`, 409, 'name taken by a container that is now gone');
    return existing.Id;
  }

  /** False when the container no longer exists; already running counts as started. */
  async start(id: string): Promise<boolean> {
    return (await this.expect('POST', `/containers/${id}/start`, [204, 304, 404])).status !== 404;
  }

  async stop(id: string): Promise<void> {
    await this.expect('POST', `/containers/${id}/stop`, [204, 304, 404]);
  }

  async remove(id: string): Promise<void> {
    await this.expect('DELETE', `/containers/${id}?force=1&v=1`, [204, 404]);
  }

  async imageId(reference: string): Promise<ImageId | null> {
    const { status, json } = await this.expect<{ Id: ImageId }>('GET', `/images/${encodeURIComponent(reference)}/json`, [200, 404]);
    return status === 404 ? null : json.Id;
  }

  async createVolume(name: string): Promise<void> {
    await this.expect('POST', '/volumes/create', [201], { Name: name });
  }

  /** Throws DockerError 409 when a container still uses the volume. */
  async removeVolume(name: string): Promise<void> {
    await this.expect('DELETE', `/volumes/${name}`, [204, 404]);
  }

  async exec(id: string, argv: readonly string[], stdin = ''): Promise<JobResult> {
    const created = await this.expect<{ Id: string }>('POST', `/containers/${id}/exec`, [201], {
      Cmd: argv, AttachStdin: true, AttachStdout: true, AttachStderr: true,
    });
    const path = `/exec/${created.json.Id}/start`;
    // The upgraded socket lets us half-close after stdin, which is how the exec sees end of input.
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const payload = JSON.stringify({ Detach: false, Tty: false });
      const req = http.request({
        socketPath: this.socketPath, method: 'POST', path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), connection: 'Upgrade', upgrade: 'tcp' },
      });
      req.on('upgrade', (_res, socket, head) => {
        const chunks: Buffer[] = [head];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks)));
        socket.on('error', reject);
        socket.end(stdin);
      });
      req.on('response', (res) => {
        res.resume();
        reject(new DockerError('POST', path, res.statusCode ?? 0, 'exec start did not upgrade'));
      });
      req.on('error', reject);
      req.end(payload);
    });
    const info = await this.expect<{ ExitCode: number }>('GET', `/exec/${created.json.Id}/json`, [200]);
    return { exitCode: info.json.ExitCode, ...demux(raw) };
  }

  /** Container events from `since` (epoch seconds) on; reconnects after a lost stream and replays from the last event seen. */
  async *events(filters: Filters, since: number, signal: AbortSignal): AsyncGenerator<DockerEvent> {
    let from = since;
    while (!signal.aborted) {
      try {
        const res = await this.open(`/events?since=${from}&filters=${query({ ...filters, type: ['container'] })}`, signal);
        let buffer = '';
        for await (const chunk of res) {
          buffer += chunk;
          for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
            const event = JSON.parse(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
            from = event.time;
            yield { action: event.Action, id: event.Actor.ID, labels: event.Actor.Attributes ?? {}, time: event.time };
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await sleep(1000, undefined, { signal }).catch(() => {});
    }
  }

  private open(path: string, signal: AbortSignal): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path, signal }, (res) => {
        if (res.statusCode === 200) return resolve(res.setEncoding('utf8'));
        res.resume();
        reject(new DockerError('GET', path, res.statusCode ?? 0, 'event stream refused'));
      });
      req.on('error', reject);
      req.end();
    });
  }
}
