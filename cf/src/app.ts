import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { authorizeApp, type CredentialProof } from './auth.ts';
import { admitRequest, appRow, audit, observeApp, releaseCompute, reserveCompute } from './directory.ts';
import { artifactPurgeDeadline, prepareUploadArtifact, readPackage } from './artifacts.ts';
import { NativeResources } from './resources.ts';
import { nextSchedule } from './cron.ts';
import { expectKind } from './ephemeral.ts';
import { NAMED_ACTIONS, managerAfter, mustName } from './manager.ts';
import { actionScope, fail, WAKE_PHASES, type Actor, type AppAction, type AppRegistration, type AppSnapshot, type Artifact, type Capability, type Delivery, type EventRow, type ExecutionScope, type Json, type LogRow, type ManagerChange, type Policy, type Release, type Wake } from './model.ts';
import { errorResponse, id, input, integer, json, sha, text } from './util.ts';

type Journal = { previous: Release | null; candidate: Release; key: string };
type Lease = { id: string; deadline: number; kind: 'request' | 'channel' };
/** `expiry` is set once an expiry began, to audit how it ends (ADR 0038). */
type State = Omit<AppSnapshot, 'releases'> & { releaseSequence: number; journal: Journal | null; schedules: Record<string, number>; purgeAt: number | null; day: string; dayRequests: number; expiry: { resumed: boolean; error: string | null } | null };
type Subscription = { kind: 'browser'; actor: CredentialProof; nextCheckAt: number } | { kind: 'execution'; scope: ExecutionScope } | { kind: 'closed' };
type DeliveryAttempt = { job: Delivery; generation: number };
type Receipt = { fingerprint: string; snapshot: boolean; result: unknown };
const STATE = 'platform:state';

