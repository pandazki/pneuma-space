// Infra of the kubernetes plane: image references resolve to digests in the organization's registry (ADR 0019 item 6), nodes are listed for the node view
// (ADR 0024 item 8), and the platform's own objects for the cluster page (ADR 0026).
import { readFile } from 'node:fs/promises';
import type { Event, KubeClient, Node, Pod, Scalable, Workload as KubeWorkload } from './kube.ts';
import {
  Conflict, NotFound,
  type AppId, type ImageId, type Infra, type NodeSample, type PlatformPod, type VolumeSample, type Warning, type Workload,
} from './model.ts';

const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

type Reference = { readonly host: string; readonly repo: string; readonly ref: string };
type DockerConfig = { readonly auths?: Readonly<Record<string, { readonly auth?: string; readonly username?: string; readonly password?: string }>> };

/** Whether the first path segment of `reference` is a registry host, as Docker decides it. */
export function namesRegistry(reference: string): boolean {
  const slash = reference.indexOf('/');
  const first = reference.slice(0, slash);
  return slash > 0 && (first.includes('.') || first.includes(':') || first === 'localhost');
}

/** `host/repo:tag` or `host/repo@sha256:…`; a reference without a host is under `registry`. */
export function parseReference(reference: string, registry: string | null): Reference {
  const slash = reference.indexOf('/');
  if (!namesRegistry(reference)) {
    if (!registry) throw new Error(`image reference "${reference}" names no registry and PNEUMA_SPACE_REGISTRY is unset`);
    return parseReference(`${registry.replace(/\/$/, '')}/${reference}`, null);
  }
  const host = reference.slice(0, slash);
  const path = reference.slice(slash + 1);
  const at = path.indexOf('@');
  if (at >= 0) return { host, repo: path.slice(0, at), ref: path.slice(at + 1) };
  const colon = path.lastIndexOf(':');
  return colon > path.lastIndexOf('/') ? { host, repo: path.slice(0, colon), ref: path.slice(colon + 1) } : { host, repo: path, ref: 'latest' };
}

const BINARY: Readonly<Record<string, number>> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Readonly<Record<string, number>> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** A Kubernetes quantity (`250m`, `1.5`, `512Mi`, `1e3`) as a number; 0 when absent or malformed. */
function quantity(raw: string | undefined): number {
  const m = /^(\d*\.?\d+)(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE]))?$/.exec(raw?.trim() ?? '');
  return m ? Number(m[1] + (m[2] ?? '')) * (BINARY[m[3] ?? ''] ?? DECIMAL[m[3] ?? '']!) : 0;
}

const ROLE = 'pneuma-space.role';
const APP = 'pneuma-space.app';
const GIB = 2 ** 30;
const HOUR = 3_600_000;
/** The only workloads an operator scales from the page (ADR 0026 item 3). */
const SCALABLE: ReadonlyMap<string, Scalable> = new Map([['pneuma-space-gateway', 'deployments'], ['pneuma-space-runner', 'statefulsets']]);
const RESTARTABLE: ReadonlySet<string> = new Set(['gateway', 'runner']);
const WARNED: ReadonlySet<string> = new Set<Warning['kind']>(['Pod', 'Node', 'PersistentVolumeClaim']);
const instant = (raw: string | undefined): number | null => (raw ? Date.parse(raw) : null);
/** A KubeError's status, read structurally: appctl imports this module for parseReference, without kube.ts. */
const statusOf = (error: unknown): number | null => (error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : null);

/** What the scheduler counts against a node: Pods that are bound and not finished. */
const holds = (pod: Pod): boolean => pod.status?.phase !== 'Succeeded' && pod.status?.phase !== 'Failed';

function platformPod(pod: Pod): PlatformPod {
  const statuses = pod.status?.containerStatuses ?? [];
  return {
    name: pod.metadata.name,
    role: pod.metadata.labels?.[ROLE] ?? '',
    app: (pod.metadata.labels?.[APP] as AppId | undefined) ?? null,
    ip: pod.status?.podIP ?? null,
    phase: pod.status?.phase ?? 'Unknown',
    ready: statuses.length > 0 && statuses.every((c) => c.ready),
    restarts: statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
    node: pod.spec.nodeName ?? null,
    startedAt: instant(pod.status?.startTime),
    leading: false,
  };
}

function workload(kind: 'Deployment' | 'StatefulSet', object: KubeWorkload, pods: readonly Pod[]): Workload {
  const role = object.metadata.labels?.[ROLE] ?? '';
  return {
    name: object.metadata.name,
    role,
    kind,
    desired: object.spec.replicas ?? 1,
    ready: object.status?.readyReplicas ?? 0,
    scalable: SCALABLE.has(object.metadata.name),
    image: object.spec.template.spec.containers[0]?.image ?? null,
    pods: pods.filter((pod) => pod.metadata.labels?.[ROLE] === role).map(platformPod),
  };
}

