// Infra of the kubernetes plane: image references resolve to digests in the organization's registry (ADR 0019 item 6), nodes are listed for the node view (ADR 0024 item 8).
import { readFile } from 'node:fs/promises';
import type { KubeClient, Node, Pod } from './kube.ts';
import type { AppId, ImageId, Infra, NodeSample, PlatformPod } from './model.ts';

const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

type Reference = { readonly host: string; readonly repo: string; readonly ref: string };
type DockerConfig = { readonly auths?: Readonly<Record<string, { readonly auth?: string; readonly username?: string; readonly password?: string }>> };

const named = (first: string): boolean => first.includes('.') || first.includes(':') || first === 'localhost';

/** `host/repo:tag` or `host/repo@sha256:…`; a reference without a host is under `registry`. */
export function parseReference(reference: string, registry: string | null): Reference {
  const slash = reference.indexOf('/');
  if (slash < 0 || !named(reference.slice(0, slash))) {
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
  /** One client per platform namespace, whose Pods with a `pneuma-space.role` label the node view counts; nodes are listed through the first. */
  readonly namespaces: readonly [KubeClient, ...KubeClient[]];
  /** PNEUMA_SPACE_REGISTRY. */
  readonly registry: string | null;
  /** PNEUMA_SPACE_REGISTRY_AUTH: a dockerconfigjson file, read per call so a rotated Secret applies. */
  readonly authFile: string | null;
};

export class KubeInfra implements Infra {
  readonly #namespaces: KubeInfraOptions['namespaces'];
  readonly #registry: string | null;
  readonly #authFile: string | null;

  constructor(options: KubeInfraOptions) {
    this.#namespaces = options.namespaces;
    this.#registry = options.registry;
    this.#authFile = options.authFile;
  }

  /** One list of nodes and one list of role-labelled Pods per namespace; never `metrics.k8s.io`. */
  async nodes(): Promise<NodeSample[]> {
    const [nodes, ...pods] = await Promise.all([
      this.#namespaces[0].list('nodes'),
      ...this.#namespaces.map((kube) => kube.list('pods', { labelSelector: ROLE })),
    ]);
    const all = pods.flatMap((list) => list.items);
    return nodes.items.map((node) => nodeSample(node, all)).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** `HEAD /v2/<repo>/manifests/<ref>`; a 401 is answered once, with Basic credentials or a Bearer token exchanged for them. Null when the registry has no such image. */
  async resolveImage(reference: string): Promise<ImageId | null> {
    const { host, repo, ref } = parseReference(reference, this.#registry);
    const url = `${scheme(host)}://${host}/v2/${repo}/manifests/${ref}`;
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
    const url = new URL(params.realm);
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
