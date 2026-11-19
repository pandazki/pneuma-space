/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import { InputError, type AppId, type TenantName } from '../../../shared/values.ts';
import { Accounts, SignupCapacity, initialAccountsState, initialSignupCapacityState } from '../../core/accounts.ts';
import { productionConfig, type CloudConfig } from '../../core/config.ts';
import { sha256 } from '../../core/crypto.ts';
import { CloudError, conflict, invalid } from '../../core/errors.ts';
import type { CreatedSession, VerifiedIdentity } from '../../core/identity-contract.ts';
import type { Invocation, PersonalAccount, ResourceDirectory } from '../../core/model.ts';
import { SqlRecordsResource } from '../../core/records.ts';
import type { RecordChange, RecordCommit, RecordEntry, RecordList, RecordPage, RecordsAccess, RecordsResource, RecordsSnapshot, ResourceMode, ResourceStatus } from '../../core/records-contract.ts';
import { Registry, initialRegistryState } from '../../core/registry.ts';
import { FetchRuntime, readBoundedBody } from '../../core/runtime.ts';
import { Sessions, initialSessionsState } from '../../core/sessions.ts';
import { SqlState } from '../../core/state.ts';
import type { CloudBackend } from '../../http/router.ts';
import { errorResponse } from '../../http/security.ts';
import { TenantHttp, type TenantEndpoint } from '../../http/tenant.ts';
import { R2Artifacts } from './artifacts.ts';
import { CloudflareExecutionHost } from './execution.ts';
import { DurableSqlDatabase } from './sql.ts';

function boundaryError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  if (error instanceof InputError) return new CloudError(400, 'invalid_input', error.message);
  return new CloudError(500, 'internal_error', 'The request could not be completed.');
}

async function result(operation: () => unknown | Promise<unknown>): Promise<string> {
  try { return JSON.stringify({ ok: true, value: await operation() }); }
  catch (error) {
    const failure = boundaryError(error);
    return JSON.stringify({ ok: false, status: failure.status, code: failure.code, message: failure.message });
  }
}

function value<T>(serialized: string): T {
  const outcome: unknown = JSON.parse(serialized);
  if (!outcome || typeof outcome !== 'object' || !('ok' in outcome)) throw new Error('Invalid platform RPC response.');
  if (outcome.ok === true) return ('value' in outcome ? outcome.value : undefined) as T;
  if (outcome.ok === false && 'status' in outcome && typeof outcome.status === 'number'
    && 'code' in outcome && typeof outcome.code === 'string' && 'message' in outcome && typeof outcome.message === 'string') {
    throw new CloudError(outcome.status, outcome.code, outcome.message);
  }
  throw new Error('Invalid platform RPC response.');
}

type WireRequest = { url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null };

async function requestData(request: Request, config: CloudConfig, includeBody = true): Promise<WireRequest> {
  const limit = config.limits.artifactBytes + config.limits.records.totalBytes * 2 + 256 * 1024;
  const body = !includeBody || ['GET', 'HEAD'].includes(request.method) ? null : await readBoundedBody(request.body, limit, request.signal);
  return { url: request.url, method: request.method, headers: Array.from(request.headers.entries()), body: body?.buffer ?? null };
}

function fromRequestData(input: WireRequest): Request {
  return new Request(input.url, { method: input.method, headers: input.headers, body: input.body });
}

