import { lookup } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { emit, type Emit } from './events.ts';
import type { Instances } from './instances.ts';
import type { KubeClient, Pod } from './kube.ts';
import { Lifecycle, specHash, type Adopted, type Driver, type Ending, type Gone, type Slot } from './lifecycle.ts';
import { RUNTIME_ENV, type AppId, type BundleId, type HealthCheck, type Instance, type RunSpec } from './model.ts';
import type { EventPage, Listed, RunnerEvent, Started, StartRequest } from './runner.ts';
import { Unavailable, type AppGuard } from './runtimes.ts';

/** The runner's control port on the platform network; never published to the host. */
export const RUNNER_PORT = 8082;
// One small read on the platform network; hang detection is the watchdog's 3 to 4 s plus at most this.
const POLL_MS = 250;
/** A paused runner still accepts connections, so a poll gives up on its answer well before CALL_MS. */
const PROBE_MS = 2000;
const CALL_MS = 10_000;
const RECOVER_MS = 5000;
/** The same grace `docker stop` gives a container. */
const STOP_MS = 10_000;
const ENDS_KEPT = 100;
/** How long polls must keep failing before awake isolate instances are marked asleep as unavailable; one app can stall the runner's main thread for seconds. */
const UNREACHABLE_MS = 15_000;

type IsolateRun = RunSpec & { readonly runtime: Extract<RunSpec['runtime'], { kind: 'isolate' }> };

/** One runner as the pool sees it; `ready` is whether a new home may be placed on it and a start sent to it. */
export type RunnerRef = { readonly id: string; readonly url: string; readonly ready: boolean };

/** The runners isolate apps can live on; the plane picks the implementation (ADR 0019 item 1). */
export interface RunnerPool {
  /** False when the pool could not read its runners, so nothing is known of the workers they hold. */
  ready(): Promise<boolean>;
  runners(): readonly RunnerRef[];
  /** What Unavailable says when no runner answers; the compose profile hint when absent. */
  readonly unreachable?: string;
}

/** The ready runner with the fewest awake workers, ties by id (ADR 0019 item 8). */
export function pick(runners: readonly RunnerRef[], awake: (id: string) => number): RunnerRef | null {
  let best: RunnerRef | null = null;
  for (const runner of runners) {
    if (!runner.ready) continue;
    const order = best === null ? -1 : awake(runner.id) - awake(best.id) || (runner.id < best.id ? -1 : 1);
    if (order < 0) best = runner;
  }
  return best;
}

/** Compose: the one `runner` service; whether it answers is learned by the calls to it, as a stopped service has no name. */
export class StaticPool implements RunnerPool {
  readonly #runners: readonly RunnerRef[];

  constructor(url: string) {
    this.#runners = [{ id: 'runner', url, ready: true }];
  }

  async ready(): Promise<boolean> {
    return true;
  }

  runners(): readonly RunnerRef[] {
    return this.#runners;
  }
}

const RUNNER_SELECTOR = 'pneuma-space.role=runner';
const RELIST_MS = 1000;

/** Kubernetes: the runner StatefulSet's Pods in the client's namespace, listed and then watched; a Pod without an IP holds no workers yet. */
export class StatefulSetPool implements RunnerPool {
  readonly unreachable = 'no runner Pod of the pneuma-space-runner StatefulSet answered';
  #runners: readonly RunnerRef[] = [];
  readonly #listed = Promise.withResolvers<boolean>();
  readonly #stop = new AbortController();

  constructor(kube: Pick<KubeClient, 'list' | 'watch'>) {
    void this.#follow(kube);
  }

  ready(): Promise<boolean> {
    return this.#listed.promise;
  }

  runners(): readonly RunnerRef[] {
    return this.#runners;
  }

  close(): void {
    this.#stop.abort();
  }

  async #follow(kube: Pick<KubeClient, 'list' | 'watch'>): Promise<void> {
    const { signal } = this.#stop;
    while (!signal.aborted) {
      try {
        const listed = await kube.list('pods', { labelSelector: RUNNER_SELECTOR });
        this.#runners = listed.items.flatMap((pod) => runnerOf(pod) ?? []);
        this.#listed.resolve(true);
        for await (const event of kube.watch('pods', { labelSelector: RUNNER_SELECTOR, from: listed, signal })) {
          if (event.type === 'BOOKMARK') continue;
          const others = this.#runners.filter((runner) => runner.id !== event.object.metadata.name);
          const runner = event.type === 'DELETED' ? null : runnerOf(event.object);
          this.#runners = runner ? [...others, runner] : others;
        }
      } catch {
        // The last list stays in use while the API server is away; a Pod gone meanwhile shows when the next list replaces it.
        this.#listed.resolve(false);
        await sleep(RELIST_MS, undefined, { signal }).catch(() => {});
      }
    }
  }
}