export class AppCell extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private runtime = new Runtime(this);
  private cancellations = new Map<string, () => void>();
  private resources?: NativeResources;
  private deliveries = new Set<string>();
  private checkingSubscribers = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const state = this.ctx.storage.kv.get<State & { origin?: string }>(STATE);
      if (!state) return;
      // Apps created under per-app domains stored their origin (ADR 0044).
      if (state.origin !== undefined) { delete state.origin; this.save(state); }
      if (!('manager' in state)) { Object.assign(state, { expiresAt: null, manager: null, expiry: null }); this.save(state); }
      if (state.journal) {
        state.current = state.journal.previous;
        state.capabilities = Object.keys(state.current?.manifest.capabilities ?? {}) as Capability[];
        state.status = state.current ? 'registered' : 'draft';
        state.journal = null;
        this.save(state);
        if (state.current) this.native().ensure(state.current.manifest); else this.native().suspend();
        await this.retire(true);
      } else if (state.runtime.bootId && !ctx.container?.running) {
        await this.retire(true);
      }
      if (await this.ctx.storage.getAlarm() === null) await this.arm();
    });
  }
  envForRuntime(): Env { return this.env; }
  state(): State { return this.ctx.storage.kv.get<State>(STATE) ?? fail(404, 'app', 'Application is not initialized.'); }
  save(state: State): void { this.ctx.storage.kv.put(STATE, state); }
  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  snapshot(): AppSnapshot {
    const { journal, schedules, purgeAt, day, dayRequests, releaseSequence, expiry, ...snapshot } = this.state();
    const leases = this.leases();
    snapshot.runtime = { ...snapshot.runtime, running: this.ctx.container?.running ?? false, requests: leases.filter(x => x.kind === 'request').length, channels: leases.filter(x => x.kind === 'channel').length };
    if (snapshot.runtime.state === 'awake' && !snapshot.runtime.running) snapshot.runtime.state = 'asleep';
    return { ...snapshot, wake: snapshot.wake ?? null, releases: this.items<Release>('platform:release:') };
  }
  guard(scope: ExecutionScope | null, capability?: Capability): void {
    const state = this.state();
    if (state.status !== 'registered') fail(409, 'inactive', 'Application is not active.');
    if (scope !== null && (!scope || typeof scope.bootId !== 'string' || !scope.bootId || scope.appId !== state.id || scope.generation !== state.generation || scope.bootId !== state.runtime.bootId)) fail(409, 'retired', 'Execution has been retired.');
    if (capability && !state.capabilities.includes(capability)) fail(403, 'capability', 'Capability was not declared.');
  }
  native(): NativeResources {
    return this.resources ??= new NativeResources(this.ctx.storage, this.env, this.state().id, {
      guard: (scope: ExecutionScope | null, capability: Capability) => this.guard(scope, capability), policy: () => this.state().policy,
      broadcast: (channel: string, value: Json) => {
        const sockets = this.ctx.getWebSockets('kv:' + channel);
        let delivered = 0;
        for (const socket of sockets) {
          const subscription = socket.deserializeAttachment() as Subscription | null;
          if (socket.readyState !== WebSocket.OPEN || subscription?.kind === 'closed') continue;
          if (subscription?.kind === 'browser' && subscription.nextCheckAt <= Date.now()) continue;
          try {
            if (!subscription) { this.closeSubscriber(socket, 1008, 'Subscription expired'); continue; }
            if (subscription.kind === 'execution') this.guard(subscription.scope, 'kv');
            socket.send(JSON.stringify(value)); delivered++;
          } catch { this.closeSubscriber(socket, 1008, 'Subscription expired'); }
        }
        return delivered;
      },
    });
  }
  private append<T>(prefix: string, row: T, limit = 200): void {
    this.ctx.storage.kv.put(prefix + Date.now().toString().padStart(16, '0') + ':' + crypto.randomUUID(), row);
    const rows = [...this.ctx.storage.kv.list({ prefix })];
    for (const [key] of rows.slice(0, Math.max(0, rows.length - limit))) this.ctx.storage.kv.delete(key);
  }
  event(type: string, message: string, data?: Json): void { this.append<EventRow>('platform:event:', { id: id('evt'), at: Date.now(), type, message, data }); }
  recordWake(wake: Wake): void {
    const state = this.state();
    state.wake = wake;
    this.save(state);
    if (wake.outcome === 'ready') this.event('wake-ready', 'Ready in ' + elapsed(wake) + ' ms.', wake);
    if (wake.outcome === 'failed') this.event('wake-failed', 'Startup failed: ' + wake.error, wake);
  }
  private recordResponse(bootId: string): void {
    const state = this.state();
    if (state.wake?.bootId !== bootId || state.wake.outcome !== 'ready' || state.wake.phases.respond !== null) return;
    state.wake.phases.respond = Math.max(0, Date.now() - state.wake.at - elapsed(state.wake));
    this.save(state);
  }
  private items<T>(prefix: string): T[] { return [...this.ctx.storage.kv.list<T>({ prefix })].map(([, value]) => value); }
  leases(): Lease[] { return this.items<Lease>('platform:lease:'); }
  async arm(): Promise<void> {
    const state = this.state();
    const times: number[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const subscription = socket.deserializeAttachment() as Subscription | null;
      if (socket.readyState === WebSocket.OPEN && subscription?.kind === 'browser' && !this.checkingSubscribers.has(socket)) times.push(subscription.nextCheckAt);
    }
    if (state.purgeAt !== null) times.push(state.purgeAt);
    if (state.expiresAt !== null && state.status !== 'purging' && state.status !== 'purged') times.push(state.expiresAt);
    if (state.runtime.bootId && !this.leases().length) times.push(state.runtime.sleepsAt ?? Date.now() + 1000);
    if (state.status === 'registered') {
      times.push(...Object.values(state.schedules));
      for (const job of this.items<Delivery>('platform:job:')) if (job.state === 'due' || job.state === 'delivering') times.push(job.nextAttemptAt);
    }
    times.push(...this.leases().map(x => x.deadline));
    if (times.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }
  async retire(force = false): Promise<void> {
    let state = this.state();
    state.generation++;
    state.runtime.state = 'draining';
    this.save(state);
    const end = Date.now() + (force ? 0 : state.policy.drainSeconds * 1000);
    while (this.leases().length && Date.now() < end) await scheduler.wait(50);
    for (const cancel of this.cancellations.values()) cancel();
    this.cancellations.clear();
    for (const socket of this.ctx.getWebSockets()) {
      const subscription = socket.deserializeAttachment() as Subscription | null;
      if (state.status !== 'registered' || subscription?.kind !== 'browser') this.closeSubscriber(socket, 1012, 'Application retired');
    }
    for (const [key] of this.ctx.storage.kv.list({ prefix: 'platform:lease:' })) this.ctx.storage.kv.delete(key);
    const bootId = state.runtime.bootId;
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    if (bootId) await releaseCompute(this.env, state.id, bootId);
    state = this.state();
    state.runtime = { ...state.runtime, state: state.runtime.failures >= state.policy.maxFailures ? 'quarantined' : 'asleep', running: false, bootId: null, since: Date.now(), sleepsAt: null, requests: 0, channels: 0 };
    if (bootId) state.usage.sleeps++;
    this.save(state);
    await this.arm();
  }
  async containerAcquire(): Promise<Fetcher> {
    return this.runtime.acquire();
  }
  container(): Container { return this.ctx.container ?? fail(503, 'container', 'Container binding is unavailable.'); }
  async startBinding(scope: ExecutionScope): Promise<void> {
    await this.container().interceptOutboundHttp('pneuma-space.internal', this.ctx.exports.AppServices({ props: scope }));
  }
  async publish(actor: Actor, artifact: Artifact, key: string, expectedGeneration: unknown, uploadId?: string, manager: ManagerChange | null = null): Promise<AppSnapshot> {
    await authorizeApp(this.env, actor, this.state().id, 'publish');
    if (this.state().status === 'removed' || this.state().status === 'purging' || this.state().status === 'purged') fail(409, 'inactive', 'Resume the application before publishing.');
    const committed = this.ctx.storage.kv.get<{ digest: string }>('platform:published:' + key);
    if (committed) { if (committed.digest !== artifact.digest) fail(409, 'idempotency', 'Key was already used for another package.'); return this.snapshot(); }
    await readPackage(this.env, artifact);
    for (const trigger of Object.values(artifact.manifest.capabilities.cron?.triggers ?? {})) if (trigger.schedule) nextSchedule(trigger.schedule, Date.now());
    await authorizeApp(this.env, actor, this.state().id, 'publish');
    if (integer(expectedGeneration, 'publication generation', 0, Number.MAX_SAFE_INTEGER) !== this.state().generation) fail(409, 'retired', 'Application changed after this upload began.');
    const previous = this.state().current;
    const candidate: Release = { ...artifact, number: this.state().releaseSequence + 1, createdAt: Date.now(), createdBy: actor.user.id };
    let state = this.state();
    state.journal = { previous, candidate, key };
    this.save(state);
    await this.retire();
    state = this.state();
    state.current = candidate;
    state.status = 'registered';
    state.capabilities = Object.keys(candidate.manifest.capabilities) as Capability[];
    state.runtime.failures = 0;
    state.runtime.state = 'asleep';
    this.save(state);
    try {
      this.native().ensure(candidate.manifest);
      if (candidate.manifest.runtime === 'node') await this.containerAcquire();
      await authorizeApp(this.env, actor, state.id, 'publish');
    } catch (error) {
      await this.retire(true);
      state = this.state();
      state.current = previous;
      state.capabilities = Object.keys(previous?.manifest.capabilities ?? {}) as Capability[];
      state.status = previous ? 'registered' : 'draft';
      state.journal = null;
      this.save(state);
      if (previous) this.native().ensure(previous.manifest); else this.native().suspend();
      this.event('publish-failed', error instanceof Error ? error.message : 'Startup failed.');
      throw error;
    }
    state = this.state();
    state.releaseSequence = candidate.number;
    this.ctx.storage.kv.put('platform:release:' + String(candidate.number).padStart(12, '0'), candidate);
    state.journal = null;
    state.schedules = this.schedule(candidate);
    state.manager = managerAfter(state.manager, manager);
    this.save(state);
    this.ctx.storage.kv.put('platform:published:' + key, { digest: artifact.digest, uploadId });
    this.event('published', 'Published release ' + candidate.number);
    await this.arm();
    return this.snapshot();
  }
  private schedule(release: Release | null): Record<string, number> {
    // An ephemeral app's triggers run on demand only, so no schedule of the app it previews fires from it (ADR 0038).
    if (this.state().expiresAt !== null) return {};
    return Object.fromEntries(Object.entries(release?.manifest.capabilities.cron?.triggers ?? {}).filter(([, trigger]) => trigger.schedule).map(([name, trigger]) => [name, nextSchedule(trigger.schedule!, Date.now())]));
  }
  private async purge(): Promise<{ pending: true; retryAt: number } | AppSnapshot> {
    const result = await this.native().destroy();
    const state = this.state();
    const artifactDeadline = await artifactPurgeDeadline(this.env, state.id);
    const deadline = Math.max(result.retryAt ?? 0, artifactDeadline ?? 0);
    state.purgeAt = deadline > Date.now() ? deadline : null;
    if (state.purgeAt === null) {
      state.purgeAt = Date.now() + 30000;
      this.save(state);
      await this.arm();
      let cursor: string | undefined;
      do {
        const listed = await this.env.PNEUMA_SPACE_ARTIFACTS.list({ prefix: 'apps/' + state.id + '/', cursor });
        if (listed.objects.length) await this.env.PNEUMA_SPACE_ARTIFACTS.delete(listed.objects.map(x => x.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      state.status = 'purged'; state.purgeAt = null; state.current = null; state.capabilities = [];
      for (const [key] of this.ctx.storage.kv.list({ prefix: 'platform:release:' })) this.ctx.storage.kv.delete(key);
    }
    this.save(state);
    await this.arm();
    return state.purgeAt === null ? this.snapshot() : { pending: true, retryAt: state.purgeAt };
  }
  /** Purge's path from any live status; purging is saved first, so the alarm finishes what a call does not. */
  private async enterPurging(): Promise<void> {
    const state = this.state();
    if (state.status === 'purging') return;
    state.status = 'purging'; state.purgeAt = Date.now(); state.schedules = {}; this.save(state);
    await this.retire(true);
  }
  private async action(actor: Actor, action: AppAction, key: string, named: string | null): Promise<unknown> {
    await authorizeApp(this.env, actor, this.state().id, actionScope(action.type));
    if (!['wake', 'sleep', 'restart', 'kill', 'remove', 'resume', 'unquarantine', 'rollback', 'purge', 'policy', 'discard'].includes(action.type)) fail(400, 'action', 'Unknown application action.');
    let state = this.state();
    if (state.status === 'purged') fail(410, 'purged', 'Application was purged.');
    // The request's own errors answer before the manager's 409, the same with or without its name (ADR 0039).
    const release = action.type === 'rollback' ? this.ctx.storage.kv.get<Release>('platform:release:' + String(action.release).padStart(12, '0')) ?? fail(404, 'release', 'Release not found.') : null;
    let policy: Policy | null = null;
    if (action.type === 'policy') {
      const allocation = await appRow(this.env, state.id);
      if (action.policy.storageBytes !== undefined && action.policy.storageBytes > allocation.storage_bytes) fail(409, 'storage_quota', 'Policy exceeds the application storage allocation.');
      const limits = { idleSeconds: [1, 3600], requestSeconds: [1, 900], drainSeconds: [0, 60], maxFailures: [1, 100], requestsPerDay: [1, 1000000], storageBytes: [1024, 1000000000] };
      policy = { ...state.policy };
      for (const [name, value] of Object.entries(action.policy)) {
        if (!(name in limits)) fail(400, 'policy', 'Unknown policy field.');
        const field = name as keyof typeof limits;
        policy[field] = integer(value, name, limits[field][0], limits[field][1]);
      }
    }
    if (action.type === 'purge' && action.confirmation !== state.name) fail(409, 'purge_confirmation', 'Remove first and confirm the exact application name.');
    if (NAMED_ACTIONS.has(action.type)) mustName(state, named);
    if (action.type === 'discard') {
      if (state.expiresAt === null) fail(409, 'durable', 'Application ' + state.name + ' is durable; discard ends only an ephemeral app. Remove and purge end this one.');
      await this.enterPurging();
      return this.purge();
    }
    if (state.status === 'purging') return action.type === 'purge' ? this.purge() : fail(409, 'purging', 'Application is being purged.');
    if (action.type === 'purge') {
      if (state.status !== 'removed') fail(409, 'purge_confirmation', 'Remove first and confirm the exact application name.');
      await this.enterPurging();
      return this.purge();
    }
    if (action.type === 'resume') {
      if (state.status === 'removed') { state.status = state.current ? 'registered' : 'draft'; state.generation++; state.schedules = this.schedule(state.current); this.save(state); if (state.current) this.native().ensure(state.current.manifest); }
    } else if (action.type === 'remove') {
      if (state.status !== 'removed') {
        state.status = 'removed'; state.schedules = {}; this.save(state);
        await this.retire(); this.native().suspend();
        for (const [key, job] of this.ctx.storage.kv.list<Delivery>({ prefix: 'platform:job:' })) if (job.state === 'due' || job.state === 'delivering') this.ctx.storage.kv.put(key, { ...job, state: 'cancelled' });
      }
    } else {
      this.guard(null);
      if (release) return this.publish(actor, release, key, state.generation);
      if (policy) {
        state.policy = policy; this.save(state);
      } else if (action.type === 'unquarantine') {
        state.runtime.failures = 0; state.runtime.state = 'asleep'; this.save(state);
      } else {
        if (['sleep', 'restart', 'kill'].includes(action.type)) await this.retire(action.type === 'kill');
        if (['wake', 'restart'].includes(action.type)) await this.containerAcquire();
      }
    }
    this.event(action.type, 'Application action completed.');
    await this.arm();
    return this.snapshot();
  }
  private async once(key: unknown, value: unknown, work: (key: string) => Promise<unknown>): Promise<unknown> {
    const name = text(key, 'idempotency key', 200);
    const fingerprint = await sha(JSON.stringify(value));
    const stored = this.ctx.storage.kv.get<Receipt>('platform:receipt:' + name);
    if (stored) {
      if (stored.fingerprint !== fingerprint) fail(409, 'idempotency', 'Key was already used for another operation.');
      if (stored.snapshot) return this.snapshot();
      return stored.result && typeof stored.result === 'object' && 'pending' in stored.result && this.state().status === 'purged' ? this.snapshot() : stored.result;
    }
    const result = await work(name);
    const snapshot = !!result && typeof result === 'object' && 'runtime' in result && 'releases' in result;
    this.ctx.storage.kv.put('platform:receipt:' + name, { fingerprint, snapshot, result: snapshot ? null : result });
    return result;
  }
  private job(name: unknown, payload: Json, deliveryId = id('job'), scheduledFor = Date.now()): Delivery {
    this.guard(null, 'cron');
    const trigger = text(name, 'trigger', 100);
    if (!this.state().current?.manifest.capabilities.cron?.triggers[trigger]) fail(404, 'trigger', 'Trigger is not declared.');
    const key = 'platform:job:' + deliveryId;
    const existing = this.ctx.storage.kv.get<Delivery>(key);
    if (existing) return existing;
    const delivery: Delivery = { id: deliveryId, name: trigger, payload, state: 'due', attempts: 0, scheduledFor, nextAttemptAt: Date.now(), error: null };
    this.ctx.storage.kv.put(key, delivery);
    return delivery;
  }
  async alarm(): Promise<void> {
    const checks: Promise<void>[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const subscription = socket.deserializeAttachment() as Subscription | null;
      if (socket.readyState !== WebSocket.OPEN || subscription?.kind !== 'browser' || subscription.nextCheckAt > Date.now() || this.checkingSubscribers.has(socket)) continue;
      this.checkingSubscribers.add(socket);
      checks.push(this.checkSubscriber(socket, subscription));
    }
    await Promise.all(checks);
    const deliveries = await this.serial(async (): Promise<DeliveryAttempt[]> => {
      let state = this.state();
      for (const lease of this.leases()) if (lease.deadline <= Date.now()) this.releaseLease(lease.id, true);
      if (state.expiresAt !== null && state.expiresAt <= Date.now() && state.status !== 'purging' && state.status !== 'purged') {
        await audit(this.env, 'platform', 'app.expire', state.tenantId, state.id, 'started', { expiresAt: state.expiresAt });
        state.expiry = { resumed: false, error: null };
        this.save(state);
        await this.enterPurging();
      }
      if (this.state().status === 'purging') { await this.finishPurge(); return []; }
      const deliveries: DeliveryAttempt[] = [];
      if (state.status === 'registered' && !state.journal) {
        for (const [name, due] of Object.entries(state.schedules)) if (due <= Date.now()) {
          this.job(name, null, 'scheduled_' + state.current!.number + '_' + name + '_' + due, due);
          state.schedules[name] = nextSchedule(state.current!.manifest.capabilities.cron!.triggers[name].schedule!, Date.now());
        }
        this.save(state);
        for (const job of this.items<Delivery>('platform:job:').filter(x => !this.deliveries.has(x.id) && (x.state === 'due' || x.state === 'delivering') && x.nextAttemptAt <= Date.now()).slice(0, 10)) {
          job.state = 'delivering'; job.attempts++; job.nextAttemptAt = Date.now() + (state.policy.requestSeconds + 60) * 1000;
          this.ctx.storage.kv.put('platform:job:' + job.id, job);
          deliveries.push({ job, generation: state.generation });
        }
      }
      state = this.state();
      if (!deliveries.length && state.runtime.bootId && !this.leases().length && (state.runtime.sleepsAt ?? 0) <= Date.now()) await this.retire(true);
      await this.arm();
      return deliveries;
    });
    for (const attempt of deliveries) {
      this.deliveries.add(attempt.job.id);
      this.ctx.waitUntil(this.deliver(attempt).finally(() => this.deliveries.delete(attempt.job.id)));
    }
  }
  /** A failed purge retries from the alarm; an expiry writes one error row per distinct failure, since audit only grows (ADR 0038). */
  private async finishPurge(): Promise<void> {
    let result: Awaited<ReturnType<AppCell['purge']>>;
    try { result = await this.purge(); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Purge failed.';
      console.error(JSON.stringify({ event: 'purge-failed', app: this.state().id, message }));
      const state = this.state();
      if (state.expiry && state.expiry.error !== message) {
        await audit(this.env, 'platform', 'app.expire', state.tenantId, state.id, 'error', { error: message, ...(state.expiry.resumed && { resumed: true }) });
        state.expiry.error = message;
      }
      if (state.expiry) state.expiry.resumed = true;
      state.purgeAt = Math.max(state.purgeAt ?? 0, Date.now() + 30000);
      this.save(state);
      await this.arm();
      return;
    }
    const state = this.state();
    if (state.expiry && 'pending' in result) { state.expiry.resumed = true; this.save(state); }
    else if (state.expiry) await audit(this.env, 'platform', 'app.expire', state.tenantId, state.id, 'ok', state.expiry.resumed ? { resumed: true } : '');
    await observeApp(this.env, this.snapshot());
  }
  private closeSubscriber(socket: WebSocket, code: number, reason: string): void {
    socket.serializeAttachment({ kind: 'closed' } satisfies Subscription);
    socket.close(code, reason);
  }
  private async checkSubscriber(socket: WebSocket, subscription: Extract<Subscription, { kind: 'browser' }>): Promise<void> {
    const nextCheckAt = Date.now() + 15000;
    try {
      await authorizeApp(this.env, subscription.actor, this.state().id, 'invoke');
      this.guard(null, 'kv');
      if (socket.readyState === WebSocket.OPEN && (socket.deserializeAttachment() as Subscription | null)?.kind === 'browser') socket.serializeAttachment({ ...subscription, nextCheckAt } satisfies Subscription);
    } catch { this.closeSubscriber(socket, 1008, 'Authorization ended'); }
    finally { this.checkingSubscribers.delete(socket); }
  }
  private async deliver(attempt: DeliveryAttempt): Promise<void> {
    const job = attempt.job;
    let error: string | null = null;
    try {
      const response = await this.forward(new Request('http://container/_pneuma-space/invoke/_pneuma-space/trigger/' + encodeURIComponent(job.name), { method: 'POST', headers: { 'content-type': 'application/json', 'x-pneuma-space-delivery': job.id, 'x-pneuma-space-delivery-attempt': String(job.attempts) }, body: JSON.stringify(job.payload) }), attempt);
      await response.arrayBuffer();
      if (!response.ok) throw new Error('Trigger returned HTTP ' + response.status);
    } catch (failure) { error = failure instanceof Error ? failure.message : 'Delivery failed'; }
    await this.serial(async () => {
      const current = this.ctx.storage.kv.get<Delivery>('platform:job:' + job.id);
      const state = this.state();
      if (state.status !== 'registered' || state.generation !== attempt.generation || current?.state !== 'delivering' || current.attempts !== job.attempts) return;
      current.state = error === null ? 'done' : current.attempts >= 5 ? 'failed' : 'due';
      current.error = error;
      if (error !== null) current.nextAttemptAt = Date.now() + Math.min(3600000, 1000 * 2 ** current.attempts);
      this.ctx.storage.kv.put('platform:job:' + job.id, current);
      await this.arm();
    });
  }
  private releaseLease(leaseId: string, cancel = false): void {
    if (cancel) this.cancellations.get(leaseId)?.();
    this.cancellations.delete(leaseId);
    this.ctx.storage.kv.delete('platform:lease:' + leaseId);
    const state = this.state();
    state.runtime.sleepsAt = Date.now() + state.policy.idleSeconds * 1000;
    this.save(state);
    this.ctx.waitUntil(this.arm());
  }
  private admit(expectedGeneration?: number): void {
    this.guard(null);
    const state = this.state();
    if (expectedGeneration !== undefined && expectedGeneration !== state.generation) fail(409, 'retired', 'Application changed before admission.');
    const day = new Date().toISOString().slice(0, 10);
    if (state.day !== day) { state.day = day; state.dayRequests = 0; }
    if (state.dayRequests >= state.policy.requestsPerDay) fail(429, 'quota', 'Daily request quota exhausted.');
    state.dayRequests++; state.usage.requests++; state.lastAccessAt = Date.now(); this.save(state);
  }
  private async forward(request: Request, delivery?: DeliveryAttempt): Promise<Response> {
    const prepare = async () => {
      this.guard(null);
      if (this.state().journal) fail(503, 'publishing', 'Release activation is in progress.');
      if (delivery) {
        this.guard(null, 'cron');
        const current = this.ctx.storage.kv.get<Delivery>('platform:job:' + delivery.job.id);
        if (this.state().generation !== delivery.generation || current?.state !== 'delivering' || current.attempts !== delivery.job.attempts) fail(409, 'retired', 'Delivery has been retired.');
        await admitRequest(this.env, this.state().tenantId);
      }
      this.admit();
      const previous = this.state().runtime.bootId;
      let port: Fetcher;
      try { port = await this.containerAcquire(); }
      finally { if (delivery) delivery.generation = this.state().generation; }
      const state = this.state();
      const woke = state.runtime.bootId !== previous ? state.runtime.bootId : null;
      const lease: Lease = { id: id('lease'), deadline: Date.now() + state.policy.requestSeconds * 1000, kind: request.headers.get('upgrade')?.toLowerCase() === 'websocket' ? 'channel' : 'request' };
      if (lease.kind === 'channel') this.guard(null, 'ws');
      this.ctx.storage.kv.put('platform:lease:' + lease.id, lease);
      if (delivery) this.ctx.storage.kv.put('platform:job:' + delivery.job.id, { ...delivery.job, nextAttemptAt: lease.deadline });
      state.runtime.sleepsAt = lease.deadline; this.save(state); await this.arm();
      return { port, lease, woke };
    };
    const { port, lease, woke } = await this.serial(prepare);
    const url = new URL(request.url); url.hostname = 'container'; url.protocol = 'http:'; url.pathname = url.pathname.slice('/_pneuma-space/invoke'.length) || '/';
    const abort = new AbortController();
    this.cancellations.set(lease.id, () => abort.abort());
    try {
      const response = await port.fetch(new Request(url, { method: request.method, headers: request.headers, body: request.body, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, lease.deadline - Date.now()))]), redirect: 'manual' }));
      if (woke) this.recordResponse(woke);
      if (response.webSocket) {
        const pair = new WebSocketPair(); const downstream = pair[1]; const upstream = response.webSocket;
        downstream.accept(); upstream.accept();
        const close = () => { downstream.close(1000, 'Closed'); upstream.close(1000, 'Closed'); this.releaseLease(lease.id); };
        this.cancellations.set(lease.id, close);
        downstream.addEventListener('message', event => upstream.send(event.data));
        upstream.addEventListener('message', event => downstream.send(event.data));
        for (const socket of [downstream, upstream]) { socket.addEventListener('close', close); socket.addEventListener('error', close); }
        return new Response(null, { status: 101, webSocket: pair[0], headers: response.headers });
      }
      const reader = response.body?.getReader();
      if (!reader) { this.releaseLease(lease.id); return response; }
      const stream = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try { const value = await reader.read(); if (value.done) { controller.close(); this.releaseLease(lease.id); } else controller.enqueue(value.value); }
          catch (error) { controller.error(error); this.releaseLease(lease.id); }
        },
        cancel: async reason => { await reader.cancel(reason); this.releaseLease(lease.id); },
      });
      this.cancellations.set(lease.id, () => { abort.abort(); void reader.cancel(); });
      return new Response(stream, { status: response.status, headers: response.headers });
    } catch (error) { this.releaseLease(lease.id); const state = this.state(); state.usage.errors++; this.save(state); throw error; }
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/_pneuma-space/invoke/')) return await this.forward(request);
      if (path === '/initialize') return await this.serial(async () => {
        const value = await input(request) as unknown as AppRegistration;
        const old = this.ctx.storage.kv.get<State>(STATE);
        if (old) { if (old.id !== value.id) fail(409, 'identity', 'AppId differs.'); return json(this.snapshot()); }
        const state: State = { ...value, expiresAt: value.expiresAt ?? null, manager: value.manager ?? null, status: 'draft', generation: 0, current: null, releaseSequence: 0, runtime: { state: 'asleep', running: false, bootId: null, since: Date.now(), sleepsAt: null, requests: 0, channels: 0, failures: 0 }, capabilities: [], lastAccessAt: null, usage: { requests: 0, errors: 0, wakes: 0, sleeps: 0 }, wake: null, journal: null, schedules: {}, purgeAt: null, day: '', dayRequests: 0, expiry: null };
        this.save(state); await this.arm(); return json(this.snapshot());
      });
      if (path === '/inspect') return json(this.snapshot());
      if (path === '/inspect/state') return json(this.native().inventory());
      if (path === '/usage') return json(this.snapshot().usage);
      if (path === '/logs' && request.method === 'GET') return json({ items: this.items<LogRow>('platform:log:') });
      if (path === '/events') return json({ items: this.items<EventRow>('platform:event:') });
      if (path === '/jobs' && request.method === 'GET') return json({ items: this.items<Delivery>('platform:job:') });
      if (path.startsWith('/subscribe/') || path.startsWith('/scoped-subscribe/')) {
        const scoped = path.startsWith('/scoped-subscribe/');
        let subscription: Subscription;
        if (scoped) {
          const scope = JSON.parse(request.headers.get('x-pneuma-space-scope') ?? '{}') as ExecutionScope;
          this.guard(scope, 'kv');
          subscription = { kind: 'execution', scope };
        } else {
          const header = request.headers.get('x-pneuma-space-actor') ?? fail(401, 'unauthorized', 'Subscriber identity is required.');
          const actor = JSON.parse(decodeURIComponent(header)) as CredentialProof;
          const nextCheckAt = Date.now() + 15000;
          await authorizeApp(this.env, actor, this.state().id, 'invoke');
          this.guard(null, 'kv');
          subscription = { kind: 'browser', actor: { kind: actor.kind, hash: actor.hash }, nextCheckAt };
        }
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') fail(426, 'websocket', 'WebSocket upgrade required.');
        const accept = async () => {
          const scope = subscription.kind === 'execution' ? subscription.scope : null;
          this.guard(scope, 'kv');
          if (this.ctx.getWebSockets().length >= 100) fail(429, 'channels', 'Subscriber limit reached.');
          if (scope) { await admitRequest(this.env, this.state().tenantId); this.guard(scope, 'kv'); }
          this.admit();
          const pair = new WebSocketPair();
          this.ctx.acceptWebSocket(pair[1], ['kv:' + text(decodeURIComponent(path.slice(scoped ? 18 : 11)), 'channel', 200)]);
          pair[1].serializeAttachment(subscription);
          await this.arm();
          return new Response(null, { status: 101, webSocket: pair[0] });
        };
        return scoped ? await accept() : await this.serial(accept);
      }
      const value = await input(request, path === '/logs' ? 256 * 1024 : undefined);
      if (path === '/admit') return await this.serial(async () => {
        this.admit(integer(value.expectedGeneration, 'admission generation', 0, Number.MAX_SAFE_INTEGER));
        return new Response(null, { status: 204 });
      });
      if (path === '/broker') { this.guard(value.scope as ExecutionScope); return json(await this.native().perform(value.command, value.scope as ExecutionScope)); }
      if (path === '/boot') {
        this.guard(value.scope as ExecutionScope);
        const release = this.state().current!;
        const object = await this.env.PNEUMA_SPACE_ARTIFACTS.get(release.key);
        this.guard(value.scope as ExecutionScope);
        if (!object) fail(404, 'artifact', 'Package is unavailable.');
        return new Response(object.body, { headers: { 'content-type': 'application/json' } });
      }
      if (path === '/logs') {
        this.guard(value.scope as ExecutionScope);
        const rows = Array.isArray(value.items) ? value.items.slice(0, 100) : fail(400, 'logs', 'Expected log items.');
        for (const row of rows) this.append<LogRow>('platform:log:', { id: id('log'), at: Date.now(), level: text(row.level, 'level', 20), message: typeof row.message === 'string' ? row.message.slice(0, 2000) : fail(400, 'logs', 'Invalid log message.') });
        return json({ accepted: rows.length });
      }
      return await this.serial(async () => {
        const actor = value.actor as Actor;
        let result: unknown;
        if (path === '/publish-upload') {
          await authorizeApp(this.env, actor, this.state().id, 'publish');
          const manager = (value.manager ?? null) as ManagerChange | null;
          result = await this.once(value.idempotencyKey, { type: 'publish-upload', uploadId: value.uploadId, ...(manager && { manager }) }, async key => {
            const uploadId = text(value.uploadId, 'upload', 80);
            const committed = this.ctx.storage.kv.get<{ uploadId?: string }>('platform:published:' + key);
            if (committed) {
              if (committed.uploadId !== uploadId) fail(409, 'idempotency', 'Key was already used for another package.');
              return this.snapshot();
            }
            const state = this.state();
            if (state.status !== 'draft' && state.status !== 'registered') fail(409, 'inactive', 'Resume the application before publishing.');
            const artifact = await prepareUploadArtifact(this.env, actor, state.id, uploadId, state.generation, () => {
              mustName(this.state(), value.named as string | null);
              expectKind(this.state(), value.ephemeral === true);
            });
            return this.publish(actor, artifact, key, state.generation, uploadId, manager);
          });
        } else if (path === '/publish') {
          await authorizeApp(this.env, actor, this.state().id, 'publish');
          result = await this.once(value.idempotencyKey, { type: 'publish', artifact: value.artifact }, key => this.publish(actor, value.artifact as Artifact, key, value.expectedGeneration));
        } else if (path === '/action') {
          const action = value.action as AppAction;
          await authorizeApp(this.env, actor, this.state().id, actionScope(action.type));
          result = await this.once(value.idempotencyKey, action, key => this.action(actor, action, key, (value.named ?? null) as string | null));
        } else if (path === '/manager') {
          await authorizeApp(this.env, actor, this.state().id, 'publish');
          const state = this.state();
          mustName(state, (value.named ?? null) as string | null);
          if (state.manager) { state.manager = null; this.save(state); this.event('manager', 'Manager cleared.'); }
          result = { manager: null };
        } else if (path === '/data') {
          await authorizeApp(this.env, actor, this.state().id, 'data'); result = await this.native().perform(value.command, null);
        } else if (path === '/jobs') {
          await authorizeApp(this.env, actor, this.state().id, 'manage');
          result = await this.once(value.idempotencyKey, { name: value.name, payload: value.payload }, async key => this.job(value.name, (value.payload ?? null) as Json, 'manual_' + encodeURIComponent(key)));
          await this.arm();
        } else fail(404, 'route', 'Unknown application operation.');
        const projection = observeApp(this.env, this.snapshot()).catch((error: unknown) => console.error('Projection update failed', error));
        // A purged app releases its name and quota before the answer, so the next request about it gets 404.
        if (this.state().status === 'purged') await projection; else this.ctx.waitUntil(projection);
        return json(result);
      });
    } catch (error) { return errorResponse(error); }
  }
  webSocketClose(socket: WebSocket): void { this.closeSubscriber(socket, 1000, 'Closed'); this.ctx.waitUntil(this.arm()); }
  webSocketError(socket: WebSocket): void { this.closeSubscriber(socket, 1011, 'Connection failed'); this.ctx.waitUntil(this.arm()); }
}

