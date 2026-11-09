// The container driver of the kubernetes plane (ADR 0019 items 4, 5, 7): one Pod per awake instance, one PVC per StorageBinding.
import { setTimeout as sleep } from 'node:timers/promises';
import { emit, type Emit } from './events.ts';
import type { Instances } from './instances.ts';
import { KubeError, type KubeClient, type Pod, type WatchEvent } from './kube.ts';
import { Lifecycle, specHash, type Adopted, type Driver, type Gone, type Slot } from './lifecycle.ts';
import {
  APP_PORT, Conflict, DEFAULT_POLICY, RUNTIME_ENV,
  type AppId, type HealthCheck, type Policy, type ReleaseNumber, type RunSpec, type StoreOps,
} from './model.ts';
import { canConnect, fill } from './runtime.ts';
import { Unavailable, type AppGuard } from './runtimes.ts';

const LABEL = {
  app: 'pneuma-space.app', release: 'pneuma-space.release', epoch: 'pneuma-space.epoch', tenant: 'pneuma-space.tenant',
  role: 'pneuma-space.role', reach: 'pneuma-space.reach.', spec: 'pneuma-space.spec', partOf: 'app.kubernetes.io/part-of',
} as const;
const INSTANCES = `${LABEL.role}=instance`;
const CONTAINER = 'app';
const OUT_OF_SERVICE = 'node.kubernetes.io/out-of-service';
const LOG_LINES = 200;
const LOG_BYTES = 64 * 1024;
const READY_POLL_MS = 50;
const PURGE_MS = 30_000;
/** How long the Pod watch must keep failing before awake instances are marked asleep as unavailable, as for the isolate runner. */
const UNREACHABLE_MS = 15_000;
const RETRY_MS = 1000;
const DELETED_KEPT = 1000;

type ContainerRun = RunSpec & { readonly runtime: Extract<RunSpec['runtime'], { kind: 'container' }> };
type LogStore = Pick<StoreOps, 'instanceLog' | 'putInstanceLog'>;

/** The deployment's Pod settings, from `PNEUMA_SPACE_K8S_*` and `PNEUMA_SPACE_CPU_REQUEST_MILLIS`. */
export type PodConfig = {
  readonly cpuRequestMillis: number;
  readonly pullSecrets: readonly string[];
  readonly nodeSelector: Readonly<Record<string, string>>;
  readonly fsGroup: number;
  readonly restricted: boolean;
  readonly pendingSeconds: number;
  /** Null: the cluster's default class. */
  readonly storageClass: string | null;
  readonly volumeSize: string;
};