function warning(event: Event): Warning | null {
  const kind = event.involvedObject.kind ?? '';
  const at = instant(event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp);
  if (!WARNED.has(kind) || at === null) return null;
  return {
    at, kind: kind as Warning['kind'], object: event.involvedObject.name ?? '', reason: event.reason ?? '', message: event.message ?? '',
    count: event.series?.count ?? event.count ?? 1,
  };
}

function nodeSample(node: Node, pods: readonly Pod[]): NodeSample {
  const mine = pods.filter((pod) => pod.spec.nodeName === node.metadata.name);
  const asks = mine.filter(holds).flatMap((pod) => pod.spec.containers.map((c) => c.resources?.requests ?? {}));
  const allocatable = node.status?.allocatable ?? {};
  return {
    name: node.metadata.name,
    ready: node.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
    schedulable: !node.spec?.unschedulable,
    labels: node.metadata.labels ?? {},
    taints: node.spec?.taints ?? [],
    allocatable: { cpuMillis: Math.round(quantity(allocatable.cpu) * 1000), memoryBytes: Math.round(quantity(allocatable.memory)), pods: quantity(allocatable.pods) },
    requested: {
      cpuMillis: Math.round(asks.reduce((sum, r) => sum + quantity(r.cpu) * 1000, 0)),
      memoryBytes: Math.round(asks.reduce((sum, r) => sum + quantity(r.memory), 0)),
      pods: mine.filter(holds).length,
    },
    pods: mine.map(platformPod),
  };
}