export class CapacityObject extends DurableObject<CloudflareEnv> {
  readonly #capacity: SignupCapacity;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    const config = productionConfig({ ...env });
    this.#capacity = new SignupCapacity({ state: new SqlState(new DurableSqlDatabase(ctx.storage), 'capacity', initialSignupCapacityState), limit: config.limits.accounts });
  }

  reserve(signupId: string): Promise<string> { return result(() => this.#capacity.reserve(signupId)); }
}

export class AccountsObject extends DurableObject<CloudflareEnv> {
  readonly #accounts: Accounts;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.#accounts = new Accounts({
      state: new SqlState(new DurableSqlDatabase(ctx.storage), 'accounts', initialAccountsState),
      capacity: { reserve: async signupId => { value<void>(await this.env.PNEUMA_SPACE_CAPACITY.getByName('signup').reserve(signupId)); } },
      ensureOwner: async account => {
        value<void>(await this.env.PNEUMA_SPACE_TENANTS.getByName(account.tenant).ensureOwner(account.tenant, JSON.stringify(account)));
      },
    });
  }

  register(identity: VerifiedIdentity): Promise<string> { return result(() => this.#accounts.register(identity)); }
}

type ArtifactIndexState = { purged: boolean; digests: string[] };

export class ArtifactIndexObject extends DurableObject<CloudflareEnv> {
  readonly #state: SqlState<ArtifactIndexState>;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.#state = new SqlState(new DurableSqlDatabase(ctx.storage), 'artifacts', () => ({ purged: false, digests: [] }));
  }

  reserve(digest: string): Promise<string> {
    return result(() => {
      if (!/^[a-f0-9]{64}$/.test(digest)) invalid('Invalid artifact digest.');
      this.#state.update(state => {
        if (state.purged) conflict('The application has been purged.');
        if (!state.digests.includes(digest)) state.digests.push(digest);
      });
    });
  }

  purge(): Promise<string> {
    return result(() => this.#state.update(state => { state.purged = true; return [...state.digests]; }));
  }
}

