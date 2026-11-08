import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { Docker, DockerError, type ContainerSpec, type DockerEvent } from './docker.ts';
import type { Emit } from './events.ts';
import type { Instances } from './instances.ts';
import { Lifecycle, specHash, type Adopted, type Driver, type Gone, type Slot } from './lifecycle.ts';
import { APP_PORT, Conflict, RUNTIME_ENV, type AppId, type HealthCheck, type RunSpec } from './model.ts';
import type { AppGuard } from './runtimes.ts';

const LABEL = { app: 'pneuma-space.app', release: 'pneuma-space.release', spec: 'pneuma-space.spec', network: 'pneuma-space.network', role: 'pneuma-space.role' } as const;
const READY_POLL_MS = 50;
const STOP_SIGNALS: ReadonlySet<string> = new Set(['15', '9']);

type ContainerRun = RunSpec & { readonly runtime: Extract<RunSpec['runtime'], { kind: 'container' }> };

export type RuntimeOptions = {
  readonly docker: Docker;
  /** PNEUMA_SPACE_NETWORK: app containers join it, and only containers labelled with it are this gateway's. */
  readonly network: string;
  readonly specFor: (app: AppId) => RunSpec | null;
  readonly instances: Instances;
  readonly guard?: AppGuard;
  readonly log?: Emit;
};

/** A release names one image, so release and spec hash say whether a kept container still fits. */
const fits = (slot: Slot<string>, spec: ContainerRun): boolean => slot.release === spec.release && slot.specHash === specHash(spec);
export const fill = (env: Readonly<Record<string, string>>, dir: string) =>
  Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replaceAll('{dir}', dir)]));

export function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/** Handles are container ids; a stopped container is kept for the next start. */
class DockerDriver implements Driver<ContainerRun, string> {
  readonly kind = 'container';
  readonly handleKey = 'container';
  readonly #docker: Docker;
  readonly #network: string;
  /** Containers someone sent SIGTERM or SIGKILL; their die is a stop, not a crash. */
  readonly #signalled = new Set<string>();
  /** Epoch ms just before each container's last docker start; an older die event is a replay and is ignored. */
  readonly #startedAt = new Map<string, number>();
  #since = 0;

  constructor(docker: Docker, network: string) {
    this.#docker = docker;
    this.#network = network;
  }

  accepts(spec: RunSpec): spec is ContainerRun {
    return spec.runtime.kind === 'container';
  }

