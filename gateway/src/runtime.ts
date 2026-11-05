import { connect } from 'node:net';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Docker, DockerError, type ContainerSpec, type DockerEvent } from './docker.ts';
import { emit, type Emit } from './events.ts';
import {
  APP_PORT, canonicalHash, Conflict, NotFound, RUNTIME_ENV,
  type AppId, type ImageId, type InstanceState, type Job, type JobResult, type Lease, type LeaseKind, type Runtime, type RunSpec,
} from './model.ts';

const LABEL = { app: 'pneuma-space.app', release: 'pneuma-space.release', spec: 'pneuma-space.spec', network: 'pneuma-space.network' } as const;
const MAX_TICK_SECONDS = 10;
const READY_POLL_MS = 50;

type Instance = {
  readonly app: AppId;
  state: InstanceState;
  /** The spec the container was created from, or the latest one while asleep without a container. */
  spec: RunSpec;
  container: string | null;
  address: string;
  readonly leases: Map<Lease, LeaseRecord>;
  lastReleaseAt: number;
  since: number;
  /** Epoch ms just before the last docker start; an older die event is a replay and is ignored. */
  startedAt: number;
  wake: Promise<void>;
  changed: PromiseWithResolvers<void>;
};

/** `onRetire` is set only for a channel. */
type LeaseRecord = { readonly kind: LeaseKind; readonly onRetire: (() => void) | null };

export type RuntimeOptions = {
  readonly docker: Docker;
  /** PNEUMA_SPACE_NETWORK: app containers join it, and only containers labelled with it are this gateway's. */
  readonly network: string;
  /** The Registry's runSpec; re-read on every wake and reaper tick so policy changes apply without a publish. */
  readonly specFor: (app: AppId) => RunSpec | null;
  /** Compose project whose service containers run jobs; see composeProject. */
  readonly project: string;
  readonly log?: Emit;
};

const specHash = (spec: RunSpec): string => canonicalHash(spec.injection);
const sameRun = (a: RunSpec, b: RunSpec): boolean => a.release === b.release && a.image === b.image && specHash(a) === specHash(b);

/** PNEUMA_SPACE_COMPOSE_PROJECT, else the compose project label of the container this process runs in, else `pneuma-space`. */
export async function composeProject(docker: Docker): Promise<string> {
  return process.env.PNEUMA_SPACE_COMPOSE_PROJECT
    ?? (await docker.inspect(hostname()))?.Config.Labels['com.docker.compose.project']
    ?? 'pneuma-space';
}

export function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

// JavaScript runs each synchronous stretch to completion, so the code between two awaits is the per-instance lock;
// `changed` is its condition variable.
export class DockerRuntime implements Runtime {
  private readonly docker: Docker;
  private readonly network: string;
  private readonly specFor: (app: AppId) => RunSpec | null;
  private readonly project: string;
  private readonly log: Emit;
  private readonly instances = new Map<AppId, Instance>();
  private readonly awake = new Set<Instance>();
  private readonly events = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private due = 0;
  private following = false;

  constructor(options: RuntimeOptions) {
    this.docker = options.docker;
    this.network = options.network;
    this.specFor = options.specFor;
    this.project = options.project;
    this.log = options.log ?? emit;
  }

  async acquire(app: AppId, kind: 'request' | 'trigger'): Promise<Lease> {
    for (;;) {
      const spec = this.specFor(app);
      if (!spec) throw new NotFound(`app ${app} has no registered release with an image`);
      let inst = this.instances.get(app);
      if (!inst) {
        inst = { app, state: 'asleep', spec, container: null, address: '', leases: new Map(), lastReleaseAt: 0, since: Date.now(), startedAt: 0, wake: Promise.resolve(), changed: Promise.withResolvers() };
        this.instances.set(app, inst);
      }
      switch (inst.state) {
        case 'awake': {
          const lease: Lease = { app, address: inst.address };
          inst.leases.set(lease, { kind, onRetire: null });
          return lease;
        }
        case 'asleep':
          this.transition(inst, 'waking');
          inst.wake = this.wake(inst, spec);
          await inst.wake;
          break;
        case 'waking':
          await inst.wake;
          break;
        default:
          await inst.changed.promise;
      }
    }
  }

  release(lease: Lease): void {
    const inst = this.instances.get(lease.app);
    if (!inst?.leases.delete(lease)) return;
    if (inst.leases.size === 0) {
      inst.lastReleaseAt = Date.now();
      this.notify(inst);
    }
  }

  channel(lease: Lease, onRetire: () => void): void {
    const inst = this.instances.get(lease.app);
    if (!inst?.leases.has(lease)) return;
    inst.leases.set(lease, { kind: 'channel', onRetire });
    if (inst.state === 'draining') onRetire();
  }

