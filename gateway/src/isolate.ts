import { lookup } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { emit, type Emit } from './events.ts';
import { Lifecycle, specHash, type Adopted, type Driver, type Ending, type Gone, type Slot } from './lifecycle.ts';
import { RUNTIME_ENV, type AppId, type BundleId, type HealthCheck, type RunSpec } from './model.ts';
import type { EventPage, Listed, RunnerEvent, Started, StartRequest } from './runner.ts';
import { Unavailable } from './runtimes.ts';

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
const UNCLAIMED = 100;
/** How long polls must keep failing before awake isolate instances are marked asleep as unavailable; one app can stall the runner's main thread for seconds. */
const UNREACHABLE_MS = 15_000;

type IsolateRun = RunSpec & { readonly runtime: Extract<RunSpec['runtime'], { kind: 'isolate' }> };

export type IsolateOptions = {
  /** Base URL of the runner's control API, `http://runner:8082` on the platform network. */
  readonly runner: string;
  /** A credential-free GET URL for a code bundle's tar; the gateway never streams the bytes. */
  readonly bundleUrl: (bundle: BundleId) => string;
  readonly specFor: (app: AppId) => RunSpec | null;
  /** Whether any release of the app ran on this runtime, so purge must reach the runner to delete its storage. */
  readonly hasRun: (app: AppId) => Promise<boolean>;
  readonly log?: Emit;
};

class RunnerError extends Error {}

/** Failures before the request is sent; anything later may be the request's doing. */
const UNREACHED: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

const ending = (event: RunnerEvent): Ending => {
  if (event.ev === 'hung') return { ev: 'hung', reason: event.reason ?? 'hung' };
  if (event.ev === 'oom') return { ev: 'crashed', reason: `worker exceeded its ${event.reason ?? 'heap'} memory limit` };
  if (event.reason === 'stopped') return { ev: 'stopped' };
  return { ev: 'crashed', reason: event.reason ?? `worker exited with code ${event.code}` };
};

/** Handles are runner worker ids, `<runner startedAt>:<n>`; an asleep isolate app holds none. */
class IsolateDriver implements Driver<IsolateRun, string> {
  readonly kind = 'isolate';
  readonly handleKey = 'worker';
  readonly #runner: URL;
  readonly #bundleUrl: (bundle: BundleId) => string;
  readonly #hasRun: (app: AppId) => Promise<boolean>;
  readonly #log: Emit;
  /** Workers this gateway started or adopted that have not ended; events are polled only while there are any. */
  readonly #live = new Map<string, AppId>();
  /** Terminal events of workers not yet known: a start whose worker ended before its POST answered fails. */
  readonly #unclaimed = new Map<string, RunnerEvent>();
  /** Apps whose start is in flight: the runner lists their worker before the start answers. */
  readonly #starting = new Set<AppId>();
  #startedAt: number | null = null;
  #after = 0;
  /** A control call failed or instances went asleep unavailable: the runner may hold workers nobody tracks. */
  #suspect = false;

  constructor(options: IsolateOptions) {
    this.#runner = new URL(options.runner);
    this.#bundleUrl = options.bundleUrl;
    this.#hasRun = options.hasRun;
    this.#log = options.log ?? emit;
  }

  accepts(spec: RunSpec): spec is IsolateRun {
    return spec.runtime.kind === 'isolate';
  }