  async start(slot: Slot<string>, spec: ContainerRun): Promise<string> {
    const docker = this.#docker;
    try {
      if (slot.handle && !fits(slot, spec)) {
        await this.remove(spec.app, slot.handle);
        slot.handle = null;
      }
      slot.handle ??= await this.#create(spec);
      slot.release = spec.release;
      slot.specHash = specHash(spec);
      this.#startedAt.set(slot.handle, Date.now());
      if (!(await docker.start(slot.handle))) {
        // 404 also means the container outlived its network (compose down recreates it); a same-name create would return it again.
        await docker.remove(slot.handle);
        this.#startedAt.delete(slot.handle);
        slot.handle = await this.#create(spec);
        this.#startedAt.set(slot.handle, Date.now());
        await docker.start(slot.handle);
      }
      const container = slot.handle;
      const ip = (await docker.inspect(container))?.NetworkSettings.Networks[this.#network]?.IPAddress;
      if (!ip) throw new Error(`container of app ${spec.app} has no IP on network ${this.#network}`);
      const deadline = Date.now() + spec.policy.ready_timeout_seconds * 1000;
      // A container that exited frees its IP for the next one started, so the TCP poll alone can reach the wrong container.
      const stillRunning = async () => {
        const state = await docker.inspect(container);
        if (!state?.State.Running || state.NetworkSettings.Networks[this.#network]?.IPAddress !== ip) {
          throw new Error(`container of app ${spec.app} exited before it was ready`);
        }
      };
      let checkedAt = Date.now();
      while (!(await canConnect(ip, APP_PORT))) {
        if (Date.now() >= deadline) {
          throw new Error(`app ${spec.app} did not accept TCP on port ${APP_PORT} within ready_timeout_seconds=${spec.policy.ready_timeout_seconds}`);
        }
        if (Date.now() - checkedAt >= 1000) {
          await stillRunning();
          checkedAt = Date.now();
        }
        await sleep(READY_POLL_MS);
      }
      await stillRunning();
      return `${ip}:${APP_PORT}`;
    } catch (error) {
      if (slot.handle) await docker.stop(slot.handle).catch(() => {});
      throw error;
    }
  }

  async sleep(_app: AppId, slot: Slot<string>): Promise<void> {
    await this.#docker.stop(slot.handle!);
  }

  async remove(_app: AppId, container: string): Promise<void> {
    await this.#docker.stop(container);
    await this.#docker.remove(container);
    this.#startedAt.delete(container);
  }

  /** Docker is the gateway's own dependency: a failure here fails the start. */
  async discard(app: AppId, container: string): Promise<boolean> {
    await this.remove(app, container);
    return true;
  }

  async adopt(): Promise<readonly Adopted<string>[]> {
    this.#since ||= Math.floor(Date.now() / 1000);
    const found = await this.#docker.list({ label: [`${LABEL.role}=instance`, `${LABEL.network}=${this.#network}`] });
    return found.map((container) => {
      const ip = container.NetworkSettings.Networks[this.#network]?.IPAddress;
      return {
        app: container.Labels[LABEL.app] as AppId,
        handle: container.Id,
        release: container.Labels[LABEL.release],
        spec: container.Labels[LABEL.spec],
        address: container.State === 'running' && ip ? `${ip}:${APP_PORT}` : null,
      };
    });
  }

  follow(gone: Gone<string>, signal: AbortSignal): void {
    void (async () => {
      const filters = { event: ['kill', 'die', 'start'], label: [`${LABEL.network}=${this.#network}`] };
      for await (const event of this.#docker.events(filters, this.#since, signal)) {
        if (event.action === 'kill' && STOP_SIGNALS.has(event.labels.signal)) this.#signalled.add(event.id);
        else if (event.action === 'start') this.#signalled.delete(event.id);
        else if (event.action === 'die') this.#onDie(event, gone);
      }
    })();
  }

  #onDie(event: DockerEvent, gone: Gone<string>): void {
    const signalled = this.#signalled.delete(event.id);
    if (event.time < (this.#startedAt.get(event.id) ?? 0)) return;
    gone(event.labels[LABEL.app] as AppId, event.id, signalled ? { ev: 'stopped' } : { ev: 'crashed', reason: `container exited with code ${event.labels.exitCode}` });
  }

  async logs(_app: AppId, container: string | null, tail: number): Promise<string> {
    return container ? this.#docker.logs(container, tail) : '';
  }

  health(): readonly HealthCheck[] {
    return ['exit', 'ready'];
  }

  async destroyStorage(_app: AppId, id: string): Promise<void> {
    try {
      await this.#docker.removeVolume(id);
    } catch (error) {
      if (error instanceof DockerError && error.status === 409) throw new Conflict(`volume ${id} is still used by a container`);
      throw error;
    }
  }

  async #create(spec: ContainerRun): Promise<string> {
    const { storage } = spec.injection;
    for (const { id } of storage) await this.#docker.createVolume(id);
    const container: ContainerSpec = {
      image: spec.runtime.image,
      env: {
        ...spec.injection.env, ...Object.assign({}, ...storage.map((s) => fill(s.env, s.target))),
        [RUNTIME_ENV.app]: spec.name, [RUNTIME_ENV.release]: String(spec.release), [RUNTIME_ENV.port]: String(APP_PORT),
      },
      labels: {
        [LABEL.app]: spec.app, [LABEL.release]: String(spec.release), [LABEL.spec]: specHash(spec), [LABEL.network]: this.#network, [LABEL.role]: 'instance',
      },
      mounts: storage.map(({ id, target }) => ({ volume: id, target })),
      network: this.#network,
    };
    return this.#docker.create(`pneuma-space-${spec.app}-${spec.release}`, container);
  }
}

export class DockerRuntime extends Lifecycle<ContainerRun, string> {
  constructor(options: RuntimeOptions) {
    super(new DockerDriver(options.docker, options.network), options);
  }
}