export class TenantObject extends DurableObject<CloudflareEnv> {
  readonly #database: DurableSqlDatabase;
  readonly #config: CloudConfig;
  #http: TenantHttp | null = null;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.#database = new DurableSqlDatabase(ctx.storage);
    this.#config = productionConfig({ ...env });
  }

  #endpoint(tenant: TenantName): TenantHttp {
    if (!this.ctx.id.equals(this.env.PNEUMA_SPACE_TENANTS.idFromName(tenant))) throw new Error('Tenant storage locator mismatch.');
    if (!this.#http) {
      const backend = new CloudflareBackend(this.env, this.#config);
      const sessions = new Sessions({ state: new SqlState(this.#database, 'sessions', initialSessionsState), tenant,
        controlOrigin: this.#config.controlOrigin, maxSessions: this.#config.limits.sessions });
      const registry = new Registry({ state: new SqlState(this.#database, 'registry', initialRegistryState), artifacts: backend.artifacts,
        execution: new CloudflareExecutionHost(this.env.PNEUMA_SPACE_LOADER, this.#config.limits), resources: backend,
        limits: this.#config.limits, sessionActive: (hash, userId) => sessions.isActive(hash, userId) });
      this.#http = new TenantHttp(tenant, registry, sessions, this.#config);
    }
    return this.#http;
  }

  ensureOwner(tenant: TenantName, account: string): Promise<string> {
    return result(() => this.#endpoint(tenant).ensureOwner(JSON.parse(account) as PersonalAccount));
  }

  createSession(tenant: TenantName, account: string): Promise<string> {
    return result(() => this.#endpoint(tenant).createSession(JSON.parse(account) as PersonalAccount));
  }

  async control(tenant: TenantName, input: WireRequest): Promise<Response> {
    try { return await this.#endpoint(tenant).control(fromRequestData(input)); }
    catch (error) { return errorResponse(boundaryError(error)); }
  }

  async admit(tenant: TenantName, input: WireRequest, name: string): Promise<string | Response> {
    try {
      const admission = await this.#endpoint(tenant).admit(fromRequestData(input), name);
      return admission instanceof Response ? admission : JSON.stringify(admission);
    } catch (error) { return errorResponse(boundaryError(error)); }
  }
}

export class RecordsObject extends DurableObject<CloudflareEnv> {
  readonly #records: SqlRecordsResource;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.#records = new SqlRecordsResource(new DurableSqlDatabase(ctx.storage), productionConfig({ ...env }).limits.records);
  }

  transition(mode: ResourceMode, sequence: number): Promise<string> { return result(() => this.#records.transition(mode, sequence)); }
  status(): Promise<string> { return result(() => this.#records.status()); }
  get(access: RecordsAccess, key: string): Promise<string> { return result(() => this.#records.get(access, key)); }
  list(access: RecordsAccess, options: string): Promise<string> { return result(() => this.#records.list(access, JSON.parse(options) as RecordList)); }
  commit(access: RecordsAccess, changes: string): Promise<string> { return result(() => this.#records.commit(access, JSON.parse(changes) as RecordChange[])); }
  export(): Promise<string> { return result(() => this.#records.export()); }
  restore(snapshot: string, importKey: string): Promise<string> { return result(() => this.#records.restore(JSON.parse(snapshot) as RecordsSnapshot, importKey)); }
}

export class CloudflareBackend implements CloudBackend, ResourceDirectory {
  readonly artifacts: R2Artifacts;
  readonly runtime: FetchRuntime;
  readonly #env: CloudflareEnv;
  readonly #config: CloudConfig;

  constructor(env: CloudflareEnv, config: CloudConfig) {
    this.#env = env; this.#config = config;
    this.artifacts = new R2Artifacts(env.PNEUMA_SPACE_ARTIFACTS, config.limits.artifactBytes, {
      reserve: async (appId, digest) => { value<void>(await env.PNEUMA_SPACE_ARTIFACT_INDEX.getByName(appId).reserve(digest)); },
      purge: async appId => value<string[]>(await env.PNEUMA_SPACE_ARTIFACT_INDEX.getByName(appId).purge()),
    });
    this.runtime = new FetchRuntime({ host: new CloudflareExecutionHost(env.PNEUMA_SPACE_LOADER, config.limits),
      artifacts: this.artifacts, resources: this, limits: config.limits });
  }

  tenant(tenant: TenantName): TenantEndpoint {
    const stub = this.#env.PNEUMA_SPACE_TENANTS.getByName(tenant);
    return {
      ensureOwner: async account => { value<void>(await stub.ensureOwner(tenant, JSON.stringify(account))); },
      createSession: async account => value<CreatedSession>(await stub.createSession(tenant, JSON.stringify(account))),
      control: async request => {
        const response = await stub.control(tenant, await requestData(request, this.#config));
        if (response.status === 401 && new URL(request.url).pathname === '/auth/app') throw new CloudError(401, 'unauthorized', 'Sign in to continue.');
        return response;
      },
      admit: async (request, name) => {
        const admission = await stub.admit(tenant, await requestData(request, this.#config, false), name);
        return typeof admission === 'string' ? JSON.parse(admission) as Invocation : admission;
      },
    };
  }

  async register(identity: VerifiedIdentity): Promise<PersonalAccount> {
    const key = await sha256(JSON.stringify([identity.provider, identity.subject]));
    return value<PersonalAccount>(await this.#env.PNEUMA_SPACE_ACCOUNTS.getByName(key).register(identity));
  }

  records(appId: AppId): RecordsResource {
    const stub = this.#env.PNEUMA_SPACE_RECORDS.getByName(appId);
    return {
      transition: async (mode, sequence) => value<ResourceStatus>(await stub.transition(mode, sequence)),
      status: async () => value<ResourceStatus>(await stub.status()),
      get: async (access, key) => value<RecordEntry | null>(await stub.get(access, key)),
      list: async (access, options) => value<RecordPage>(await stub.list(access, JSON.stringify(options ?? {}))),
      commit: async (access, changes) => value<RecordCommit>(await stub.commit(access, JSON.stringify(changes))),
      export: async () => value<RecordsSnapshot>(await stub.export()),
      restore: async (snapshot, importKey) => { value<void>(await stub.restore(JSON.stringify(snapshot), importKey)); },
    };
  }
}
