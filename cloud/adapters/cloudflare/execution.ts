/// <reference types="@cloudflare/workers-types" />
import { RpcTarget, type WorkerEntrypoint } from 'cloudflare:workers';
import type { AppId } from '../../../shared/values.ts';
import { CloudError, invalid } from '../../core/errors.ts';
import { sha256 } from '../../core/crypto.ts';
import type { Artifact, ExecutionHost, Invocation, Limits, PreparedArtifact } from '../../core/model.ts';
import type { RecordChange, RecordList, Records } from '../../core/records-contract.ts';
import { runWithDeadline } from '../../core/runtime.ts';

const COMPATIBILITY_DATE = '2026-11-11';
const WRAPPER_VERSION = 'pneuma-space.fetch/1-wrapper-1';
const WRAPPER = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import application from './app.mjs';
export default class extends WorkerEntrypoint {
  check() {
    if (!application || typeof application.fetch !== 'function') {
      throw new Error('Module must default-export an object with fetch(request, app).');
    }
    return true;
  }
  async run(input, records) {
    this.check();
    const request = new Request(input.url, { method: input.method, headers: input.headers, body: input.body });
    const app = { ...this.ctx.props.app };
    if (records) {
      app.records = {
        async get(key) { return JSON.parse(await records.get(key)); },
        async list(options) { return JSON.parse(await records.list(JSON.stringify(options ?? {}))); },
        async commit(changes) { return JSON.parse(await records.commit(JSON.stringify(changes))); }
      };
    }
    return application.fetch(request, app);
  }
};`;
class RecordsTarget extends RpcTarget {
  readonly #records: Records;
  readonly #inputLimit: number;

  constructor(records: Records, limits: Limits) {
    super();
    this.#records = records;
    this.#inputLimit = Math.min(limits.records.totalBytes, limits.records.valueBytes * limits.records.batch)
      + limits.records.batch * 1024;
  }

  async get(key: string) { return JSON.stringify(await this.#records.get(key)); }
  async list(options: string) {
    if (typeof options !== 'string' || options.length > 2048) invalid('Invalid records page input.');
    return JSON.stringify(await this.#records.list(JSON.parse(options) as RecordList));
  }
  async commit(changes: string) {
    if (typeof changes !== 'string' || changes.length > this.#inputLimit) invalid('Records batch exceeds the input limit.');
    return JSON.stringify(await this.#records.commit(JSON.parse(changes) as RecordChange[]));
  }
}

type HostedEntrypoint = WorkerEntrypoint & {
  check(): Promise<boolean>;
  run(input: { url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }, records: RecordsTarget | null): Promise<Response>;
};

export class CloudflareExecutionHost implements ExecutionHost {
  readonly #loader: WorkerLoader;
  readonly #limits: Limits;

  constructor(loader: WorkerLoader, limits: Limits) {
    this.#loader = loader;
    this.#limits = limits;
  }

  async #worker(appId: AppId, digest: string, artifact: Artifact): Promise<WorkerStub> {
    const cpuMs = this.#limits.cpuMs;
    const subRequests = this.#limits.recordOperations + 5;
    const configuration = await sha256(JSON.stringify({
      version: WRAPPER_VERSION, wrapper: WRAPPER, compatibilityDate: COMPATIBILITY_DATE, cpuMs, subRequests,
    }));
    const key = `${appId}:${digest}:${configuration}`;
    return this.#loader.get(key, () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: 'wrapper.mjs',
      modules: { 'wrapper.mjs': { js: WRAPPER }, 'app.mjs': { js: artifact.source } },
      env: {},
      globalOutbound: null,
      limits: { cpuMs, subRequests },
    }));
  }

  async prepare(appId: AppId, prepared: PreparedArtifact): Promise<void> {
    const worker = await this.#worker(appId, prepared.digest, prepared.artifact);
    try {
      const valid = await runWithDeadline(worker.getEntrypoint<HostedEntrypoint>(undefined, {
        props: {}, limits: { cpuMs: this.#limits.cpuMs, subRequests: 0 },
      }).check(), this.#limits.deadlineMs);
      if (!valid) throw new CloudError(400, 'invalid_module', 'Application preparation failed.');
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError(400, 'invalid_module', 'Application preparation failed.');
    }
  }

  async invoke(invocation: Invocation, artifact: Artifact, request: Request, records: Records | null): Promise<Response> {
    const app = { id: invocation.appId, name: invocation.name, release: invocation.release.number,
      ...(artifact.manifest.capabilities.identity ? { identity: invocation.identity } : {}) };
    const worker = await this.#worker(invocation.appId, invocation.release.digest, artifact);
    const input = { url: request.url, method: request.method, headers: Array.from(request.headers.entries()),
      body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer() };
    return worker.getEntrypoint<HostedEntrypoint>(undefined, {
      props: { app },
      limits: { cpuMs: this.#limits.cpuMs, subRequests: this.#limits.recordOperations + 5 },
    }).run(input, artifact.manifest.capabilities.records && records ? new RecordsTarget(records, this.#limits) : null);
  }
}
