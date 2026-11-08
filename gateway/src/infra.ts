import { hostname } from 'node:os';
import type { Docker } from './docker.ts';
import { Conflict, type ImageId, type Infra, type Job, type JobResult } from './model.ts';

/** PNEUMA_SPACE_COMPOSE_PROJECT, else the compose project label of the container this process runs in, else `pneuma-space`. */
export async function composeProject(docker: Docker): Promise<string> {
  return process.env.PNEUMA_SPACE_COMPOSE_PROJECT
    ?? (await docker.inspect(hostname()))?.Config.Labels['com.docker.compose.project']
    ?? 'pneuma-space';
}

export class DockerInfra implements Infra {
  readonly #docker: Docker;
  /** Compose project whose service containers run jobs; see composeProject. */
  readonly #project: string;

  constructor(docker: Docker, project: string) {
    this.#docker = docker;
    this.#project = project;
  }

  async runJob(job: Job): Promise<JobResult> {
    const [container] = await this.#docker.list({
      label: [`com.docker.compose.project=${this.#project}`, `com.docker.compose.service=${job.service}`], status: ['running'],
    });
    if (!container) {
      throw new Conflict(`service ${job.service} of compose project ${this.#project} is not running; start it with docker compose (it may sit behind a profile)`);
    }
    return this.#docker.exec(container.Id, job.argv, job.stdin);
  }

  resolveImage(reference: string): Promise<ImageId | null> {
    return this.#docker.imageId(reference);
  }

  async nodes(): Promise<null> {
    return null;
  }
}
