import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppId, TenantName } from '../../../shared/values.ts';
import { Accounts, SignupCapacity, initialAccountsState, initialSignupCapacityState } from '../../core/accounts.ts';
import type { CloudConfig } from '../../core/config.ts';
import { sha256 } from '../../core/crypto.ts';
import type { VerifiedIdentity } from '../../core/identity-contract.ts';
import type { PersonalAccount, ResourceDirectory } from '../../core/model.ts';
import { SqlRecordsResource } from '../../core/records.ts';
import type { RecordsResource } from '../../core/records-contract.ts';
import { Registry, initialRegistryState } from '../../core/registry.ts';
import { FetchRuntime } from '../../core/runtime.ts';
import { Sessions, initialSessionsState } from '../../core/sessions.ts';
import { SqlState } from '../../core/state.ts';
import type { CloudBackend } from '../../http/router.ts';
import { TenantHttp, type TenantEndpoint } from '../../http/tenant.ts';
import { LocalArtifacts } from './artifacts.ts';
import { LocalExecutionHost } from './execution.ts';
import { LocalSqliteDatabase } from './sqlite.ts';

export class LocalBackend implements CloudBackend, ResourceDirectory {
  readonly artifacts: LocalArtifacts;
  readonly runtime: FetchRuntime;
  readonly #execution: LocalExecutionHost;
  readonly #root: string;
  readonly #config: CloudConfig;
  readonly #databases = new Map<string, LocalSqliteDatabase>();
  readonly #tenants = new Map<TenantName, TenantHttp>();
  readonly #records = new Map<AppId, RecordsResource>();
  readonly #capacity: SignupCapacity;

  constructor(directory: string, config: CloudConfig) {
    this.#root = directory;
    this.#config = config;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.artifacts = new LocalArtifacts(join(directory, 'artifacts'));
    this.#execution = new LocalExecutionHost();
    this.runtime = new FetchRuntime({ host: this.#execution, artifacts: this.artifacts, resources: this, limits: config.limits });
    this.#capacity = new SignupCapacity({ state: new SqlState(this.#database('capacity'), 'capacity', initialSignupCapacityState), limit: config.limits.accounts });
  }

  #database(key: string): LocalSqliteDatabase {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(key)) throw new Error('Invalid local storage key.');
    let database = this.#databases.get(key);
    if (!database) { database = new LocalSqliteDatabase(join(this.#root, key + '.sqlite')); this.#databases.set(key, database); }
    return database;
  }

  tenant(name: TenantName): TenantEndpoint {
    let endpoint = this.#tenants.get(name);
    if (!endpoint) {
      const database = this.#database('tenant-' + name);
      const sessions = new Sessions({ state: new SqlState(database, 'sessions', initialSessionsState), tenant: name,
        controlOrigin: this.#config.controlOrigin, maxSessions: this.#config.limits.sessions });
      const registry = new Registry({ state: new SqlState(database, 'registry', initialRegistryState), artifacts: this.artifacts,
        execution: this.#execution, resources: this, limits: this.#config.limits, sessionActive: (hash, userId) => sessions.isActive(hash, userId) });
      endpoint = new TenantHttp(name, registry, sessions, this.#config);
      this.#tenants.set(name, endpoint);
    }
    return endpoint;
  }

  records(appId: AppId): RecordsResource {
    let resource = this.#records.get(appId);
    if (!resource) { resource = new SqlRecordsResource(this.#database('records-' + appId), this.#config.limits.records); this.#records.set(appId, resource); }
    return resource;
  }

  async register(identity: VerifiedIdentity): Promise<PersonalAccount> {
    const key = await sha256(JSON.stringify([identity.provider, identity.subject]));
    const accounts = new Accounts({ state: new SqlState(this.#database('identity-' + key), 'identity', initialAccountsState), capacity: this.#capacity,
      ensureOwner: account => this.tenant(account.tenant).ensureOwner(account) });
    return accounts.register(identity);
  }

  close(): void { for (const database of this.#databases.values()) database.close(); this.#databases.clear(); this.artifacts.close(); }
}