  async retire(app: AppId): Promise<void> {
    for (;;) {
      const inst = this.instances.get(app);
      if (!inst) return;
      switch (inst.state) {
        case 'awake':
          return this.drain(inst);
        case 'asleep':
          this.transition(inst, 'stopping');
          return this.remove(inst);
        case 'waking':
          await inst.wake.catch(() => {});
          break;
        default:
          await inst.changed.promise;
      }
    }
  }

  async reconcile(): Promise<void> {
    const since = Math.floor(Date.now() / 1000);
    const found = await this.docker.list({ label: [LABEL.app, `${LABEL.network}=${this.network}`] });
    for (const container of found) {
      const app = container.Labels[LABEL.app] as AppId;
      if (this.instances.get(app)?.container === container.Id) continue;
      const spec = this.specFor(app);
      const current = spec !== null && !this.instances.has(app)
        && container.Labels[LABEL.release] === String(spec.release) && container.Labels[LABEL.spec] === specHash(spec);
      if (!current) {
        await this.docker.stop(container.Id);
        await this.docker.remove(container.Id);
        this.emit('removed', app, { container: container.Id });
        continue;
      }
      const ip = container.NetworkSettings.Networks[this.network]?.IPAddress;
      const running = container.State === 'running' && Boolean(ip);
      const inst: Instance = {
        app, state: 'asleep', spec, container: container.Id, address: running ? `${ip}:${APP_PORT}` : '',
        leases: new Map(), lastReleaseAt: Date.now(), since: Date.now(), startedAt: 0, wake: Promise.resolve(), changed: Promise.withResolvers(),
      };
      this.instances.set(app, inst);
      this.transition(inst, running ? 'awake' : 'asleep', { adopted: true });
    }
    if (!this.following) {
      this.following = true;
      void this.follow(since);
    }
  }

  state(app: AppId): InstanceState | 'none' {
    return this.instances.get(app)?.state ?? 'none';
  }

  since(app: AppId): number | null {
    return this.instances.get(app)?.since ?? null;
  }

  leases(app: AppId): Record<LeaseKind, number> {
    const counts = { request: 0, channel: 0, trigger: 0 };
    for (const { kind } of this.instances.get(app)?.leases.values() ?? []) counts[kind]++;
    return counts;
  }

  sleepsAt(app: AppId): number | null {
    const inst = this.instances.get(app);
    if (inst?.state !== 'awake' || inst.leases.size > 0) return null;
    return inst.lastReleaseAt + (this.specFor(app) ?? inst.spec).policy.idle_seconds * 1000;
  }

  async logs(app: AppId, tail: number): Promise<string> {
    const container = this.instances.get(app)?.container;
    return container ? this.docker.logs(container, tail) : '';
  }

  async runJob(job: Job): Promise<JobResult> {
    const [container] = await this.docker.list({
      label: [`com.docker.compose.project=${this.project}`, `com.docker.compose.service=${job.service}`], status: ['running'],
    });
    if (!container) {
      throw new Conflict(`service ${job.service} of compose project ${this.project} is not running; start it with docker compose (it may sit behind a profile)`);
    }
    return this.docker.exec(container.Id, job.argv, job.stdin);
  }

  resolveImage(reference: string): Promise<ImageId | null> {
    return this.docker.imageId(reference);
  }

