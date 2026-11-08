// The node view (ADR 0024 item 8): sampled every 15 s on every replica, answered from memory.
import { hostname } from 'node:os';
import type { Instances } from './instances.ts';
import type { HostSample } from './metrics.ts';
import {
  RUNTIMES,
  type AppId, type AppName, type AppSummary, type Infra, type InstanceState, type NodeSample, type PlatformPod, type ReplicaId, type RuntimeKind,
} from './model.ts';

const MIB = 2 ** 20;

/** The runner's own `GET /health` answer, the fields the node view shows. */
export type RunnerHealth = { readonly workers: number; readonly stuck: number };
type Amounts = { readonly cpuMillis: number; readonly memoryBytes: number; readonly pods: number | null };
type NodeEntry = {
  readonly name: string;
  readonly ready: boolean;
  readonly schedulable: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly taints: NodeSample['taints'];
  readonly allocatable: Amounts;
  readonly requested: Amounts;
  readonly used: HostSample | null;
  readonly gateways: readonly { readonly pod: string; readonly ready: boolean }[];
  readonly runner: { readonly pod: string; readonly ready: boolean; readonly restarts: number | null; readonly workers: number | null; readonly stuck: number | null } | null;
  readonly instances: readonly { readonly app: AppName; readonly runtime: RuntimeKind | null; readonly state: InstanceState }[];
};
export type NodesAnswer =
  | { readonly source: 'k8s' | 'host'; readonly sampledAt: number; readonly nodes: readonly NodeEntry[] }
  | { readonly source: null; readonly sampledAt: null; readonly nodes: readonly [] };

export type NodeViewDeps = {
  readonly infra: Pick<Infra, 'nodes'>;
  readonly apps: () => Promise<readonly AppSummary[]>;
  readonly instances: Pick<Instances, 'row' | 'rows'>;
  readonly host: () => Promise<HostSample>;
  /** The runner at `host` on its control port; null when it does not answer. */
  readonly runner: (host: string) => Promise<RunnerHealth | null>;
  /** Single host: whether the runner's compose profile is up. */
  readonly runnerOnHost: () => Promise<boolean>;
  readonly replica: ReplicaId;
  readonly hostname?: string;
  readonly now?: () => number;
};

const running = (state: AppSummary['instance']): state is InstanceState => state !== 'none' && state !== 'asleep';
const instancesOf = (apps: readonly AppSummary[]) => apps.flatMap((a) => (running(a.instance) ? [{ app: a.name, runtime: a.runtime, state: a.instance, node: a.node }] : []));

export class NodeView {
  readonly #deps: NodeViewDeps;
  readonly #now: () => number;
  #answer: NodesAnswer = { source: null, sampledAt: null, nodes: [] };
  #pods: readonly (PlatformPod & { readonly node: string })[] = [];

  constructor(deps: NodeViewDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Memory only: the last sample. */
  snapshot(): NodesAnswer {
    return this.#answer;
  }

  /** Where the app's instance runs: the row's node, else its Pod's, else its runner's (ADR 0024 item 8); null when asleep or not known. */
  nodeOf(app: AppId): string | null {
    const row = this.#deps.instances.row(app);
    if (!row || row.state === 'asleep') return null;
    if (row.node) return row.node;
    const pod = this.#pods.find((p) => (p.role === 'instance' && p.app === app)
      || (p.role === 'runner' && row.home !== null && (row.home === p.name || (p.ip !== null && (row.home === p.ip || row.home.startsWith(`${p.ip}:`))))));
    return pod?.node ?? null;
  }

  /** One `Infra.nodes()` call; the listing is read after it, so `nodeOf` already sees this sample's Pods. */
  async sample(): Promise<void> {
    const cluster = await this.#deps.infra.nodes();
    if (cluster === null) {
      this.#pods = [];
      this.#answer = { source: 'host', sampledAt: this.#now(), nodes: [await this.#host()] };
      return;
    }
    this.#pods = cluster.flatMap((n) => n.pods.map((p) => ({ ...p, node: n.name })));
    const instances = instancesOf(await this.#deps.apps());
    const nodes = await Promise.all(cluster.map(async (n): Promise<NodeEntry> => {
      const runner = n.pods.find((p) => p.role === 'runner') ?? null;
      const health = runner?.ready && runner.ip ? await this.#deps.runner(runner.ip) : null;
      return {
        name: n.name, ready: n.ready, schedulable: n.schedulable, labels: n.labels, taints: n.taints,
        allocatable: n.allocatable, requested: n.requested, used: null,
        gateways: n.pods.filter((p) => p.role === 'gateway').map((p) => ({ pod: p.name, ready: p.ready })),
        runner: runner && { pod: runner.name, ready: runner.ready, restarts: runner.restarts, workers: health?.workers ?? null, stuck: health?.stuck ?? null },
        instances: instances.filter((i) => i.node === n.name).map(({ node: _, ...i }) => i),
      };
    }));
    this.#answer = { source: 'k8s', sampledAt: this.#now(), nodes };
  }

  /** The single host as one node: what awake instances took from it, and what the host itself reports. */
  async #host(): Promise<NodeEntry> {
    const [used, apps, runnerUp] = await Promise.all([this.#deps.host(), this.#deps.apps(), this.#deps.runnerOnHost()]);
    const rows = [...this.#deps.instances.rows()].filter((r) => r.state !== 'asleep');
    const health = runnerUp ? await this.#deps.runner(RUNTIMES.isolate.service) : null;
    return {
      name: this.#deps.hostname ?? hostname(), ready: true, schedulable: true, labels: {}, taints: [],
      allocatable: { cpuMillis: used.cpus * 1000, memoryBytes: used.memory.totalBytes, pods: null },
      requested: { cpuMillis: rows.reduce((sum, r) => sum + r.cpuMillis, 0), memoryBytes: rows.reduce((sum, r) => sum + r.memoryMb * MIB, 0), pods: rows.length },
      used,
      gateways: [{ pod: this.#deps.replica, ready: true }],
      runner: runnerUp ? { pod: RUNTIMES.isolate.service, ready: health !== null, restarts: null, workers: health?.workers ?? null, stuck: health?.stuck ?? null } : null,
      instances: instancesOf(apps).map(({ node: _, ...i }) => i),
    };
  }
}