function runnerOf(pod: Pod): RunnerRef | null {
  const ip = pod.status?.podIP;
  if (!ip) return null;
  const ready = pod.metadata.deletionTimestamp === undefined && (pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
  return { id: pod.metadata.name, url: `http://${ip.includes(':') ? `[${ip}]` : ip}:${RUNNER_PORT}`, ready };
}

export type IsolateOptions = {
  readonly pool: RunnerPool;
  /** A credential-free GET URL for a code bundle's tar; the gateway never streams the bytes. */
  readonly bundleUrl: (bundle: BundleId) => string;
  readonly specFor: (app: AppId) => RunSpec | null;
  /** Whether any release of the app ran on this runtime, so purge must reach the runner to delete its storage. */
  readonly hasRun: (app: AppId) => Promise<boolean>;
  readonly instances: Instances;
  readonly guard?: AppGuard;
  readonly log?: Emit;
};

class RunnerError extends Error {}

/** Failures before the request is sent; anything later may be the request's doing. */
const UNREACHED: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** The row names the worker and keeps it running: an asleep isolate row holds no worker, whatever handle it kept. */
const names = (row: Instance | null, worker: string): boolean => row?.runtime === 'isolate' && row.handle === worker && row.state !== 'asleep';
/** Whether the worker is its app's, judged by the row read after the runner listed it; a waking row's waker may still be creating it (ADR 0027 item 2). */
const owns = (row: Instance | null, worker: string): boolean => names(row, worker) || (row?.runtime === 'isolate' && row.state === 'waking');

const ending = (event: RunnerEvent): Ending => {
  if (event.ev === 'hung') return { ev: 'hung', reason: event.reason ?? 'hung' };
  if (event.ev === 'oom') return { ev: 'crashed', reason: `worker exceeded its ${event.reason ?? 'heap'} memory limit` };
  if (event.reason === 'stopped') return { ev: 'stopped' };
  return { ev: 'crashed', reason: event.reason ?? `worker exited with code ${event.code}` };
};

/** What the driver tracks of one runner; its polls, failures and recovery touch no other runner. */
type Runner = {
  readonly id: string;
  url: string;
  startedAt: number | null;
  after: number;
  /** Workers this gateway started or adopted that have not ended: the ones it marks unavailable when the runner stops answering it. */
  readonly live: Map<string, AppId>;
  /** The latest terminal events read: a start whose worker ended before its POST answered fails, and a worker followed later is found ended. */
  readonly ends: Map<string, RunnerEvent>;
  /** Workers whose end is sure to reach this gateway's polls: it read their `ready`, or a listing taken after its cursor showed them running. */
  readonly confirmed: Set<string>;
  /** Followed workers whose end was reported once already. */
  readonly reported: Set<string>;
  /** A control call failed or instances went asleep unavailable: the runner may hold workers no row owns. */
  suspect: boolean;
};

/** Handles are runner worker ids, `<runner startedAt>:<n>`; an asleep isolate app holds none. Every app runs on its home runner. */
class IsolateDriver implements Driver<IsolateRun, string> {
  readonly kind = 'isolate';
  readonly handleKey = 'worker';
  readonly #pool: RunnerPool;
  readonly #bundleUrl: (bundle: BundleId) => string;
  readonly #hasRun: (app: AppId) => Promise<boolean>;
  readonly #instances: Instances;
  readonly #log: Emit;
  readonly #runners = new Map<string, Runner>();
  #follow: { readonly gone: Gone<string>; readonly signal: AbortSignal } | null = null;

  constructor(options: IsolateOptions) {
    this.#pool = options.pool;
    this.#bundleUrl = options.bundleUrl;
    this.#hasRun = options.hasRun;
    this.#instances = options.instances;
    this.#log = options.log ?? emit;
  }

  #unavailable(): Unavailable {
    return new Unavailable('isolate', this.#pool.unreachable);
  }

  accepts(spec: RunSpec): spec is IsolateRun {
    return spec.runtime.kind === 'isolate';
  }

  place(): string {
    const awake = new Map<string, number>();
    for (const row of this.#instances.rows()) {
      if (row.runtime === 'isolate' && row.state !== 'asleep' && row.home !== null) awake.set(row.home, (awake.get(row.home) ?? 0) + 1);
    }
    const home = pick(this.#pool.runners(), (id) => awake.get(id) ?? 0);
    if (!home) throw this.#unavailable();
    return home.id;
  }

  async start(slot: Slot<string>, spec: IsolateRun): Promise<string> {
    slot.release = spec.release;
    slot.specHash = specHash(spec);
    const ref = this.#pool.runners().find((runner) => runner.id === slot.home);
    if (!ref?.ready) throw this.#unavailable();
    const runner = this.#track(ref);
    const readyMs = spec.policy.ready_timeout_seconds * 1000;
    const request: StartRequest = {
      release: spec.release,
      spec: specHash(spec),
      bundleUrl: this.#bundleUrl(spec.runtime.bundle),
      entry: spec.runtime.entry,
      env: { ...spec.injection.env, [RUNTIME_ENV.app]: spec.name, [RUNTIME_ENV.release]: String(spec.release) },
      storage: spec.injection.storage.map(({ id, env }) => ({ id, env })),
      heapMb: spec.policy.memory_mb,
      readyMs,
    };
    const address = await this.#resolve(runner);
    // No app code has run yet, so a runner that does not answer this is never the app's fault.
    await this.#call(runner, 'GET', '/health', undefined, readyMs).catch(() => { throw this.#unavailable(); });
    const started = await this.#call<Started>(runner, 'POST', `/instances/${spec.app}`, request, readyMs + CALL_MS);
    const ended = runner.ends.get(started.worker);
    if (ended) throw new RunnerError(`worker of app ${spec.app} ended as soon as it listened: ${ended.reason ?? ended.ev}`);
    slot.handle = started.worker;
    runner.live.set(started.worker, spec.app);
    if (Math.min(started.heapMb, started.offheapMb) < request.heapMb) {
      this.#log('memory-clamped', spec.app, { memoryMb: request.heapMb, heapMb: started.heapMb, offheapMb: started.offheapMb });
    }
    return `${address}:${started.port}`;
  }

  async sleep(app: AppId, slot: Slot<string>): Promise<void> {
    const runner = this.#reach(app, slot.handle);
    await this.#call(runner, 'DELETE', `/instances/${app}?drain=${STOP_MS}`, undefined, STOP_MS + CALL_MS);
    runner.live.delete(slot.handle!);
    slot.handle = null;
  }

  /** Names the worker, so a late removal leaves a worker a later wake started (ADR 0027 item 2). */
  async remove(app: AppId, worker: string): Promise<void> {
    const runner = this.#reach(app, worker);
    await this.#call(runner, 'DELETE', `/instances/${app}?drain=${STOP_MS}&retire=1&worker=${worker}`, undefined, STOP_MS + CALL_MS);
    runner.live.delete(worker);
  }

  /** Without `worker` the runner stops whatever worker the app has. */
  async kill(app: AppId, worker: string | null): Promise<void> {
    const runner = this.#reach(app, worker);
    await this.#call(runner, 'DELETE', `/instances/${app}?drain=0&retire=1`, undefined, CALL_MS);
    if (worker !== null) runner.live.delete(worker);
  }

  /** The runner is its own failure domain: an untracked worker it cannot stop now is stopped by the recovery poll. */
  async discard(app: AppId, worker: string): Promise<boolean> {
    let runner: Runner | null = null;
    try {
      runner = this.#reach(app, worker);
      runner.live.delete(worker);
      await this.#call(runner, 'DELETE', `/instances/${app}?drain=${STOP_MS}&retire=1&worker=${worker}`, undefined, STOP_MS + CALL_MS);
      return true;
    } catch (error) {
      if (runner) runner.suspect = true;
      this.#log('runner-unreachable', app, { worker, error: String(error) });
      return false;
    }
  }

  /**
   * The listening workers whose rows, read after the listing, name them; every other worker is left to the recovery poll, which stops it
   * unless a row owns it (ADR 0027 item 2). Null when the pool or any runner in it could not be asked, or a transition names a home the pool
   * does not list: a worker may still run there, so nothing is known to be gone.
   */
  async adopt(): Promise<readonly Adopted<string>[] | null> {
    if (!(await this.#pool.ready())) return null;
    const refs = this.#pool.runners();
    const known = new Set(refs.map(({ id }) => id));
    if ([...this.#instances.rows()].some((row) => row.runtime === 'isolate' && row.state !== 'asleep' && row.home !== null && !known.has(row.home))) return null;
    const asked = await Promise.all(refs.map((ref) => this.#list(this.#track(ref))));
    if (asked.some((answer) => answer === null)) {
      for (const answer of asked) if (answer) answer.runner.suspect = true;
      return null;
    }
    const adopted: Adopted<string>[] = [];
    for (const { runner, address, listed } of asked as NonNullable<(typeof asked)[number]>[]) {
      for (const { app, worker, release, spec, port, state } of listed) {
        if (state !== 'listening' || !names(await this.#instances.store.instance(app as AppId), worker)) {
          runner.suspect = true;
          continue;
        }
        runner.live.set(worker, app as AppId);
        adopted.push({ app: app as AppId, handle: worker, release: String(release), spec, address: `${address}:${port}` });
      }
    }
    return adopted;
  }

  /** A runner that is off or does not answer reports null. */
  async #list(runner: Runner): Promise<{ readonly runner: Runner; readonly address: string; readonly listed: readonly Listed[] } | null> {
    const address = await lookup(new URL(runner.url).hostname).then(({ address }) => address, () => null);
    if (address === null) return null;
    try {
      await this.#cursor(runner);
      const listed = await this.#call<Listed[]>(runner, 'GET', '/instances');
      this.#confirm(runner, listed);
      return { runner, address, listed };
    } catch (error) {
      runner.suspect = true;
      this.#log('runner-unreachable', null, { runner: runner.id, error: String(error) });
      return null;
    }
  }

  /** Also tracks every runner an isolate row names as home, so this replica reaches workers other replicas started there. */
  follow(gone: Gone<string>, signal: AbortSignal): void {
    this.#follow = { gone, signal };
    for (const runner of this.#runners.values()) this.#loop(runner);
    void (async () => {
      while (!signal.aborted) {
        const homes = new Set<string>();
        for (const row of this.#instances.rows()) if (row.runtime === 'isolate' && row.home !== null) homes.add(row.home);
        for (const ref of this.#pool.runners()) if (homes.has(ref.id)) this.#track(ref);
        await sleep(POLL_MS, undefined, { ref: false });
      }
    })();
  }

  /** The tracked state of a runner the pool lists; a new one is polled from now on. */
  #track(ref: RunnerRef): Runner {
    let runner = this.#runners.get(ref.id);
    if (!runner) {
      runner = { id: ref.id, url: ref.url, startedAt: null, after: 0, live: new Map(), ends: new Map(), confirmed: new Set(), reported: new Set(), suspect: false };
      this.#runners.set(ref.id, runner);
      if (this.#follow) this.#loop(runner);
    }
    runner.url = ref.url;
    return runner;
  }

  /** The runner holding `handle`, else the app's home, else the only runner; null when the app never had a home. Unavailable when its home is not in the pool. */
  #locate(app: AppId, handle: string | null): Runner | null {
    if (handle !== null) for (const runner of this.#runners.values()) if (runner.live.has(handle)) return runner;
    const refs = this.#pool.runners();
    const home = this.#instances.row(app)?.home ?? (refs.length === 1 ? refs[0].id : null);
    if (home === null) return null;
    const ref = refs.find(({ id }) => id === home);
    if (!ref) throw this.#unavailable();
    return this.#track(ref);
  }

  #reach(app: AppId, handle: string | null): Runner {
    const runner = this.#locate(app, handle);
    if (!runner) throw this.#unavailable();
    return runner;
  }

  #loop(runner: Runner): void {
    const { gone, signal } = this.#follow!;
    void (async () => {
      let failingSince: number | null = null;
      let probed = -Infinity;
      for (;;) {
        await sleep(POLL_MS, undefined, { ref: false });
        if (signal.aborted) return;
        const ref = this.#pool.runners().find(({ id }) => id === runner.id);
        if (ref) runner.url = ref.url;
        else if (runner.live.size > 0) {
          // A runner the pool no longer lists, a deleted Pod, holds none of the workers it ran.
          this.#lost(runner, gone, 'runner-gone');
          continue;
        } else {
          this.#runners.delete(runner.id);
          return;
        }
        if ((runner.suspect || this.#instances.leading) && performance.now() - probed >= RECOVER_MS) {
          probed = performance.now();
          await this.#recover(runner, runner.suspect).catch(() => {});
        }
        const followed = this.#followed(runner);
        for (const worker of runner.reported) if (!followed.has(worker)) runner.reported.delete(worker);
        if (followed.size === 0 && runner.live.size === 0) continue;
        try {
          await this.#poll(runner, followed, gone);
          failingSince = null;
        } catch (error) {
          failingSince ??= performance.now();
          if (performance.now() - failingSince < UNREACHABLE_MS) continue;
          failingSince = null;
          this.#lost(runner, gone, 'runner-unreachable', { error: String(error) });
        }
      }
    })();
  }

  /** The next wake starts again through the runner, which answers with the worker if it is still running. */
  #lost(runner: Runner, gone: Gone<string>, ev: string, extra: Record<string, unknown> = {}): void {
    this.#log(ev, null, { runner: runner.id, ...extra, instances: runner.live.size });
    for (const [worker, app] of runner.live) gone(app, worker, { ev: 'unavailable' });
    runner.live.clear();
    runner.suspect = true;
  }

  /**
   * The leader's pass every RECOVER_MS, and any replica's once the runner answers again after a call to it failed: stops each worker no row
   * owns (ADR 0027 item 2). The mirror only spares; a stop needs the row read after the listing, and names its worker. Logged when it stops
   * anything or follows a failure.
   */
  async #recover(runner: Runner, suspected: boolean): Promise<void> {
    await this.#call(runner, 'GET', '/health', undefined, PROBE_MS);
    if (runner.startedAt === null) await this.#cursor(runner);
    const listed = await this.#call<Listed[]>(runner, 'GET', '/instances', undefined, PROBE_MS);
    this.#confirm(runner, listed);
    const orphans: Listed[] = [];
    for (const entry of listed) {
      const app = entry.app as AppId;
      if (!owns(this.#instances.row(app), entry.worker) && !owns(await this.#instances.store.instance(app), entry.worker)) orphans.push(entry);
    }
    runner.suspect = false;
    const stops = await Promise.allSettled(orphans.map(({ app, worker }) => this.#call(runner, 'DELETE', `/instances/${app}?drain=${STOP_MS}&worker=${worker}`, undefined, STOP_MS + CALL_MS)));
    const failed = stops.filter((stop) => stop.status === 'rejected').length;
    if (failed > 0) runner.suspect = true;
    if (suspected || orphans.length > 0) this.#log('runner-recovered', null, { runner: runner.id, stopped: orphans.length - failed, failed });
  }

  /** Skips the events before now, so whatever ended in them is no longer sure to be read. */
  async #cursor(runner: Runner): Promise<void> {
    const page = await this.#call<EventPage>(runner, 'GET', '/events?after=latest', undefined, PROBE_MS);
    runner.startedAt = page.startedAt;
    runner.after = page.seq;
    runner.confirmed.clear();
  }

  /** A listing taken after the cursor: a worker running in it ends after the cursor. */
  #confirm(runner: Runner, listed: readonly Listed[]): void {
    for (const { worker, state } of listed) if (state !== 'ending') runner.confirmed.add(worker);
  }

  /** The workers of this runner that awake isolate rows name, whichever replica started them (ADR 0027 item 3). */
  #followed(runner: Runner): Map<string, AppId> {
    const followed = new Map<string, AppId>();
    for (const row of this.#instances.rows()) {
      if (row.runtime === 'isolate' && row.state === 'awake' && row.handle !== null && row.home === runner.id) followed.set(row.handle, row.app);
    }
    return followed;
  }

  /** Once per worker while a row names it; the lifecycle's CAS decides whether the end still matters. */
  #report(runner: Runner, gone: Gone<string>, app: AppId, worker: string, end: Ending): void {
    if (runner.reported.has(worker)) return;
    runner.reported.add(worker);
    gone(app, worker, end);
  }

  async #poll(runner: Runner, followed: ReadonlyMap<string, AppId>, gone: Gone<string>): Promise<void> {
    let page = await this.#call<EventPage>(runner, 'GET', `/events?after=${runner.after}`, undefined, PROBE_MS);
    if (page.startedAt !== runner.startedAt) {
      // A restarted runner holds none of the workers its predecessor ran.
      const current = `${page.startedAt}:`;
      for (const [worker, app] of followed) if (!worker.startsWith(current)) this.#report(runner, gone, app, worker, { ev: 'stopped' });
      for (const worker of runner.live.keys()) if (!worker.startsWith(current)) runner.live.delete(worker);
      runner.startedAt = page.startedAt;
      runner.after = 0;
      runner.confirmed.clear();
      page = await this.#call<EventPage>(runner, 'GET', '/events?after=0', undefined, PROBE_MS);
    }
    // The ring dropped events this page should have started with; a confirmed worker's end may be among them.
    if ((page.events[0]?.seq ?? 0) > runner.after + 1) runner.confirmed.clear();
    for (const event of page.events) {
      runner.after = Math.max(runner.after, event.seq);
      if (event.ev === 'forged') continue;
      if (event.ev === 'ready') {
        runner.confirmed.add(event.worker);
        continue;
      }
      runner.confirmed.delete(event.worker);
      runner.live.delete(event.worker);
      runner.ends.set(event.worker, event);
      if (runner.ends.size > ENDS_KEPT) runner.ends.delete(runner.ends.keys().next().value!);
    }
    const unconfirmed = new Map<string, AppId>();
    for (const [worker, app] of followed) {
      const end = runner.ends.get(worker);
      if (end) this.#report(runner, gone, app, worker, ending(end));
      else if (!runner.confirmed.has(worker) && !runner.reported.has(worker)) unconfirmed.set(worker, app);
    }
    if (unconfirmed.size > 0) await this.#inventory(runner, unconfirmed, gone);
  }

  /**
   * Followed workers whose end might have passed before this gateway's cursor: one the runner still runs is confirmed, one it no longer lists
   * is reported with the end the runner still holds, else as crashed. One ending without a held end is asked again next poll (ADR 0027 item 3).
   */
  async #inventory(runner: Runner, unconfirmed: ReadonlyMap<string, AppId>, gone: Gone<string>): Promise<void> {
    const listed = new Map((await this.#call<Listed[]>(runner, 'GET', '/instances', undefined, PROBE_MS)).map((entry) => [entry.worker, entry]));
    let ring: readonly RunnerEvent[] | null = null;
    for (const [worker, app] of unconfirmed) {
      const entry = listed.get(worker);
      if (entry && entry.state !== 'ending') {
        runner.confirmed.add(worker);
        continue;
      }
      if (ring === null) {
        const page = await this.#call<EventPage>(runner, 'GET', '/events?after=0', undefined, PROBE_MS);
        // A runner restarted since the last poll; that poll's successor reports its workers stopped.
        if (page.startedAt !== runner.startedAt) return;
        ring = page.events;
      }
      const end = ring.findLast((event) => event.worker === worker && event.ev !== 'ready' && event.ev !== 'forged');
      if (end) this.#report(runner, gone, app, worker, ending(end));
      else if (!entry) this.#report(runner, gone, app, worker, { ev: 'crashed', reason: 'the worker was gone when this gateway began to follow it' });
    }
  }

  async logs(app: AppId, worker: string | null, tail: number): Promise<string> {
    try {
      const runner = this.#locate(app, worker);
      return runner ? await this.#call<string>(runner, 'GET', `/logs/${app}?tail=${tail}`) : '';
    } catch {
      return '';
    }
  }

  health(): readonly HealthCheck[] {
    return ['exit', 'ready', 'hang', 'memory'];
  }

  /** Purge waits for the home runner: a stopped one still holds the directory in its volume. An app that never had a home has none. */
  async destroyStorage(app: AppId, id: string): Promise<void> {
    if (!(await this.#hasRun(app))) return;
    await this.#instances.ready();
    const runner = this.#locate(app, null);
    if (!runner) return;
    await this.#resolve(runner);
    await this.#call(runner, 'DELETE', `/storage/${app}/${id}`);
  }

  /** A stopped compose service has no name on the platform network. */
  async #resolve(runner: Runner): Promise<string> {
    return (await lookup(new URL(runner.url).hostname).catch(() => {
      runner.suspect = true;
      throw this.#unavailable();
    })).address;
  }

  /** Throws Unavailable when the request never reached the runner or it answered 503, else RunnerError: no answer came, or an error did. */
  async #call<T>(runner: Runner, method: string, path: string, body?: unknown, timeoutMs = CALL_MS): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(new URL(path, runner.url), {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      });
      text = await response.text();
    } catch (error) {
      runner.suspect = true;
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code !== undefined && UNREACHED.has(code)) throw this.#unavailable();
      throw new RunnerError(`runner ${runner.id} ${method} ${path}: ${(error as Error).name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : String((error as Error).cause ?? error)}`);
    }
    if (response.status === 503) throw this.#unavailable();
    if (!response.ok) throw new RunnerError(`runner ${runner.id} ${method} ${path}: ${response.status} ${text}`);
    if (response.status === 204) return undefined as T;
    return (response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text) as T;
  }
}

export class IsolateRuntime extends Lifecycle<IsolateRun, string> {
  constructor(options: IsolateOptions) {
    super(new IsolateDriver(options), options);
  }
}
