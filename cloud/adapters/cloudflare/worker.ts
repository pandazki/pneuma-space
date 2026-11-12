/// <reference types="@cloudflare/workers-types" />
import { GitHubIdentityProvider } from '../github.ts';
import { productionConfig } from '../../core/config.ts';
import { createRouter } from '../../http/router.ts';
import { errorResponse } from '../../http/security.ts';
import consoleHtml from '../../http/console.html';
import { CloudflareBackend } from './backend.ts';

export { AccountsObject, CapacityObject, TenantObject, RecordsObject, ArtifactIndexObject } from './backend.ts';

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    try {
      const config = productionConfig({ ...env });
      return createRouter({ config, backend: new CloudflareBackend(env, config), identity: new GitHubIdentityProvider(config.github), consoleHtml })(request);
    } catch (error) { return errorResponse(error); }
  },
};