type RunnerReport = { bootId?: unknown; digest?: unknown; ready?: unknown; uptime?: unknown; phases?: Record<string, unknown> };
const duration = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const elapsed = (wake: Wake): number => WAKE_PHASES.reduce((sum, phase) => sum + (wake.phases[phase] ?? 0), 0);

class Runtime {
  private readonly app: AppCell;
  constructor(app: AppCell) { this.app = app; }
  async acquire(): Promise<Fetcher> {
    this.app.guard(null);
    let state = this.app.state();
    if (!state.current || state.current.manifest.runtime !== 'node') fail(409, 'runtime', 'Application has no Node runtime.');
    if (state.runtime.state === 'quarantined') fail(503, 'quarantined', 'Runtime is quarantined.');
    const container = this.app.container();
    if (container.running && state.runtime.state === 'awake') {
      try {
        const ready = await container.getTcpPort(8080).fetch('http://container/_pneuma-space/ready', { signal: AbortSignal.timeout(2000) });
        await ready.body?.cancel();
        if (ready.ok) return container.getTcpPort(8080);
      } catch {}
      state.runtime.failures++; this.app.save(state);
    }
    if (state.runtime.bootId) await this.app.retire(true);
    state = this.app.state();
    if (state.runtime.state === 'quarantined') fail(503, 'quarantined', 'Runtime is quarantined.');
    const bootId = id('boot'), digest = state.current!.digest;
    const scope = { appId: state.id, generation: state.generation, bootId };
    const wake: Wake = { bootId, at: Date.now(), outcome: 'waking', error: null, phases: Object.fromEntries(WAKE_PHASES.map(phase => [phase, null])) as Wake['phases'] };
    state.runtime = { ...state.runtime, state: 'waking', bootId, since: Date.now(), sleepsAt: Date.now() + 60000 };
    state.wake = wake;
    this.app.save(state);
    await this.app.arm();
    try {
      await reserveCompute(this.app.envForRuntime(), state.id, bootId);
      await this.app.startBinding(scope);
      const requested = Date.now();
      wake.phases.reserve = requested - wake.at;
      container.start({ image: container.images.base, instance: 'lite', enableInternet: false, env: { PNEUMA_SPACE_BOOT_ID: bootId, PNEUMA_SPACE_DIGEST: digest } });
      await container.setInactivityTimeout((state.policy.requestSeconds + state.policy.idleSeconds + 60) * 1000);
      const port = container.getTcpPort(8080);
      for (const deadline = Date.now() + 45000; Date.now() < deadline;) {
        try {
          const response = await port.fetch('http://container/_pneuma-space/ready', { signal: AbortSignal.timeout(1000) });
          const report = await response.json<RunnerReport>();
          if (report.bootId === bootId) {
            const uptime = duration(report.uptime);
            if (wake.phases.container === null && uptime !== null) wake.phases.container = Math.max(0, Date.now() - uptime - requested);
            for (const phase of ['fetch', 'unpack', 'listen'] as const) wake.phases[phase] = duration(report.phases?.[phase]);
            if (response.ok && report.ready === true && report.digest === digest) {
              if (wake.phases.container !== null) wake.phases.confirm = Math.max(0, Date.now() - wake.at - elapsed(wake));
              state = this.app.state(); state.runtime.state = 'awake'; state.runtime.sleepsAt = Date.now() + state.policy.idleSeconds * 1000; state.usage.wakes++; this.app.save(state);
              this.app.recordWake({ ...wake, outcome: 'ready' });
              await this.app.arm(); return port;
            }
          }
        } catch {}
        await scheduler.wait(200);
      }
      fail(503, 'startup', 'Application did not become ready.');
    } catch (error) {
      state = this.app.state(); state.runtime.failures++; this.app.save(state);
      this.app.recordWake({ ...wake, outcome: 'failed', error: (error instanceof Error ? error.message : 'Startup failed.').slice(0, 200) });
      await this.app.retire(true); throw error;
    }
  }
}

export class AppServices extends WorkerEntrypoint<Env, ExecutionScope> {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'pneuma-space.internal') fail(403, 'host', 'Unknown internal host.');
      const scope = this.ctx.props;
      const app = this.env.PNEUMA_SPACE_APPS.get(this.env.PNEUMA_SPACE_APPS.idFromName(scope.appId));
      const path = url.pathname;
      if (path.startsWith('/subscribe/')) {
        const forwarded = new Request('http://app/scoped-subscribe/' + path.slice(11), request);
        forwarded.headers.set('x-pneuma-space-scope', JSON.stringify(scope));
        return app.fetch(forwarded);
      }
      if (!['/boot', '/broker', '/logs'].includes(path)) fail(404, 'route', 'Unknown internal operation.');
      const value = path === '/boot' ? {} : await input(request, 256 * 1024);
      return app.fetch('http://app' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(path === '/broker' ? { command: value, scope } : { ...value, scope }) });
    } catch (error) { return errorResponse(error); }
  }
}
