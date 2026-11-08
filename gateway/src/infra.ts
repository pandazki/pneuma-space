import type { Docker } from './docker.ts';
import type { ImageId, Infra } from './model.ts';

export class DockerInfra implements Infra {
  readonly #docker: Docker;

  constructor(docker: Docker) {
    this.#docker = docker;
  }

  resolveImage(reference: string): Promise<ImageId | null> {
    return this.#docker.imageId(reference);
  }

  async nodes(): Promise<null> {
    return null;
  }
}
