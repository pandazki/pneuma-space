// The node view (ADR 0024 item 8) and the cluster view (ADR 0026): sampled every 15 s on every replica, answered from memory.
import { DEAD_MS, type Instances } from './instances.ts';
import type {
  AppId, AppName, AppSummary, ClusterView, Infra, Instance, InstanceRow, InstanceState, NodeEntry, PlatformPod, Replica, VolumeRow,
} from './model.ts';

/** The runner's own `GET /health` answer, the fields the node view shows. */
export type RunnerHealth = { readonly workers: number; readonly stuck: number };

export type NodeViewDeps = {
  readonly infra: Pick<Infra, 'nodes' | 'workloads' | 'volumes' | 'warnings'>;
  readonly apps: () => Promise<readonly AppSummary[]>;
  readonly nameOf: (app: AppId) => AppName | null;
  readonly instances: Pick<Instances, 'row' | 'rows'>;
  /** The replica rows; the one whose heartbeat says it leads is the leading gateway. */
  readonly replicas: () => Promise<readonly Replica[]>;
  /** The runner at `host` on its control port; null when it does not answer. */
  readonly runner: (host: string) => Promise<RunnerHealth | null>;
  readonly now?: () => number;
};

const running = (state: AppSummary['instance']): state is InstanceState => state !== 'none' && state !== 'asleep';
const instancesOf = (apps: readonly AppSummary[]) => apps.flatMap((a) => (running(a.instance) ? [{ app: a.name, runtime: a.runtime, state: a.instance, node: a.node }] : []));

export class NodeView {
  readonly #deps: NodeViewDeps;
  readonly #now: () => number;
  #cluster: ClusterView = { plane: 'docker', sampledAt: null, nodes: [], workloads: [], instances: [], volumes: [], warnings: [] };
  #pods: readonly PlatformPod[] = [];

  constructor(deps: NodeViewDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Memory only: the last sample. */
  snapshot(): ClusterView {
    return this.#cluster;
  }


  /** Where the app's instance runs: the row's node, else its Pod's, else its runner's (ADR 0024 item 8); null when asleep or not known. */
  nodeOf(app: AppId): string | null {
    const row = this.#deps.instances.row(app);
    if (!row || row.state === 'asleep') return null;
    return row.node ?? this.#podOf(row)?.node ?? null;
  }

  /** The instance's own Pod, or the runner Pod its isolate worker runs in. */
  #podOf(row: Instance): PlatformPod | null {
    return this.#pods.find((p) => (p.role === 'instance' && p.app === row.app)
      || (p.role === 'runner' && row.home !== null && (row.home === p.name || (p.ip !== null && (row.home === p.ip || row.home.startsWith(`${p.ip}:`)))))) ?? null;
  }

  /** One round of Infra lists; the listing is read after them, so `nodeOf` already sees this sample's Pods. */
  async sample(): Promise<void> {
    const { infra } = this.#deps;
    const [cluster, workloads, volumes, warnings, replicas] = await Promise.all([
      infra.nodes(), infra.workloads(), infra.volumes(), infra.warnings(), this.#deps.replicas(),
    ]);
    this.#pods = cluster?.flatMap((n) => n.pods) ?? [];
    const apps = await this.#deps.apps();
    const now = this.#now();
    const nodes = cluster === null ? [] : await Promise.all(cluster.map(async (n): Promise<NodeEntry> => {
      const runner = n.pods.find((p) => p.role === 'runner') ?? null;
      const health = runner?.ready && runner.ip ? await this.#deps.runner(runner.ip) : null;
      return {
        name: n.name, ready: n.ready, schedulable: n.schedulable, labels: n.labels, taints: n.taints,
        allocatable: n.allocatable, requested: n.requested, used: null,
        gateways: n.pods.filter((p) => p.role === 'gateway').map((p) => ({ pod: p.name, ready: p.ready })),
        runner: runner && { pod: runner.name, ready: runner.ready, restarts: runner.restarts, workers: health?.workers ?? null, stuck: health?.stuck ?? null },
        instances: instancesOf(apps).filter((i) => i.node === n.name).map(({ node: _, ...i }) => i),
      };
    }));
    const leaders = new Set(replicas.filter((r) => r.leading && r.seenAt >= now - DEAD_MS).map((r) => r.id as string));
    this.#cluster = {
      plane: cluster === null ? 'docker' : 'kubernetes',
      sampledAt: now,
      nodes,
      workloads: workloads.map((w) => ({ ...w, pods: w.pods.map((p) => ({ ...p, leading: p.role === 'gateway' && leaders.has(p.name) })) })),
      instances: this.#instanceRows(apps, cluster !== null),
      volumes: volumes.flatMap((v): VolumeRow[] => {
        const app = this.#deps.nameOf(v.app);
        return app ? [{ ...v, app }] : [];
      }),
      warnings,
    };
  }

  /** Every instance row not asleep, joined to its app's listing and, on a cluster, to its Pod; on a single host `pod` is the handle. */
  #instanceRows(apps: readonly AppSummary[], onCluster: boolean): InstanceRow[] {
    const byName = new Map(apps.map((a) => [a.name, a]));
    return [...this.#deps.instances.rows()].flatMap((row): InstanceRow[] => {
      const name = this.#deps.nameOf(row.app);
      const summary = name === null ? undefined : byName.get(name);
      if (row.state === 'asleep' || !summary) return [];
      const pod = onCluster ? this.#podOf(row) : null;
      return [{
        app: summary.name, tenant: summary.tenant, runtime: row.runtime, state: row.state, since: row.since, actor: row.actor,
        node: onCluster ? (row.node ?? pod?.node ?? null) : null,
        pod: onCluster ? (pod?.name ?? null) : row.handle,
        leases: summary.leases, requests: summary.requests,
        restarts: pod?.role === 'instance' ? pod.restarts : null,
      }];
    }).sort((a, b) => (a.app < b.app ? -1 : 1));
  }
}