const count = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key]?.trim() || String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole number, got "${raw}"`);
  return Number(raw);
};
const list = (raw: string | undefined): string[] => (raw ?? '').split(',').map((part) => part.trim()).filter(Boolean);

export function podConfig(env: NodeJS.ProcessEnv): PodConfig {
  const restricted = env.PNEUMA_SPACE_K8S_RESTRICTED?.trim() ?? '';
  if (restricted !== '' && restricted !== '1') throw new Error(`PNEUMA_SPACE_K8S_RESTRICTED must be empty or 1, got "${restricted}"`);
  const nodeSelector = list(env.PNEUMA_SPACE_K8S_NODE_SELECTOR).map((pair) => {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`PNEUMA_SPACE_K8S_NODE_SELECTOR must be k=v,k=v, got "${pair}"`);
    return [pair.slice(0, at), pair.slice(at + 1)] as const;
  });
  return {
    cpuRequestMillis: count(env, 'PNEUMA_SPACE_CPU_REQUEST_MILLIS', 100),
    pullSecrets: list(env.PNEUMA_SPACE_K8S_PULL_SECRETS),
    nodeSelector: Object.fromEntries(nodeSelector),
    fsGroup: count(env, 'PNEUMA_SPACE_K8S_FS_GROUP', 2000),
    restricted: restricted === '1',
    pendingSeconds: count(env, 'PNEUMA_SPACE_K8S_PENDING_SECONDS', 60),
    storageClass: env.PNEUMA_SPACE_K8S_STORAGE_CLASS?.trim() || null,
    volumeSize: env.PNEUMA_SPACE_K8S_VOLUME_SIZE?.trim() || '1Gi',
  };
}

export type Plane = 'docker' | 'kubernetes';

/** `local` identity leaves the admin API unauthenticated behind loopback, and a Service has no loopback (ADR 0019 后果). */
export function planeOf(env: NodeJS.ProcessEnv): Plane {
  const plane = env.PNEUMA_SPACE_PLANE?.trim() || 'docker';
  if (plane !== 'docker' && plane !== 'kubernetes') throw new Error(`PNEUMA_SPACE_PLANE must be docker or kubernetes, got "${plane}"`);
  if (plane === 'kubernetes' && (env.PNEUMA_SPACE_IDENTITY?.trim() || 'local') === 'local') {
    throw new Error('PNEUMA_SPACE_PLANE=kubernetes refuses PNEUMA_SPACE_IDENTITY=local: set PNEUMA_SPACE_IDENTITY=upstream');
  }
  return plane;
}

export const podName = (app: AppId): string => `pneuma-space-${app}`;

/** The whole Pod of one wake, a pure function of the RunSpec, the row's epoch and the deployment's settings (ADR 0019 item 4, ADR 0023 item 1). */
export function podFor(spec: ContainerRun, epoch: number, config: PodConfig): Pod {
  const { storage, services } = spec.injection;
  const env: Record<string, string> = {
    ...spec.injection.env, ...Object.assign({}, ...storage.map((s) => fill(s.env, s.target))),
    [RUNTIME_ENV.app]: spec.name, [RUNTIME_ENV.release]: String(spec.release), [RUNTIME_ENV.port]: String(APP_PORT),
  };
  const memory = `${spec.policy.memory_mb}Mi`;
  return {
    metadata: {
      name: podName(spec.app),
      labels: {
        [LABEL.partOf]: 'pneuma-space', [LABEL.app]: spec.app, [LABEL.role]: 'instance', [LABEL.release]: String(spec.release),
        [LABEL.epoch]: String(epoch), [LABEL.tenant]: spec.tenant, ...Object.fromEntries(services.map((s) => [LABEL.reach + s, '1'])),
      },
      annotations: { [LABEL.spec]: specHash(spec) },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      serviceAccountName: 'pneuma-space-app',
      terminationGracePeriodSeconds: 10,
      imagePullSecrets: config.pullSecrets.map((name) => ({ name })),
      nodeSelector: config.nodeSelector,
      securityContext: { seccompProfile: { type: 'RuntimeDefault' }, fsGroup: config.fsGroup, ...(config.restricted ? { runAsNonRoot: true } : {}) },
      containers: [{
        name: CONTAINER,
        image: spec.runtime.image,
        imagePullPolicy: 'IfNotPresent',
        ports: [{ containerPort: APP_PORT }],
        env: Object.entries(env).map(([name, value]) => ({ name, value })),
        resources: {
          limits: { cpu: `${spec.policy.cpu_millis}m`, memory },
          // Kubernetes rejects a request above its limit.
          requests: { cpu: `${Math.min(config.cpuRequestMillis, spec.policy.cpu_millis)}m`, memory },
        },
        volumeMounts: storage.map(({ id, target }) => ({ name: id, mountPath: target })),
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [config.restricted ? 'ALL' : 'NET_RAW'] } },
      }],
      volumes: storage.map(({ id }) => ({ name: id, persistentVolumeClaim: { claimName: id } })),
    },
  };
}

const uidOf = (pod: Pod): string => pod.metadata.uid!;
const appOf = (pod: Pod): AppId => pod.metadata.labels![LABEL.app] as AppId;
const state = (pod: Pod) => pod.status?.containerStatuses?.find((c) => c.name === CONTAINER)?.state;

/** Why the instance in `pod` ended, or null while it has not; with `restartPolicy: Never` an ended container never comes back. */
export function ending(pod: Pod): string | null {
  const current = state(pod);
  if (current && 'terminated' in current) {
    const { reason, exitCode } = current.terminated;
    return reason === 'OOMKilled' ? 'container exceeded its memory limit (OOMKilled)' : `container exited with code ${exitCode}${reason ? ` (${reason})` : ''}`;
  }
  const phase = pod.status?.phase;
  return phase === 'Failed' || phase === 'Succeeded' ? `pod ${phase.toLowerCase()}${pod.status?.reason ? `: ${pod.status.reason}` : ''}` : null;
}

const running = (pod: Pod): string | null => {
  const current = state(pod);
  return current && 'running' in current && !pod.metadata.deletionTimestamp && pod.status?.podIP ? pod.status.podIP : null;
};

const missing = (error: unknown): boolean => error instanceof KubeError && error.status === 404;
const unavailable = (message: string): Unavailable => new Unavailable('container', message);

export type PodDriverOptions = {
  /** In the apps namespace. */
  readonly kube: KubeClient;
  readonly config: PodConfig;
  readonly store: LogStore;
  /** For `drain_timeout_seconds` while a Pod terminates. */
  readonly policyOf: (app: AppId) => Policy;
  readonly log?: Emit;
  readonly now?: () => number;
  /** How often waits on the Pod watch re-check their deadlines. */
  readonly pollMs?: number;
  readonly connect?: (host: string, port: number) => Promise<boolean>;
};

/** Handles are Pod uids; the name follows from the app. Kubernetes has no stopped Pod, so no handle outlives a sleep. */
export class PodDriver implements Driver<ContainerRun, string> {
  readonly kind = 'container';
  readonly handleKey = 'pod';
  readonly #kube: KubeClient;
  readonly #config: PodConfig;
  readonly #store: LogStore;
  readonly #policyOf: (app: AppId) => Policy;
  readonly #log: Emit;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #connect: (host: string, port: number) => Promise<boolean>;
  /** This replica's watch cache of instance Pods, by uid. */
  readonly #pods = new Map<string, Pod>();
  /** Uids the watch saw deleted, newest last, so a wait on a deletion that already happened ends. */
  readonly #deleted = new Set<string>();
  /** Uids already reported ended, so a later DELETED is not reported as a stop too. */
  readonly #reported = new Set<string>();
  readonly #stop = new AbortController();
  #changed = Promise.withResolvers<void>();
  #watching = false;
  #synced = false;
  #gone: Gone<string> = () => {};

  constructor(options: PodDriverOptions) {
    this.#kube = options.kube;
    this.#config = options.config;
    this.#store = options.store;
    this.#policyOf = options.policyOf;
    this.#log = options.log ?? emit;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? 1000;
    this.#connect = options.connect ?? canConnect;
  }

  accepts(spec: RunSpec): spec is ContainerRun {
    return spec.runtime.kind === 'container';
  }

  async start(slot: Slot<string>, spec: ContainerRun): Promise<string> {
    this.#watch();
    const deadline = this.#now() + this.#config.pendingSeconds * 1000;
    try {
      for (const { id } of spec.injection.storage) await this.#claim(spec, id);
      const stale = await this.#get(spec.app);
      if (stale) await this.#end(stale, ending(stale) ?? 'stale', deadline);
      slot.handle = null;
      const pod = await this.#create(podFor(spec, slot.epoch, this.#config));
      slot.handle = uidOf(pod);
      slot.release = spec.release;
      slot.specHash = specHash(spec);
      const ip = await this.#running(slot.handle, spec, deadline);
      slot.node = this.#pods.get(slot.handle)?.spec.nodeName;
      const readyBy = this.#now() + spec.policy.ready_timeout_seconds * 1000;
      while (!(await this.#connect(ip, APP_PORT))) {
        this.#alive(slot.handle, spec);
        if (this.#now() >= readyBy) {
          throw new Error(`app ${spec.app} did not accept TCP on port ${APP_PORT} within ready_timeout_seconds=${spec.policy.ready_timeout_seconds}`);
        }
        await sleep(READY_POLL_MS);
      }
      this.#alive(slot.handle, spec);
      return `${ip}:${APP_PORT}`;
    } catch (error) {
      if (slot.handle) {
        const pod = this.#pods.get(slot.handle);
        await this.#retire(spec.app, slot.handle, pod ? (ending(pod) ?? String(error)) : String(error)).then(() => (slot.handle = null), () => {});
      }
      throw error;
    }
  }

  async sleep(app: AppId, slot: Slot<string>): Promise<void> {
    if (slot.handle) await this.#retire(app, slot.handle, 'sleep', true);
    slot.handle = null;
  }

  async remove(app: AppId, uid: string): Promise<void> {
    await this.#retire(app, uid, 'remove', true);
  }

  /** Deletes without waiting; a failure leaves the Pod to the next start, which removes any Pod under the app's name. */
  async discard(app: AppId, uid: string): Promise<boolean> {
    return this.#delete(app, uid).then(() => true, () => false);
  }

  list(): Promise<readonly Adopted<string>[] | null> {
    return this.adopt();
  }

  async adopt(): Promise<readonly Adopted<string>[] | null> {
    let pods: readonly Pod[];
    try {
      pods = (await this.#kube.list('pods', { labelSelector: INSTANCES })).items;
    } catch (error) {
      if (error instanceof Unavailable) return null;
      throw error;
    }
    return pods.map((pod) => {
      const ip = running(pod);
      const labels = pod.metadata.labels!;
      return {
        app: appOf(pod), handle: uidOf(pod), release: labels[LABEL.release], spec: pod.metadata.annotations?.[LABEL.spec] ?? '',
        address: ip && !ending(pod) ? `${ip}:${APP_PORT}` : null,
      };
    });
  }

  follow(gone: Gone<string>, signal: AbortSignal): void {
    this.#gone = gone;
    signal.addEventListener('abort', () => this.#stop.abort(), { once: true });
    this.#watch();
  }

  /** Until the watch has listed once, nothing is known to contradict the row. */
  serves(uid: string, address: string): boolean {
    if (!this.#synced) return true;
    const pod = this.#pods.get(uid);
    return pod !== undefined && !ending(pod) && `${running(pod)}:${APP_PORT}` === address;
  }

  async logs(app: AppId, uid: string | null, tail: number): Promise<string> {
    if (uid !== null) {
      try {
        return await this.#kube.log(podName(app), { container: CONTAINER, tailLines: tail });
      } catch (error) {
        if (!(error instanceof KubeError)) throw error;
      }
    }
    const last = await this.#store.instanceLog(app);
    return last ? `${last.tail.trimEnd().split('\n').slice(-tail).join('\n')}\n` : '';
  }

  health(): readonly HealthCheck[] {
    return ['exit', 'ready', 'memory'];
  }

  /** A claim stays while a Pod mounts it (the pvc-protection finalizer), so purge waits for it to go. */
  async destroyStorage(_app: AppId, id: string): Promise<void> {
    await this.#kube.delete('persistentvolumeclaims', id).catch((error) => {
      if (!missing(error)) throw error;
    });
    const deadline = this.#now() + PURGE_MS;
    while (await this.#kube.get('persistentvolumeclaims', id).then(() => true, (error) => (missing(error) ? false : Promise.reject(error)))) {
      if (this.#now() >= deadline) throw new Conflict(`volume claim ${id} still exists ${PURGE_MS / 1000} s after its deletion; a Pod may still mount it`);
      await sleep(this.#pollMs);
    }
  }

  async #claim(spec: ContainerRun, id: string): Promise<void> {
    try {
      await this.#kube.create('persistentvolumeclaims', {
        metadata: { name: id, labels: { [LABEL.partOf]: 'pneuma-space', [LABEL.app]: spec.app, [LABEL.tenant]: spec.tenant } },
        spec: {
          accessModes: ['ReadWriteOnce'], storageClassName: this.#config.storageClass ?? undefined,
          resources: { requests: { storage: this.#config.volumeSize } },
        },
      });
    } catch (error) {
      if (!(error instanceof KubeError && error.status === 409)) throw error;
    }
  }

  /** A 409 is this wake's own Pod only when it carries this epoch; anything else holds the name for the takeover or orphan sweep. */
  async #create(pod: Pod): Promise<Pod> {
    try {
      return await this.#kube.create('pods', pod);
    } catch (error) {
      if (!(error instanceof KubeError && error.status === 409)) throw error;
      const held = await this.#kube.get('pods', pod.metadata.name);
      const epoch = pod.metadata.labels![LABEL.epoch];
      if (held.metadata.labels?.[LABEL.epoch] === epoch) return held;
      throw unavailable(`pod ${pod.metadata.name} is held by epoch ${held.metadata.labels?.[LABEL.epoch]}, not ${epoch}`);
    }
  }

  /** Pending past the deadline is the cluster's doing and not counted; an end before Running is the app's. */
  async #running(uid: string, spec: ContainerRun, deadline: number): Promise<string> {
    for (;;) {
      const ip = this.#alive(uid, spec);
      if (ip) return ip;
      if (this.#now() >= deadline) throw unavailable(`pod of app ${spec.app} did not run within PNEUMA_SPACE_K8S_PENDING_SECONDS=${this.#config.pendingSeconds}`);
      await this.#next();
    }
  }

  /** The Pod's IP once it runs; throws once it ended or was deleted. */
  #alive(uid: string, spec: ContainerRun): string | null {
    if (this.#deleted.has(uid)) throw unavailable(`pod of app ${spec.app} was deleted while it started`);
    const pod = this.#pods.get(uid);
    if (!pod) return null;
    const why = ending(pod);
    if (why) throw new Error(`app ${spec.app} ended before it was ready: ${why}`);
    return running(pod);
  }

  async #get(app: AppId): Promise<Pod | null> {
    return this.#kube.get('pods', podName(app)).catch((error) => (missing(error) ? null : Promise.reject(error)));
  }

  /** The Pod of `uid` from the cache, else from the API under the app's name; null when it is gone. */
  async #find(app: AppId, uid: string): Promise<Pod | null> {
    if (this.#deleted.has(uid)) return null;
    const pod = this.#pods.get(uid) ?? (await this.#get(app));
    return pod && uidOf(pod) === uid ? pod : null;
  }

  async #retire(app: AppId, uid: string, reason: string, wait = false): Promise<void> {
    const pod = await this.#find(app, uid);
    if (pod) await (wait ? this.#end(pod, reason, null) : this.#save(pod, reason).then(() => this.#delete(app, uid)));
  }

  /**
   * Keeps the log tail, deletes the Pod by uid and waits for it to go. A Pod on a lost node stays Terminating: after
   * drain_timeout_seconds it is force-deleted once the operator has tainted the node out-of-service, else the wait goes on.
   */
  async #end(pod: Pod, reason: string, deadline: number | null): Promise<void> {
    const app = appOf(pod);
    const uid = uidOf(pod);
    await this.#save(pod, reason);
    await this.#delete(app, uid);
    const drainBy = this.#now() + this.#policyOf(app).drain_timeout_seconds * 1000;
    let forced = false;
    while (await this.#find(app, uid)) {
      if (deadline !== null && this.#now() >= deadline) throw unavailable(`pod ${podName(app)} is still terminating`);
      if (!forced && this.#now() >= drainBy && (await this.#outOfService(this.#pods.get(uid) ?? pod))) {
        await this.#delete(app, uid, 0);
        forced = true;
        this.#log('pod-force-deleted', app, { pod: uid, node: pod.spec.nodeName });
      }
      await this.#next();
    }
  }

  async #outOfService(pod: Pod): Promise<boolean> {
    const node = pod.spec.nodeName;
    if (!node) return false;
    const { items } = await this.#kube.list('nodes', { fieldSelector: `metadata.name=${node}` });
    return items.some((n) => n.spec?.taints?.some((taint) => taint.key === OUT_OF_SERVICE));
  }

  /** 404 and a uid precondition failure both mean the Pod of `uid` is already gone. */
  async #delete(app: AppId, uid: string, gracePeriodSeconds?: number): Promise<void> {
    await this.#kube.delete('pods', podName(app), { uid, gracePeriodSeconds }).catch((error) => {
      if (!(error instanceof KubeError && (error.status === 404 || error.status === 409))) throw error;
    });
  }

  async #save(pod: Pod, reason: string): Promise<void> {
    const tail = await this.#kube.log(pod.metadata.name, { container: CONTAINER, tailLines: LOG_LINES, limitBytes: LOG_BYTES }).catch(() => null);
    if (tail === null) return;
    await this.#store.putInstanceLog({ app: appOf(pod), release: Number(pod.metadata.labels![LABEL.release]) as ReleaseNumber, endedAt: this.#now(), reason, tail });
  }

  #next(): Promise<unknown> {
    return Promise.race([this.#changed.promise, sleep(this.#pollMs, undefined, { ref: false })]);
  }

  #watch(): void {
    if (this.#watching) return;
    this.#watching = true;
    void this.#run();
  }

  async #run(): Promise<void> {
    const signal = this.#stop.signal;
    let failingSince: number | null = null;
    while (!signal.aborted) {
      try {
        const listed = await this.#kube.list('pods', { labelSelector: INSTANCES });
        this.#resync(listed.items);
        failingSince = null;
        for await (const event of this.#kube.watch('pods', { labelSelector: INSTANCES, from: listed, signal })) {
          this.#apply(event);
        }
      } catch (error) {
        if (signal.aborted) return;
        failingSince ??= this.#now();
        if (this.#now() - failingSince >= UNREACHABLE_MS) {
          failingSince = null;
          this.#log('kube-unreachable', null, { error: String(error), pods: this.#pods.size });
          for (const pod of this.#pods.values()) if (!this.#reported.has(uidOf(pod))) this.#gone(appOf(pod), uidOf(pod), { ev: 'unavailable' });
          this.#pods.clear();
          this.#synced = false;
        }
        await sleep(RETRY_MS, undefined, { ref: false });
      }
    }
  }

  /** A fresh list replaces the cache; a cached Pod missing from it was deleted while the watch was down. */
  #resync(pods: readonly Pod[]): void {
    const listed = new Set(pods.map(uidOf));
    for (const [uid, pod] of this.#pods) if (!listed.has(uid)) this.#apply({ type: 'DELETED', object: pod });
    for (const pod of pods) this.#apply({ type: 'MODIFIED', object: pod });
    this.#synced = true;
  }

  #apply(event: WatchEvent<Pod>): void {
    if (event.type === 'BOOKMARK') return;
    const pod = event.object;
    const uid = uidOf(pod);
    if (event.type === 'DELETED') {
      this.#pods.delete(uid);
      this.#deleted.add(uid);
      if (this.#deleted.size > DELETED_KEPT) this.#deleted.delete(this.#deleted.values().next().value!);
      if (!this.#reported.delete(uid)) this.#gone(appOf(pod), uid, { ev: 'stopped' });
    } else {
      this.#pods.set(uid, pod);
      const why = ending(pod);
      if (why && !this.#reported.has(uid)) {
        this.#reported.add(uid);
        this.#gone(appOf(pod), uid, { ev: 'crashed', reason: why });
      }
    }
    const { resolve } = this.#changed;
    this.#changed = Promise.withResolvers();
    resolve();
  }
}

export type PodRuntimeOptions = {
  readonly kube: KubeClient;
  readonly config: PodConfig;
  readonly specFor: (app: AppId) => RunSpec | null;
  readonly instances: Instances;
  readonly guard?: AppGuard;
  readonly log?: Emit;
};

export class PodRuntime extends Lifecycle<ContainerRun, string> {
  constructor(options: PodRuntimeOptions) {
    const policyOf = (app: AppId) => options.specFor(app)?.policy ?? DEFAULT_POLICY;
    super(new PodDriver({ kube: options.kube, config: options.config, store: options.instances.store, policyOf, log: options.log }), options);
  }
}