  ensureVolume(name: string): Promise<void> {
    return this.docker.createVolume(name);
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.removeVolume(name);
    } catch (error) {
      if (error instanceof DockerError && error.status === 409) throw new Conflict(`volume ${name} is still used by a container`);
      throw error;
    }
  }

  /** Stops the reaper and the event subscription; containers keep running for the next reconcile to adopt. */
  close(): void {
    this.events.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async wake(inst: Instance, spec: RunSpec): Promise<void> {
    const started = performance.now();
    try {
      if (inst.container && !sameRun(inst.spec, spec)) {
        await this.docker.stop(inst.container);
        await this.docker.remove(inst.container);
        inst.container = null;
      }
      inst.spec = spec;
      inst.container ??= await this.create(spec);
      inst.startedAt = Date.now();
      if (!(await this.docker.start(inst.container))) {
        // 404 also means the container outlived its network (compose down recreates it); a same-name create would return it again.
        await this.docker.remove(inst.container);
        inst.container = await this.create(spec);
        await this.docker.start(inst.container);
      }
      const ip = (await this.docker.inspect(inst.container))?.NetworkSettings.Networks[this.network]?.IPAddress;
      if (!ip) throw new Error(`container of app ${spec.app} has no IP on network ${this.network}`);
      inst.address = `${ip}:${APP_PORT}`;
      const deadline = Date.now() + spec.policy.ready_timeout_seconds * 1000;
      // A container that exited frees its IP for the next one started, so the TCP poll alone can reach the wrong container.
      const stillRunning = async () => {
        const state = await this.docker.inspect(inst.container!);
        if (!state?.State.Running || state.NetworkSettings.Networks[this.network]?.IPAddress !== ip) {
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
      inst.lastReleaseAt = Date.now();
      this.transition(inst, 'awake', { ms: Math.round(performance.now() - started) });
    } catch (error) {
      if (inst.container) await this.docker.stop(inst.container).catch(() => {});
      this.transition(inst, 'asleep', { error: String(error) });
      throw error;
    }
  }

  private create(spec: RunSpec): Promise<string> {
    const container: ContainerSpec = {
      image: spec.image,
      env: { ...spec.injection.env, [RUNTIME_ENV.app]: spec.name, [RUNTIME_ENV.release]: String(spec.release) },
      labels: {
        [LABEL.app]: spec.app, [LABEL.release]: String(spec.release), [LABEL.spec]: specHash(spec), [LABEL.network]: this.network,
      },
      mounts: spec.injection.mounts,
      network: this.network,
    };
    return this.docker.create(`pneuma-space-${spec.app}-${spec.release}`, container);
  }

  private async drain(inst: Instance): Promise<void> {
    this.transition(inst, 'draining');
    for (const { onRetire } of inst.leases.values()) {
      try {
        onRetire?.();
      } catch (error) {
        this.emit('retire-error', inst.app, { error: String(error) });
      }
    }
    const seconds = (this.specFor(inst.app) ?? inst.spec).policy.drain_timeout_seconds;
    const timer = new AbortController();
    const timeout = sleep(seconds * 1000, undefined, { signal: timer.signal }).then(() => true, () => true);
    let expired = false;
    while (inst.leases.size > 0 && !expired) expired = await Promise.race([timeout, inst.changed.promise.then(() => false)]);
    timer.abort();
    this.transition(inst, 'stopping', { leases: inst.leases.size });
    await this.remove(inst);
  }

  private async remove(inst: Instance): Promise<void> {
    try {
      if (inst.container) {
        await this.docker.stop(inst.container);
        await this.docker.remove(inst.container);
      }
    } catch (error) {
      this.transition(inst, 'asleep', { error: String(error) });
      throw error;
    }
    this.instances.delete(inst.app);
    this.awake.delete(inst);
    this.notify(inst);
    this.emit('removed', inst.app, { container: inst.container });
  }

  private async sleepInstance(inst: Instance): Promise<void> {
    this.transition(inst, 'stopping');
    try {
      await this.docker.stop(inst.container!);
      this.transition(inst, 'asleep');
    } catch (error) {
      inst.lastReleaseAt = Date.now();
      this.transition(inst, 'awake', { error: String(error) });
    }
  }

  private readonly tick = (): void => {
    this.timer = null;
    const now = Date.now();
    let next = MAX_TICK_SECONDS;
    for (const inst of this.awake) {
      const idle = (this.specFor(inst.app) ?? inst.spec).policy.idle_seconds;
      next = Math.min(next, idle);
      if (inst.leases.size === 0 && now - inst.lastReleaseAt >= idle * 1000) void this.sleepInstance(inst);
    }
    if (this.awake.size > 0) this.arm(next);
  };

  private arm(seconds: number): void {
    if (this.events.signal.aborted) return;
    const due = Date.now() + seconds * 1000;
    if (this.timer && this.due <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(this.tick, seconds * 1000);
    this.timer.unref();
  }

  private async follow(since: number): Promise<void> {
    const filters = { event: ['die'], label: [`${LABEL.network}=${this.network}`] };
    for await (const event of this.docker.events(filters, since, this.events.signal)) this.onDie(event);
  }

  private onDie(event: DockerEvent): void {
    const inst = this.instances.get(event.labels[LABEL.app] as AppId);
    if (inst?.state !== 'awake' || inst.container !== event.id || event.time < inst.startedAt) return;
    inst.address = '';
    this.transition(inst, 'asleep', { external: true });
  }

  private transition(inst: Instance, state: InstanceState, extra: Record<string, unknown> = {}): void {
    inst.state = state;
    inst.since = Date.now();
    if (state === 'awake') {
      this.awake.add(inst);
      this.arm(Math.min(MAX_TICK_SECONDS, (this.specFor(inst.app) ?? inst.spec).policy.idle_seconds));
    } else {
      this.awake.delete(inst);
    }
    this.notify(inst);
    this.emit(state, inst.app, extra);
  }

  private notify(inst: Instance): void {
    const { resolve } = inst.changed;
    inst.changed = Promise.withResolvers();
    resolve();
  }

  private emit(ev: string, app: AppId, extra: Record<string, unknown>): void {
    this.log(ev, app, extra);
  }
}
