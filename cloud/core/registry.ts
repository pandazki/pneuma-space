import { appName, type AppId, type AppName } from '../../shared/values.ts';
import { randomSecret, sha256 } from './crypto.ts';
import { CloudError, conflict, forbidden, invalid, missing, quota } from './errors.ts';
import { ACTIONS, type Action, type Actor, type Artifact, type ArtifactStore, type ExecutionHost,
  type Invocation, type Limits, type PersonalAccount, type PreparedArtifact, type Release,
  type ResourceDirectory } from './model.ts';
import { RecordsProvider } from './providers.ts';
import { validateRecordsSnapshot } from './records.ts';
import type { RecordsSnapshot, ResourceStatus } from './records-contract.ts';
import type { StateStore } from './state.ts';

type Lifecycle = { kind: 'active' } | { kind: 'removed'; suspended: boolean }
  | { kind: 'purging'; stage: 'records' | 'artifacts' };
type StoredApp = {
  id: AppId;
  name: AppName;
  sequence: number;
  lifecycle: Lifecycle;
  releases: Release[];
  current: Release | null;
  binding: ResourceStatus | null;
  pending: string | null;
};
type Publication = {
  kind: 'publish' | 'import';
  key: string;
  appId: AppId;
  name: AppName;
  digest: string;
  fingerprint: string;
  bytes: number;
  sequence: number;
  actor: Actor;
  state: { kind: 'preparing' } | { kind: 'failed'; message: string }
    | { kind: 'superseded' } | { kind: 'active'; release: Release };
};
export type TokenMetadata = {
  id: string;
  label: string;
  scopes: Action[];
  appIds: AppId[] | null;
  expiresAt: number;
  createdAt: number;
  revokedAt: number | null;
};
type StoredToken = TokenMetadata & { hash: string };
export type TokenInput = Pick<TokenMetadata, 'label' | 'scopes' | 'appIds' | 'expiresAt'>;
export type AuditEntry = { at: number; actor: string; action: string; appId: AppId | null; result: string };
export type RegistryState = {
  account: PersonalAccount | null;
  apps: StoredApp[];
  tokens: StoredToken[];
  operations: Publication[];
  usage: { day: string; requests: number; publications: number };
  audit: AuditEntry[];
};
export type AppView = {
  id: AppId;
  name: AppName;
  status: 'active' | 'removed' | 'purging';
  current: Release | null;
  releases: Release[];
  pending: { key: string; status: Publication['state']['kind']; message?: string } | null;
};

export function initialRegistryState(): RegistryState {
  return { account: null, apps: [], tokens: [], operations: [], usage: { day: '', requests: 0, publications: 0 }, audit: [] };
}

function actorKey(actor: Actor): string {
  return actor.kind === 'session' ? `user:${actor.userId}` : `token:${actor.tokenHash}`;
}

function operationKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) invalid('Idempotency-Key must contain 1 to 128 safe characters.');
  return key;
}

function view(state: RegistryState, app: StoredApp): AppView {
  const operation = app.pending ? state.operations.find(item => item.key === app.pending) : undefined;
  return structuredClone({
    id: app.id, name: app.name, status: app.lifecycle.kind,
    current: app.current, releases: app.releases,
    pending: operation ? {
      key: operation.key, status: operation.state.kind,
      ...(operation.state.kind === 'failed' ? { message: operation.state.message } : {}),
    } : null,
  });
}

function tokenMetadata(token: StoredToken): TokenMetadata {
  return { id: token.id, label: token.label, scopes: [...token.scopes], appIds: token.appIds ? [...token.appIds] : null,
    expiresAt: token.expiresAt, createdAt: token.createdAt, revokedAt: token.revokedAt };
}

function artifactAllocations(state: RegistryState): Map<string, number> {
  const allocations = new Map<string, number>();
  for (const app of state.apps) for (const release of app.releases) allocations.set(`${app.id}:${release.digest}`, release.bytes);
  for (const operation of state.operations) allocations.set(`${operation.appId}:${operation.digest}`, operation.bytes);
  return allocations;
}

export class Registry {
  readonly #state: StateStore<RegistryState>;
  readonly #artifacts: ArtifactStore;
  readonly #execution: ExecutionHost;
  readonly #resources: ResourceDirectory;
  readonly #provider: RecordsProvider;
  readonly #limits: Limits;
  readonly #sessionActive: (hash: string, userId: string) => boolean;
  readonly #now: () => number;