  async start(slot: Slot<IsolateRun, string>, spec: IsolateRun): Promise<string> {
    slot.spec = spec;
    const readyMs = spec.policy.ready_timeout_seconds * 1000;
    const request: StartRequest = {
      release: spec.release,
      spec: specHash(spec),
      bundleUrl: this.#bundleUrl(spec.runtime.bundle),
      entry: spec.runtime.entry,
      env: { ...spec.injection.env, [RUNTIME_ENV.app]: spec.name, [RUNTIME_ENV.release]: String(spec.release) },
      storage: spec.injection.storage.map(({ id, env }) => ({ id, env })),
      readyMs,
    };
    const address = await this.#resolve();
    // No app code has run yet, so a runner that does not answer this is never the app's fault.
    await this.#call('GET', '/health', undefined, readyMs).catch(() => { throw new Unavailable('isolate'); });
    this.#starting.add(spec.app);
    let started: Started;
    try {
      started = await this.#call<Started>('POST', `/instances/${spec.app}`, request, readyMs + CALL_MS);
    } finally {
      this.#starting.delete(spec.app);
    }
    const ended = this.#unclaimed.get(started.worker);
    if (ended) throw new RunnerError(`worker of app ${spec.app} ended as soon as it listened: ${ended.reason ?? ended.ev}`);
    slot.handle = started.worker;
    this.#live.set(started.worker, spec.app);
    return `${address}:${started.port}`;
  }

  async sleep(app: AppId, slot: Slot<IsolateRun, string>): Promise<void> {
    await this.#call('DELETE', `/instances/${app}?drain=${STOP_MS}`, undefined, STOP_MS + CALL_MS);
    this.#live.delete(slot.handle!);
    slot.handle = null;
  }

  async remove(app: AppId, worker: string): Promise<void> {
    await this.#call('DELETE', `/instances/${app}?drain=${STOP_MS}&retire=1`, undefined, STOP_MS + CALL_MS);
    this.#live.delete(worker);
  }

  /** The runner is its own failure domain: an untracked worker it cannot stop now is stopped by the recovery poll. */
  async discard(app: AppId, worker: string): Promise<boolean> {
    this.#live.delete(worker);
    try {
      await this.remove(app, worker);
      return true;
    } catch (error) {
      this.#suspect = true;
      this.#log('runner-unreachable', app, { worker, error: String(error) });
      return false;
    }
  }

