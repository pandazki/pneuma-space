import type { AppId } from '../../shared/values.ts';
import type { ResourceDirectory } from './model.ts';
import type { Records, RecordsAccess, ResourceStatus } from './records-contract.ts';

export class RecordsProvider {
  readonly #resources: ResourceDirectory;

  constructor(resources: ResourceDirectory) {
    this.#resources = resources;
  }

  ensure(appId: AppId, sequence: number): Promise<ResourceStatus> {
    return this.#resources.records(appId).transition('active', sequence);
  }

  inject(appId: AppId, access: RecordsAccess): Records {
    const resource = this.#resources.records(appId);
    return {
      get: key => resource.get(access, key),
      list: options => resource.list(access, options),
      commit: changes => resource.commit(access, changes),
    };
  }

  suspend(appId: AppId, sequence: number): Promise<ResourceStatus> {
    return this.#resources.records(appId).transition('suspended', sequence);
  }

  destroy(appId: AppId, sequence: number): Promise<ResourceStatus> {
    return this.#resources.records(appId).transition('purged', sequence);
  }
}
