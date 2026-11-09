import type { Docker } from './docker.ts';
import type { Probe, ServiceName } from './metrics.ts';
import { NotOnThisPlane, type ImageId, type Infra, type VolumeSample, type Warning, type Workload } from './model.ts';

/** The compose service each probe stands for. */
const SERVICES: Readonly<Record<ServiceName, string>> = { redis: 'redis', object: 'rustfs', postgres: 'postgres', coturn: 'coturn', runner: 'runner' };

export type DockerInfraOptions = {
  readonly docker: Docker;
  readonly probes: Readonly<Record<ServiceName, Probe>>;
  /** The volumes the state inventory lists. */
  readonly volumes: () => Promise<VolumeSample[]>;
};

/** A single host: the compose services stand in for workloads, each with no Pods and nothing to scale (ADR 0026 item 6). */
export class DockerInfra implements Infra {
  readonly #options: DockerInfraOptions;

  constructor(options: DockerInfraOptions) {
    this.#options = options;
  }

  resolveImage(reference: string): Promise<ImageId | null> {
    return this.#options.docker.imageId(reference);
  }

  async nodes(): Promise<null> {
    return null;
  }

  /** A service whose profile is off is wanted by no one: desired 0. */
  async workloads(): Promise<Workload[]> {
    const service = (name: string, status: 'up' | 'down' | 'off'): Workload => ({
      name, role: name, kind: 'service', desired: status === 'off' ? 0 : 1, ready: status === 'up' ? 1 : 0, scalable: false, image: null, pods: [],
    });
    const probed = await Promise.all(Object.entries(this.#options.probes).map(async ([key, probe]) => service(SERVICES[key as ServiceName], await probe())));
    return [service('gateway', 'up'), ...probed];
  }

  volumes(): Promise<VolumeSample[]> {
    return this.#options.volumes();
  }

  async warnings(): Promise<Warning[]> {
    return [];
  }

  async scale(): Promise<never> {
    throw new NotOnThisPlane('scaling');
  }

  async deletePod(): Promise<never> {
    throw new NotOnThisPlane('restarting a Pod');
  }
}