const hostOf = (key: string): string => key.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
/** Plain HTTP only for a registry on this machine, as Docker allows. */
const scheme = (host: string): string => (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');

export type KubeInfraOptions = {
  /** The gateway's namespace, holding the gateway Deployment and the runner StatefulSet; nodes are listed through it. */
  readonly platform: KubeClient;
  /** `pneuma-space-apps`, holding the instance Pods and the app claims. */
  readonly apps: KubeClient;
  /** PNEUMA_SPACE_REGISTRY. */
  readonly registry: string | null;
  /** PNEUMA_SPACE_REGISTRY_API: where the gateway reaches the registry's host when that differs from where nodes pull. */
  readonly registryApi: string | null;
  /** PNEUMA_SPACE_REGISTRY_AUTH: a dockerconfigjson file, read per call so a rotated Secret applies. */
  readonly authFile: string | null;
};

export class KubeInfra implements Infra {
  readonly #platform: KubeClient;
  readonly #apps: KubeClient;
  readonly #registry: string | null;
  readonly #authFile: string | null;
  readonly #api: { readonly host: string; readonly origin: string } | null;
  readonly #now: () => number;

  constructor(options: KubeInfraOptions & { readonly now?: () => number }) {
    this.#platform = options.platform;
    this.#apps = options.apps;
    this.#now = options.now ?? Date.now;
    this.#registry = options.registry;
    this.#authFile = options.authFile;
    this.#api = options.registry && options.registryApi ? { host: hostOf(options.registry), origin: new URL(options.registryApi).origin } : null;
  }

  #origin(host: string): string {
    return host === this.#api?.host ? this.#api.origin : `${scheme(host)}://${host}`;
  }

  /** One list of nodes and one list of role-labelled Pods per namespace; never `metrics.k8s.io`. */
  async nodes(): Promise<NodeSample[]> {
    const [nodes, ...pods] = await Promise.all([
      this.#platform.list('nodes'),
      ...[this.#platform, this.#apps].map((kube) => kube.list('pods', { labelSelector: ROLE })),
    ]);
    const all = pods.flatMap((list) => list.items);
    return nodes.items.map((node) => nodeSample(node, all)).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** The role-labelled Deployments and StatefulSets of the platform namespace, each with its Pods. */
  async workloads(): Promise<Workload[]> {
    const selector = { labelSelector: ROLE };
    const [deployments, statefulsets, pods] = await Promise.all([
      this.#platform.list('deployments', selector), this.#platform.list('statefulsets', selector), this.#platform.list('pods', selector),
    ]);
    return [
      ...deployments.items.map((d) => workload('Deployment', d, pods.items)),
      ...statefulsets.items.map((s) => workload('StatefulSet', s, pods.items)),
    ].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** The app claims; `node` is where the scheduler bound a claim of a WaitForFirstConsumer class. */
  async volumes(): Promise<VolumeSample[]> {
    const { items } = await this.#apps.list('persistentvolumeclaims', { labelSelector: APP });
    return items.map((claim) => ({
      app: claim.metadata.labels![APP] as AppId,
      name: claim.metadata.name,
      sizeGb: quantity(claim.spec.resources.requests.storage) / GIB,
      storageClass: claim.spec.storageClassName ?? null,
      phase: claim.status?.phase ?? null,
      node: claim.metadata.annotations?.['volume.kubernetes.io/selected-node'] ?? null,
    }));
  }

  /** Warning events of the last hour about Pods, Nodes and claims, in both namespaces, newest first. */
  async warnings(): Promise<Warning[]> {
    const lists = await Promise.all([this.#platform, this.#apps].map((kube) => kube.list('events', { fieldSelector: 'type=Warning' })));
    const since = this.#now() - HOUR;
    return lists.flatMap((list) => list.items.map(warning)).filter((w): w is Warning => w !== null && w.at >= since).sort((a, b) => b.at - a.at);
  }

  async scale(name: string, replicas: number): Promise<void> {
    const kind = SCALABLE.get(name);
    if (!kind) throw new Conflict(`${name} is not scalable; only ${[...SCALABLE.keys()].join(' and ')} are`);
    await this.#platform.scale(kind, name, replicas);
  }

  /** A home is a runner Pod's name, `<StatefulSet>-<ordinal>`; at `replicas` the StatefulSet keeps ordinals 0 to replicas - 1 (ADR 0032). */
  removedBy(name: string, replicas: number): ((home: string) => boolean) | null {
    if (SCALABLE.get(name) !== 'statefulsets') return null;
    return (home) => {
      const ordinal = home.startsWith(`${name}-`) ? home.slice(name.length + 1) : '';
      return /^\d+$/.test(ordinal) && Number(ordinal) >= replicas;
    };
  }

  /** The uid precondition keeps a replacement the controller already made under the same name. */
  async deletePod(name: string): Promise<void> {
    const pod = await this.#platform.get('pods', name).catch((error: unknown) => {
      if (statusOf(error) === 404) throw new NotFound(`no platform Pod named "${name}"`);
      throw error;
    });
    const role = pod.metadata.labels?.[ROLE];
    if (!role || !RESTARTABLE.has(role)) throw new Conflict(`Pod ${name} is not a gateway or runner Pod; restart it with kubectl`);
    await this.#platform.delete('pods', name, { uid: pod.metadata.uid }).catch((error: unknown) => {
      if (statusOf(error) !== 404 && statusOf(error) !== 409) throw error;
    });
  }

  /** `HEAD /v2/<repo>/manifests/<ref>`; a 401 is answered once, with Basic credentials or a Bearer token exchanged for them. Null when the registry has no such image. */
  async resolveImage(reference: string): Promise<ImageId | null> {
    const { host, repo, ref } = parseReference(reference, this.#registry);
    const url = `${this.#origin(host)}/v2/${repo}/manifests/${ref}`;
    const head = (authorization: string | null) => fetch(url, { method: 'HEAD', headers: { accept: MANIFESTS, ...(authorization ? { authorization } : {}) } });
    let res = await head(null);
    if (res.status === 401) {
      const basic = await this.#basic(host);
      const challenge = res.headers.get('www-authenticate') ?? '';
      const authorization = /^bearer /i.test(challenge) ? `Bearer ${await this.#token(challenge, repo, basic)}` : basic;
      if (!authorization) throw new Error(`registry ${host} asks for credentials and PNEUMA_SPACE_REGISTRY_AUTH has none for it`);
      res = await head(authorization);
    }
    if (res.status === 404) return null;
    const digest = res.headers.get('docker-content-digest');
    if (!res.ok || !digest) throw new Error(`registry ${host} answered ${res.status}${digest ? '' : ' without Docker-Content-Digest'} for ${repo}:${ref}`);
    return `${host}/${repo}@${digest}` as ImageId;
  }

  async #basic(host: string): Promise<string | null> {
    if (!this.#authFile) return null;
    const config = JSON.parse(await readFile(this.#authFile, 'utf8')) as DockerConfig;
    const entry = Object.entries(config.auths ?? {}).find(([key]) => hostOf(key) === host)?.[1];
    if (!entry) return null;
    return `Basic ${entry.auth ?? Buffer.from(`${entry.username}:${entry.password}`).toString('base64')}`;
  }

  async #token(challenge: string, repo: string, basic: string | null): Promise<string> {
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    if (!params.realm) throw new Error(`registry challenge has no realm: ${challenge}`);
    const realm = new URL(params.realm);
    const url = new URL(realm.pathname + realm.search, realm.host === this.#api?.host ? this.#api.origin : realm.origin);
    if (params.service) url.searchParams.set('service', params.service);
    url.searchParams.set('scope', params.scope ?? `repository:${repo}:pull`);
    const res = await fetch(url, { headers: basic ? { authorization: basic } : {} });
    if (!res.ok) throw new Error(`registry token endpoint ${url.origin} answered ${res.status}`);
    const body = (await res.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new Error(`registry token endpoint ${url.origin} returned no token`);
    return token;
  }
}
