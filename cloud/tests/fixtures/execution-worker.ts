/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import { CloudflareExecutionHost } from '../../adapters/cloudflare/execution.ts';
import { FetchRuntime } from '../../core/runtime.ts';
import { SqlRecordsResource } from '../../core/records.ts';
import { DEFAULT_LIMITS, type ArtifactStore, type Invocation, type PreparedArtifact, type ResourceDirectory } from '../../core/model.ts';
import type { RecordEntry, RecordPage, RecordCommit, RecordsAccess, RecordChange, RecordList, RecordsSnapshot, ResourceMode } from '../../core/records-contract.ts';
import type { SqlDatabase, SqlRow, SqlValue } from '../../core/sql.ts';
import type { AppId } from '../../../shared/values.ts';

type Env = { PNEUMA_SPACE_LOADER: WorkerLoader; PNEUMA_SPACE_DATA: DurableObjectNamespace<RecordsDO>; PNEUMA_SPACE_ARTIFACTS: R2Bucket };

export class RecordsDO extends DurableObject<Env> {
  readonly #records: SqlRecordsResource;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const database: SqlDatabase = {
      query: (sql: string, ...bindings: SqlValue[]): SqlRow[] => Array.from(ctx.storage.sql.exec(sql, ...bindings), row =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof ArrayBuffer ? new Uint8Array(value) : value]))),
      transaction: operation => ctx.storage.transactionSync(operation),
    };
    this.#records = new SqlRecordsResource(database, DEFAULT_LIMITS.records);
  }
  status() { return this.#records.status(); }
  transition(mode: ResourceMode, sequence: number) { return this.#records.transition(mode, sequence); }
  async get(access: RecordsAccess, key: string) { return JSON.stringify(await this.#records.get(access, key)); }
  async list(access: RecordsAccess, options?: RecordList) { return JSON.stringify(await this.#records.list(access, options)); }
  async commit(access: RecordsAccess, changes: string) { return JSON.stringify(await this.#records.commit(access, JSON.parse(changes) as RecordChange[])); }
  async export() { return JSON.stringify(await this.#records.export()); }
  restore(snapshot: string, key: string) { return this.#records.restore(JSON.parse(snapshot) as RecordsSnapshot, key); }
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      const url = new URL(request.url);
      const appId = url.pathname.split('/')[2] as AppId;
      const limits = { ...DEFAULT_LIMITS,
        requestBytes: Number(url.searchParams.get('requestBytes') ?? DEFAULT_LIMITS.requestBytes),
        responseBytes: Number(url.searchParams.get('responseBytes') ?? DEFAULT_LIMITS.responseBytes),
        deadlineMs: Number(url.searchParams.get('deadlineMs') ?? DEFAULT_LIMITS.deadlineMs),
        recordOperations: Number(url.searchParams.get('recordOperations') ?? DEFAULT_LIMITS.recordOperations),
      };
      const host = new CloudflareExecutionHost(env.PNEUMA_SPACE_LOADER, limits);
      const artifacts: ArtifactStore = {
        async put(id, prepared) { await env.PNEUMA_SPACE_ARTIFACTS.put(id, JSON.stringify(prepared)); },
        async get(id) {
          const object = await env.PNEUMA_SPACE_ARTIFACTS.get(id);
          if (!object) throw new Error('Missing fixture artifact.');
          return (await object.json<PreparedArtifact>()).artifact;
        },
        async destroy(id) { await env.PNEUMA_SPACE_ARTIFACTS.delete(id); },
      };
      const resource = env.PNEUMA_SPACE_DATA.getByName(appId);
      if (url.pathname.startsWith('/install/')) {
        const prepared = await request.json<PreparedArtifact>();
        await host.prepare(appId, prepared);
        await artifacts.put(appId, prepared);
        await resource.transition('active', 1);
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith('/suspend/')) return Response.json(await resource.transition('suspended', 2));
      if (url.pathname.startsWith('/resume/')) return Response.json(await resource.transition('active', 3));
      if (url.pathname.startsWith('/status/')) return Response.json(await resource.status());
      const stored = await env.PNEUMA_SPACE_ARTIFACTS.get(appId);
      if (!stored) return new Response('Missing', { status: 404 });
      const prepared = await stored.json<PreparedArtifact>();
      const status = await resource.status();
      const invocation: Invocation = {
        appId, name: 'counter' as Invocation['name'],
        release: { number: 1, digest: prepared.digest, bytes: prepared.bytes, manifest: prepared.artifact.manifest, createdAt: 0 },
        identity: { subject: 'user:fixture', name: request.headers.get('X-Test-Identity') ?? 'first', owner: 'user:fixture' },
        expiresAt: Date.now() + limits.deadlineMs,
        records: { epoch: status.epoch, expiresAt: Date.now() + limits.deadlineMs },
      };
      const resources: ResourceDirectory = { records: () => ({
        status: () => resource.status(), transition: (mode, sequence) => resource.transition(mode, sequence),
        get: async (access, key) => JSON.parse(await resource.get(access, key)) as RecordEntry | null,
        list: async (access, options) => JSON.parse(await resource.list(access, options)) as RecordPage,
        commit: async (access, changes) => JSON.parse(await resource.commit(access, JSON.stringify(changes))) as RecordCommit,
        export: async () => JSON.parse(await resource.export()) as RecordsSnapshot,
        restore: (snapshot, key) => resource.restore(JSON.stringify(snapshot), key),
      }) };
      return await new FetchRuntime({ host, artifacts, resources, limits }).acquire(invocation).fetch(request);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500;
      return Response.json({ error: String(error) }, { status });
    }
  },
};