  constructor(options: {
    state: StateStore<RegistryState>;
    artifacts: ArtifactStore;
    execution: ExecutionHost;
    resources: ResourceDirectory;
    limits: Limits;
    sessionActive: (sessionHash: string, userId: string) => boolean;
    now?: () => number;
  }) {
    this.#state = options.state;
    this.#artifacts = options.artifacts;
    this.#execution = options.execution;
    this.#resources = options.resources;
    this.#provider = new RecordsProvider(options.resources);
    this.#limits = structuredClone(options.limits);
    this.#sessionActive = options.sessionActive;
    this.#now = options.now ?? Date.now;
  }

  ensurePersonalOwner(account: PersonalAccount): PersonalAccount {
    return this.#state.update(state => {
      if (state.account && (state.account.userId !== account.userId || state.account.tenant !== account.tenant)) {
        conflict('The personal tenant already has an owner.');
      }
      if (!state.account) state.account = structuredClone(account);
      return structuredClone(state.account);
    });
  }

  #authorize(state: RegistryState, actor: Actor, action?: Action, app?: StoredApp): StoredToken | null {
    if (!state.account) forbidden();
    if (actor.kind === 'session') {
      if (actor.userId !== state.account.userId || !this.#sessionActive(actor.sessionHash, actor.userId)) forbidden('The session has expired or been revoked.');
      return null;
    }
    const token = state.tokens.find(item => item.hash === actor.tokenHash);
    if (!token || token.revokedAt !== null || token.expiresAt <= this.#now()) forbidden('The credential has expired or been revoked.');
    if (!action || !token.scopes.includes(action)) forbidden('The credential does not permit this action.');
    if (app && token.appIds !== null && !token.appIds.includes(app.id)) missing();
    return token;
  }

  #app(state: RegistryState, name: string): StoredApp {
    const app = state.apps.find(item => item.name === name);
    if (!app) missing();
    return app;
  }

  #record(state: RegistryState, actor: Actor, action: string, appId: AppId | null, result: string): void {
    state.audit.push({ at: this.#now(), actor: actor.kind === 'session' ? `user:${actor.userId}`
      : `service:${state.tokens.find(token => token.hash === actor.tokenHash)?.id ?? 'revoked'}`, action, appId, result });
    state.audit = state.audit.slice(-200);
  }

  #daily(state: RegistryState): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (state.usage.day !== day) state.usage = { day, requests: 0, publications: 0 };
  }

  list(actor: Actor): AppView[] {
    const state = this.#state.read();
    const token = this.#authorize(state, actor, 'read');
    return state.apps.filter(app => token?.appIds == null || token.appIds.includes(app.id)).map(app => view(state, app));
  }

  lookupId(name: AppName): AppId | null {
    return this.#state.read().apps.find(app => app.name === name)?.id ?? null;
  }

  get(actor: Actor, name: string): AppView {
    const state = this.#state.read();
    this.#authorize(state, actor, 'read');
    const app = this.#app(state, name);
    this.#authorize(state, actor, 'read', app);
    return view(state, app);
  }

  async publish(actor: Actor, rawName: string, prepared: PreparedArtifact, rawKey: string): Promise<Release> {
    const name = appName(rawName);
    const key = operationKey(rawKey);
    const intent = this.#state.update(state => {
      const token = this.#authorize(state, actor, 'publish');
      let app = state.apps.find(item => item.name === name);
      const previous = state.operations.find(item => item.key === key);
      if (previous) {
        if (previous.kind !== 'publish' || !app || previous.appId !== app.id || previous.name !== name || previous.digest !== prepared.digest
          || actorKey(previous.actor) !== actorKey(actor)) conflict('The idempotency key was used for a different publication.');
        this.#authorize(state, actor, 'publish', app);
        if (previous.state.kind === 'active') return { kind: 'done' as const, release: structuredClone(previous.state.release) };
        if (previous.state.kind === 'superseded' || app.sequence !== previous.sequence || app.pending !== key) conflict('The publication was superseded.');
        this.#daily(state);
        if (state.usage.publications >= this.#limits.publishesPerDay) quota('Daily publication limit reached.');
        state.usage.publications++;
        if (previous.state.kind === 'failed') {
          app.sequence++;
          previous.sequence = app.sequence;
        }
        previous.state = { kind: 'preparing' };
        return { kind: 'pending' as const, operation: structuredClone(previous) };
      }
      if (app) {
        this.#authorize(state, actor, 'publish', app);
        if (app.lifecycle.kind === 'purging') conflict('The application is being purged.');
        if (app.pending) conflict('Another publication is pending. Retry its idempotency key or remove the application.');
        if (app.lifecycle.kind === 'active' && app.current?.digest === prepared.digest) {
          if (state.operations.length >= 500) quota('Publication history limit reached. Purge an unused removed application.');
          state.operations.push({ kind: 'publish', key, appId: app.id, name, digest: prepared.digest, fingerprint: prepared.digest,
            bytes: prepared.bytes, sequence: app.sequence, actor: structuredClone(actor), state: { kind: 'active', release: structuredClone(app.current) } });
          return { kind: 'done' as const, release: structuredClone(app.current) };
        }
      } else {
        if (token?.appIds !== null && token?.appIds !== undefined) forbidden('An app-scoped credential cannot create applications.');
        if (state.apps.length >= this.#limits.apps) quota('Application limit reached.');
        app = { id: crypto.randomUUID() as AppId, name, sequence: 0, lifecycle: { kind: 'removed', suspended: true },
          releases: [], current: null, binding: null, pending: null };
        state.apps.push(app);
      }
      this.#daily(state);
      if (state.usage.publications >= this.#limits.publishesPerDay) quota('Daily publication limit reached.');
      if (state.operations.length >= 500) quota('Publication history limit reached. Purge an unused removed application.');
      if (prepared.bytes > this.#limits.artifactBytes) quota('Artifact exceeds the byte limit.');
      const allocations = artifactAllocations(state);
      allocations.set(`${app.id}:${prepared.digest}`, prepared.bytes);
      if ([...allocations.values()].reduce((sum, bytes) => sum + bytes, 0) > this.#limits.tenantArtifactBytes) quota('Tenant artifact limit reached.');
      state.usage.publications++;
      app.sequence++;
      app.pending = key;
      const operation: Publication = { kind: 'publish', key, appId: app.id, name, digest: prepared.digest, fingerprint: prepared.digest, bytes: prepared.bytes,
        sequence: app.sequence, actor: structuredClone(actor), state: { kind: 'preparing' } };
      state.operations.push(operation);
      this.#record(state, actor, 'publish', app.id, 'preparing');
      return { kind: 'pending' as const, operation: structuredClone(operation) };
    });
    if (intent.kind === 'done') return intent.release;
    const operation = intent.operation;
    try {
      await this.#artifacts.put(operation.appId, prepared);
      await this.#execution.prepare(operation.appId, prepared);
      const prior = this.#state.read().apps.find(app => app.id === operation.appId);
      const needsActive = !!prepared.artifact.manifest.capabilities.records || prior?.lifecycle.kind === 'active' && prior.binding?.mode === 'active';
      const binding = needsActive
        ? await this.#provider.ensure(operation.appId, operation.sequence)
        : await this.#provider.suspend(operation.appId, operation.sequence);
      return this.#state.update(state => {
        const currentOperation = state.operations.find(item => item.key === key);
        const app = state.apps.find(item => item.id === operation.appId);
        if (!currentOperation || !app) conflict('The publication was superseded.');
        if (currentOperation.state.kind === 'active') {
          this.#authorize(state, actor, 'publish', app);
          return structuredClone(currentOperation.state.release);
        }
        if (app.sequence !== operation.sequence || app.pending !== key || app.lifecycle.kind === 'purging'
          || binding.sequence !== operation.sequence
          || binding.mode !== (needsActive ? 'active' : 'suspended')) conflict('The publication was superseded.');
        this.#authorize(state, actor, 'publish', app);
        const release: Release = { number: (app.releases.at(-1)?.number ?? 0) + 1,
          digest: prepared.digest, bytes: prepared.bytes, manifest: structuredClone(prepared.artifact.manifest), createdAt: this.#now() };
        app.releases.push(release);
        app.current = release;
        app.binding = binding;
        app.pending = null;
        app.lifecycle = { kind: 'active' };
        currentOperation.state = { kind: 'active', release };
        this.#record(state, actor, 'publish', app.id, 'active');
        return structuredClone(release);
      });
    } catch (error) {
      const compensation = this.#state.update(state => {
        const app = state.apps.find(item => item.id === operation.appId);
        const failed = state.operations.find(item => item.key === key);
        if (failed?.state.kind === 'preparing') {
          failed.state = app?.sequence === operation.sequence
            ? { kind: 'failed', message: error instanceof CloudError ? error.message : 'Artifact preparation failed. Retry this publication.' }
            : { kind: 'superseded' };
          this.#record(state, actor, 'publish', operation.appId, failed.state.kind);
          if (app?.sequence === operation.sequence && app.lifecycle.kind === 'removed') {
            app.sequence++;
            failed.sequence = app.sequence;
            app.lifecycle = { kind: 'removed', suspended: false };
            return { appId: app.id, sequence: app.sequence };
          }
        }
        return null;
      });
      if (compensation) {
        try {
          const binding = await this.#provider.suspend(compensation.appId, compensation.sequence);
          this.#state.update(state => {
            const app = state.apps.find(item => item.id === compensation.appId);
            if (app?.sequence === compensation.sequence && app.lifecycle.kind === 'removed') {
              app.binding = binding;
              app.lifecycle = { kind: 'removed', suspended: binding.mode === 'suspended' && binding.sequence === compensation.sequence };
            }
          });
        } catch {}
      }
      throw error;
    }
  }

  async remove(actor: Actor, name: string): Promise<AppView> {
    const intent = this.#state.update(state => {
      this.#authorize(state, actor, 'remove');
      const app = this.#app(state, name);
      this.#authorize(state, actor, 'remove', app);
      if (app.lifecycle.kind === 'purging') conflict('The application is being purged.');
      if (app.lifecycle.kind === 'active' || app.pending) {
        app.sequence++;
        if (app.pending) {
          const pending = state.operations.find(item => item.key === app.pending);
          if (pending) pending.state = { kind: 'superseded' };
          app.pending = null;
        }
        app.lifecycle = { kind: 'removed', suspended: false };
        this.#record(state, actor, 'remove', app.id, 'removed');
      }
      return { id: app.id, sequence: app.sequence, suspended: app.lifecycle.kind === 'removed' && app.lifecycle.suspended };
    });
    if (!intent.suspended) {
      const binding = await this.#provider.suspend(intent.id, intent.sequence);
      this.#state.update(state => {
        const app = state.apps.find(item => item.id === intent.id);
        if (app?.sequence === intent.sequence && app.lifecycle.kind === 'removed') {
          if (binding.mode !== 'suspended' || binding.sequence !== intent.sequence) conflict('The removal was superseded.');
          app.binding = binding;
          app.lifecycle = { kind: 'removed', suspended: true };
        }
      });
    }
    const state = this.#state.read();
    const app = this.#app(state, name);
    this.#authorize(state, actor, 'remove', app);
    return view(state, app);
  }

  async purge(actor: Actor, name: string, confirm: string): Promise<void> {
    if (confirm !== name) invalid('Type the application name to confirm purge.');
    const intent = this.#state.update(state => {
      this.#authorize(state, actor);
      const app = this.#app(state, name);
      if (app.lifecycle.kind === 'active' || app.pending) conflict('Remove the application before purging it.');
      if (app.lifecycle.kind === 'removed') {
        if (!app.lifecycle.suspended) conflict('Wait for removal to finish before purging it.');
        app.sequence++;
        app.lifecycle = { kind: 'purging', stage: 'records' };
        this.#record(state, actor, 'purge', app.id, 'started');
      }
      return { id: app.id, sequence: app.sequence };
    });
    await this.#provider.destroy(intent.id, intent.sequence);
    this.#state.update(state => {
      const app = state.apps.find(item => item.id === intent.id);
      if (app?.lifecycle.kind === 'purging') app.lifecycle.stage = 'artifacts';
    });
    await this.#artifacts.destroy(intent.id);
    this.#state.update(state => {
      const app = state.apps.find(item => item.id === intent.id);
      if (app?.lifecycle.kind !== 'purging' || app.sequence !== intent.sequence) conflict('The purge was superseded.');
      state.apps = state.apps.filter(item => item.id !== intent.id);
      state.operations = state.operations.filter(item => item.appId !== intent.id);
      this.#record(state, actor, 'purge', intent.id, 'complete');
    });
  }

  admit(actor: Actor, name: string): Invocation {
    return this.#state.update(state => {
      this.#authorize(state, actor, 'invoke');
      const app = this.#app(state, name);
      const token = this.#authorize(state, actor, 'invoke', app);
      if (app.lifecycle.kind !== 'active' || !app.current) missing();
      this.#daily(state);
      if (state.usage.requests >= this.#limits.requestsPerDay) quota('Daily request limit reached.');
      state.usage.requests++;
      const expiresAt = this.#now() + this.#limits.deadlineMs;
      const owner = `user:${state.account?.userId}`;
      return structuredClone({ appId: app.id, name: app.name, release: app.current, expiresAt,
        identity: { subject: actor.kind === 'session' ? `user:${actor.userId}` : `service:${token?.id}`,
          name: actor.kind === 'session' ? state.account?.name ?? '' : token?.label ?? '', owner },
        records: app.current.manifest.capabilities.records && app.binding?.mode === 'active'
          ? { epoch: app.binding.epoch, expiresAt } : null });
    });
  }

  async createToken(actor: Actor, input: TokenInput): Promise<{ token: string; metadata: TokenMetadata }> {
    if (!input || typeof input.label !== 'string' || input.label.length < 1 || input.label.length > 80
      || !Array.isArray(input.scopes) || input.scopes.length === 0
      || input.scopes.some(scope => !ACTIONS.includes(scope)) || new Set(input.scopes).size !== input.scopes.length
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.#now() || input.expiresAt > this.#now() + 365 * 86_400_000
      || (input.appIds !== null && (!Array.isArray(input.appIds) || input.appIds.length === 0 || new Set(input.appIds).size !== input.appIds.length))) {
      invalid('Invalid credential label, scopes, application scope or expiry.');
    }
    const secret = randomSecret();
    const hash = await sha256(secret);
    return this.#state.update(state => {
      this.#authorize(state, actor);
      state.tokens = state.tokens.filter(token => token.expiresAt > this.#now() && token.revokedAt === null);
      if (state.tokens.length >= this.#limits.tokens) quota('Credential limit reached.');
      if (input.appIds?.some(id => !state.apps.some(app => app.id === id))) invalid('Credential application scope contains an unknown application.');
      const token: StoredToken = { id: crypto.randomUUID(), hash, label: input.label, scopes: [...input.scopes],
        appIds: input.appIds ? [...input.appIds] : null, expiresAt: input.expiresAt, createdAt: this.#now(), revokedAt: null };
      state.tokens.push(token);
      this.#record(state, actor, 'token.create', null, token.id);
      return { token: `ps1.${state.account?.tenant}.${secret}`, metadata: tokenMetadata(token) };
    });
  }

  listTokens(actor: Actor): TokenMetadata[] {
    const state = this.#state.read();
    this.#authorize(state, actor);
    return state.tokens.map(tokenMetadata);
  }

  revokeToken(actor: Actor, id: string): void {
    this.#state.update(state => {
      this.#authorize(state, actor);
      const token = state.tokens.find(item => item.id === id);
      if (!token) missing();
      if (token.revokedAt === null) {
        token.revokedAt = this.#now();
        this.#record(state, actor, 'token.revoke', null, id);
      }
    });
  }

  usage(actor: Actor): { day: string; requests: number; publications: number; apps: number; artifactBytes: number } {
    return this.#state.update(state => {
      this.#authorize(state, actor);
      this.#daily(state);
      const allocations = artifactAllocations(state);
      return { ...state.usage, apps: state.apps.length, artifactBytes: [...allocations.values()].reduce((sum, bytes) => sum + bytes, 0) };
    });
  }

  audit(actor: Actor): AuditEntry[] {
    const state = this.#state.read();
    this.#authorize(state, actor);
    return structuredClone(state.audit);
  }

  async exportApp(actor: Actor, name: string): Promise<{ artifact: Artifact; records: RecordsSnapshot }> {
    const intent = this.#state.update(state => {
      this.#authorize(state, actor, 'export');
      const app = this.#app(state, name);
      this.#authorize(state, actor, 'export', app);
      if (app.lifecycle.kind !== 'removed' || !app.lifecycle.suspended || app.pending || !app.current) conflict('Export requires a fully removed application.');
      return { id: app.id, sequence: app.sequence, digest: app.current.digest };
    });
    const artifact = await this.#artifacts.get(intent.id, intent.digest);
    const records = await this.#resources.records(intent.id).export();
    this.#state.update(state => {
      const app = this.#app(state, name);
      this.#authorize(state, actor, 'export', app);
      if (app.id !== intent.id || app.sequence !== intent.sequence || app.lifecycle.kind !== 'removed' || !app.lifecycle.suspended) conflict('The export was superseded.');
    });
    return { artifact, records };
  }

  async importApp(actor: Actor, rawName: string, prepared: PreparedArtifact, snapshot: RecordsSnapshot, rawKey: string): Promise<AppView> {
    const name = appName(rawName);
    const key = operationKey(rawKey);
    const records = validateRecordsSnapshot(snapshot, this.#limits.records);
    const fingerprint = await sha256(JSON.stringify(records));
    if (!prepared.artifact.manifest.capabilities.records && records.records.length) invalid('The artifact does not declare records.');
    const intent = this.#state.update(state => {
      const token = this.#authorize(state, actor, 'publish');
      if (token?.appIds !== null && token?.appIds !== undefined) forbidden('An app-scoped credential cannot import applications.');
      const previous = state.operations.find(operation => operation.key === key);
      if (previous) {
        const app = state.apps.find(item => item.id === previous.appId);
        if (previous.kind !== 'import' || previous.name !== name || previous.digest !== prepared.digest || previous.fingerprint !== fingerprint
          || actorKey(previous.actor) !== actorKey(actor) || !app) conflict('The import key was used for another operation.');
        if (previous.state.kind === 'active') return { kind: 'done' as const, app: view(state, app) };
        if (previous.state.kind === 'superseded' || app.pending !== key || app.sequence !== previous.sequence) conflict('The import was superseded.');
        return { kind: 'pending' as const, id: app.id, sequence: app.sequence };
      }
      if (state.apps.some(app => app.name === name)) conflict('Import requires a new application name.');
      if (state.apps.length >= this.#limits.apps) quota('Application limit reached.');
      this.#daily(state);
      if (state.usage.publications >= this.#limits.publishesPerDay) quota('Daily publication limit reached.');
      if (state.operations.length >= 500) quota('Publication history limit reached. Purge an unused removed application.');
      if (prepared.bytes > this.#limits.artifactBytes) quota('Artifact exceeds the byte limit.');
      const bytes = [...artifactAllocations(state).values()].reduce((total, bytes) => total + bytes, 0);
      if (bytes + prepared.bytes > this.#limits.tenantArtifactBytes) quota('Tenant artifact limit reached.');
      const id = crypto.randomUUID() as AppId;
      state.usage.publications++;
      state.apps.push({ id, name, sequence: 1, lifecycle: { kind: 'removed', suspended: false },
        releases: [{ number: 1, digest: prepared.digest, bytes: prepared.bytes, manifest: structuredClone(prepared.artifact.manifest), createdAt: this.#now() }],
        current: null, binding: null, pending: key });
      state.operations.push({ kind: 'import', key, appId: id, name, digest: prepared.digest, fingerprint, bytes: prepared.bytes,
        sequence: 1, actor: structuredClone(actor), state: { kind: 'preparing' } });
      this.#record(state, actor, 'import', id, 'preparing');
      return { kind: 'pending' as const, id, sequence: 1 };
    });
    if (intent.kind === 'done') return intent.app;
    await this.#artifacts.put(intent.id, prepared);
    await this.#resources.records(intent.id).restore(records, key);
    const binding = await this.#provider.suspend(intent.id, intent.sequence);
    return this.#state.update(state => {
      const app = this.#app(state, name);
      this.#authorize(state, actor, 'publish', app);
      if (app.id !== intent.id || app.sequence !== intent.sequence || app.pending !== key) conflict('The import was superseded.');
      const operation = state.operations.find(item => item.key === key);
      if (!operation) conflict('The import was superseded.');
      app.current = app.releases[0];
      app.binding = binding;
      app.pending = null;
      app.lifecycle = { kind: 'removed', suspended: true };
      operation.state = { kind: 'active', release: app.current };
      this.#record(state, actor, 'import', intent.id, 'complete');
      return view(state, app);
    });
  }
}
