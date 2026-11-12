/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import { CloudflareBackend } from '../../adapters/cloudflare/backend.ts';
import { R2Artifacts } from '../../adapters/cloudflare/artifacts.ts';
import { productionConfig } from '../../core/config.ts';
import { prepareArtifact } from '../../core/artifacts.ts';
import type { AppId } from '../../../shared/values.ts';
import { createRouter } from '../../http/router.ts';
import { errorResponse } from '../../http/security.ts';

export { AccountsObject, CapacityObject, TenantObject, RecordsObject, ArtifactIndexObject } from '../../adapters/cloudflare/backend.ts';

type TestEnv = CloudflareEnv & { PNEUMA_SPACE_TEST_GATE: DurableObjectNamespace<ArtifactGate> };

export class ArtifactGate extends DurableObject<TestEnv> {
  #started = false;
  #ready: (() => void)[] = [];
  #release: (() => void) | null = null;

  async pause(): Promise<void> {
    this.#started = true;
    for (const ready of this.#ready) ready();
    this.#ready = [];
    await new Promise<void>(resolve => { this.#release = resolve; });
  }

  async ready(): Promise<void> {
    if (!this.#started) await new Promise<void>(resolve => { this.#ready.push(resolve); });
  }

  release(): void { this.#release?.(); }
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    try {
      const config = productionConfig({ ...env });
      const backend = new CloudflareBackend(env, config);
      const url = new URL(request.url);
      if (request.headers.get('x-test-navigation') === 'true') {
        const headers = new Headers(request.headers);
        headers.delete('x-test-navigation');
        headers.set('sec-fetch-mode', 'navigate');
        request = new Request(request, { headers });
      }
      if (url.pathname === '/__test/race-ready' || url.pathname === '/__test/race-release') {
        const gate = env.PNEUMA_SPACE_TEST_GATE.getByName('artifact');
        if (url.pathname.endsWith('ready')) await gate.ready(); else await gate.release();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__test/race-put') {
        const appId = url.searchParams.get('appId') as AppId;
        const store = new R2Artifacts(env.PNEUMA_SPACE_ARTIFACTS, config.limits.artifactBytes, {
          reserve: async (_appId, digest) => {
            const outcome = JSON.parse(await env.PNEUMA_SPACE_ARTIFACT_INDEX.getByName(appId).reserve(digest));
            if (!outcome.ok) throw new Error('Artifact reservation failed.');
            await env.PNEUMA_SPACE_TEST_GATE.getByName('artifact').pause();
          },
          purge: async () => [],
        });
        await store.put(appId, await prepareArtifact(await request.json(), config.limits));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__test/partial-purge') {
        const appId = url.searchParams.get('appId') as AppId;
        await backend.records(appId).transition('purged', 4);
        const outcome = JSON.parse(await env.PNEUMA_SPACE_ARTIFACT_INDEX.getByName(appId).purge());
        if (!outcome.ok) throw new Error('Artifact fence failed.');
        await env.PNEUMA_SPACE_ARTIFACTS.put(`purged/${appId}`, '1');
        await env.PNEUMA_SPACE_ARTIFACTS.put(`apps/${appId}/${outcome.value[0]}.json`, '', { customMetadata: { pneuma_space_purged: '1' } });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__test/late-artifact') {
        const appId = url.searchParams.get('appId') as AppId;
        await backend.artifacts.put(appId, await prepareArtifact(await request.json(), config.limits));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__test/late-resume') {
        const appId = url.searchParams.get('appId') as AppId;
        await backend.records(appId).transition('active', 1000);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__test/register') {
        const name = url.searchParams.get('name') ?? 'test';
        const account = await backend.register({ provider: 'test', subject: name, name });
        const session = await backend.tenant(account.tenant).createSession(account);
        return Response.json({ account, credential: session.credential, csrf: session.csrf });
      }
      return createRouter({ config, backend, consoleHtml: '<!doctype html><title>PneumaSpace test</title>', identity: {
        async begin() { throw new Error('No external provider in this fixture.'); },
        async complete() { throw new Error('No external provider in this fixture.'); },
      } })(request);
    } catch (error) { return errorResponse(error); }
  },
};