  /** A runner that is off or does not answer holds nothing to adopt; the gateway starts without it. */
  async adopt(): Promise<readonly Adopted<string>[]> {
    const address = await lookup(this.#runner.hostname).then(({ address }) => address, () => null);
    if (address === null) return [];
    let listed: Listed[];
    try {
      await this.#cursor();
      listed = await this.#call<Listed[]>('GET', '/instances');
    } catch (error) {
      this.#suspect = true;
      this.#log('runner-unreachable', null, { error: String(error) });
      return [];
    }
    const listening = listed.filter(({ state }) => state === 'listening');
    // A worker still starting or ending belongs to no gateway now; the recovery poll stops it.
    if (listening.length < listed.length) this.#suspect = true;
    for (const { worker, app } of listening) this.#live.set(worker, app as AppId);
    return listening.map(({ app, worker, release, spec, port }) => ({ app: app as AppId, handle: worker, release: String(release), spec, address: `${address}:${port}` }));
  }

  follow(gone: Gone<string>, signal: AbortSignal): void {
    void (async () => {
      let failingSince: number | null = null;
      let probed = 0;
      while (!signal.aborted) {
        await sleep(POLL_MS, undefined, { ref: false });
        if (this.#suspect && performance.now() - probed >= RECOVER_MS) {
          probed = performance.now();
          await this.#recover().catch(() => {});
        }
        if (this.#live.size === 0) continue;
        try {
          await this.#poll(gone);
          failingSince = null;
        } catch (error) {
          failingSince ??= performance.now();
          if (performance.now() - failingSince < UNREACHABLE_MS) continue;
          failingSince = null;
          this.#log('runner-unreachable', null, { error: String(error), instances: this.#live.size });
          // The next wake starts again through the runner, which answers with the worker if it is still running.
          for (const [worker, app] of this.#live) gone(app, worker, { ev: 'unavailable' });
          this.#live.clear();
          this.#suspect = true;
        }
      }
    })();
  }

  /** Once the runner answers again, stops the workers it kept that no lease can reach; the next request wakes the app in tens of ms. */
  async #recover(): Promise<void> {
    await this.#call('GET', '/health', undefined, PROBE_MS);
    if (this.#startedAt === null) await this.#cursor();
    const listed = await this.#call<Listed[]>('GET', '/instances', undefined, PROBE_MS);
    const untracked = listed.filter(({ worker, app }) => !this.#live.has(worker) && !this.#starting.has(app as AppId));
    this.#suspect = false;
    const stops = await Promise.allSettled(untracked.map(({ app, worker }) => this.#call('DELETE', `/instances/${app}?drain=${STOP_MS}&worker=${worker}`, undefined, STOP_MS + CALL_MS)));
    const failed = stops.filter((stop) => stop.status === 'rejected').length;
    if (failed > 0) this.#suspect = true;
    this.#log('runner-recovered', null, { stopped: untracked.length - failed, failed });
  }

  async #cursor(): Promise<void> {
    const page = await this.#call<EventPage>('GET', '/events?after=latest', undefined, PROBE_MS);
    this.#startedAt = page.startedAt;
    this.#after = page.seq;
  }

  async #poll(gone: Gone<string>): Promise<void> {
    let page = await this.#call<EventPage>('GET', `/events?after=${this.#after}`, undefined, PROBE_MS);
    if (page.startedAt !== this.#startedAt) {
      // A restarted runner holds none of the workers its predecessor ran.
      for (const [worker, app] of this.#live) {
        if (worker.startsWith(`${page.startedAt}:`)) continue;
        this.#live.delete(worker);
        gone(app, worker, { ev: 'stopped' });
      }
      this.#startedAt = page.startedAt;
      this.#after = 0;
      page = await this.#call<EventPage>('GET', '/events?after=0', undefined, PROBE_MS);
    }
    for (const event of page.events) {
      this.#after = Math.max(this.#after, event.seq);
      if (event.ev === 'ready') continue;
      const app = this.#live.get(event.worker);
      if (!app) {
        this.#unclaimed.set(event.worker, event);
        if (this.#unclaimed.size > UNCLAIMED) this.#unclaimed.delete(this.#unclaimed.keys().next().value!);
        continue;
      }
      this.#live.delete(event.worker);
      gone(app, event.worker, ending(event));
    }
  }

  async logs(app: AppId, _worker: string | null, tail: number): Promise<string> {
    return this.#call<string>('GET', `/logs/${app}?tail=${tail}`).catch(() => '');
  }

  health(): readonly HealthCheck[] {
    return ['exit', 'ready', 'hang', 'memory'];
  }

  /** Purge waits for the runner: a stopped one still holds the directory in its volume. */
  async destroyStorage(app: AppId, id: string): Promise<void> {
    if (!(await this.#hasRun(app))) return;
    await this.#resolve();
    await this.#call('DELETE', `/storage/${app}/${id}`);
  }

  /** A stopped compose service has no name on the platform network. */
  async #resolve(): Promise<string> {
    return (await lookup(this.#runner.hostname).catch(() => {
      this.#suspect = true;
      throw new Unavailable('isolate');
    })).address;
  }

  /** Throws Unavailable when the request never reached the runner, else RunnerError: no answer came, or an error did. */
  async #call<T>(method: string, path: string, body?: unknown, timeoutMs = CALL_MS): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(new URL(path, this.#runner), {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      });
      text = await response.text();
    } catch (error) {
      this.#suspect = true;
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code !== undefined && UNREACHED.has(code)) throw new Unavailable('isolate');
      throw new RunnerError(`runner ${method} ${path}: ${(error as Error).name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : String((error as Error).cause ?? error)}`);
    }
    if (!response.ok) throw new RunnerError(`runner ${method} ${path}: ${response.status} ${text}`);
    if (response.status === 204) return undefined as T;
    return (response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text) as T;
  }
}

export class IsolateRuntime extends Lifecycle<IsolateRun, string> {
  constructor(options: IsolateOptions) {
    super(new IsolateDriver(options), options);
  }
}
