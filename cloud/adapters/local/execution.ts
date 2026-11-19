import type { AppId } from '../../../shared/values.ts';
import { CloudError } from '../../core/errors.ts';
import { DEFAULT_LIMITS, type AppContext, type Artifact, type ExecutionHost, type Invocation, type PreparedArtifact } from '../../core/model.ts';
import type { Records } from '../../core/records-contract.ts';
import { runWithDeadline } from '../../core/runtime.ts';

type AppModule = { default: { fetch(request: Request, app: AppContext): Response | Promise<Response> } };

function appModule(value: unknown): AppModule {
  if (typeof value !== 'object' || value === null || !('default' in value)
    || typeof value.default !== 'object' || value.default === null || !('fetch' in value.default)
    || typeof value.default.fetch !== 'function') {
    throw new CloudError(400, 'invalid_module', 'Module must default-export an object with fetch(request, app).');
  }
  return value as AppModule;
}

export class LocalExecutionHost implements ExecutionHost {
  async #module(appId: AppId, digest: string, artifact: Artifact): Promise<AppModule> {
    const source = Buffer.from(artifact.source).toString('base64');
    return appModule(await import(`data:text/javascript;base64,${source}#${encodeURIComponent(appId)}-${digest}`));
  }

  async prepare(appId: AppId, prepared: PreparedArtifact): Promise<void> {
    await runWithDeadline(this.#module(appId, prepared.digest, prepared.artifact), DEFAULT_LIMITS.deadlineMs);
  }

  async invoke(invocation: Invocation, artifact: Artifact, request: Request, records: Records | null): Promise<Response> {
    const module = await this.#module(invocation.appId, invocation.release.digest, artifact);
    const app: AppContext = { id: invocation.appId, name: invocation.name, release: invocation.release.number };
    if (artifact.manifest.capabilities.identity) app.identity = { ...invocation.identity };
    if (artifact.manifest.capabilities.records && records) app.records = records;
    return module.default.fetch(request, app);
  }
}
