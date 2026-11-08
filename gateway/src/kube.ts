// Kubernetes API client (ADR 0019 item 2). The only module that talks to Kubernetes.
import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { Unavailable } from './runtimes.ts';

type Labels = Readonly<Record<string, string>>;

export type ObjectMeta = {
  readonly name: string;
  readonly namespace?: string;
  readonly labels?: Labels;
  readonly annotations?: Labels;
  readonly resourceVersion?: string;
  readonly uid?: string;
  readonly deletionTimestamp?: string;
};

export type Container = {
  readonly name: string;
  readonly image: string;
  readonly imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  readonly command?: readonly string[];
  readonly ports?: readonly { readonly containerPort: number }[];
  readonly env?: readonly { readonly name: string; readonly value: string }[];
  readonly resources?: {
    readonly limits?: Readonly<Record<'cpu' | 'memory', string>>;
    readonly requests?: Readonly<Partial<Record<'cpu' | 'memory', string>>>;
  };
  readonly volumeMounts?: readonly { readonly name: string; readonly mountPath: string }[];
  readonly securityContext?: {
    readonly allowPrivilegeEscalation?: boolean;
    readonly runAsNonRoot?: boolean;
    readonly capabilities?: { readonly drop?: readonly string[] };
  };
};

export type ContainerState =
  | { readonly running: { readonly startedAt?: string } }
  | { readonly waiting: { readonly reason?: string; readonly message?: string } }
  | { readonly terminated: { readonly exitCode: number; readonly reason?: string; readonly message?: string } };

export type Pod = {
  readonly metadata: ObjectMeta;
  readonly spec: {
    readonly containers: readonly Container[];
    readonly restartPolicy?: 'Always' | 'OnFailure' | 'Never';
    readonly automountServiceAccountToken?: boolean;
    readonly enableServiceLinks?: boolean;
    readonly serviceAccountName?: string;
    readonly terminationGracePeriodSeconds?: number;
    readonly imagePullSecrets?: readonly { readonly name: string }[];
    readonly nodeSelector?: Labels;
    readonly securityContext?: {
      readonly seccompProfile?: { readonly type: 'RuntimeDefault' | 'Unconfined' | 'Localhost' };
      readonly fsGroup?: number;
      readonly runAsNonRoot?: boolean;
    };
    readonly volumes?: readonly { readonly name: string; readonly persistentVolumeClaim: { readonly claimName: string } }[];
    readonly nodeName?: string;
  };
  readonly status?: {
    readonly phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
    readonly reason?: string;
    readonly message?: string;
    readonly podIP?: string;
    readonly conditions?: readonly { readonly type: string; readonly status: 'True' | 'False' | 'Unknown' }[];
    readonly containerStatuses?: readonly { readonly name: string; readonly ready: boolean; readonly restartCount?: number; readonly state?: ContainerState }[];
  };
};

export type PersistentVolumeClaim = {
  readonly metadata: ObjectMeta;
  readonly spec: {
    readonly accessModes: readonly ('ReadWriteOnce' | 'ReadWriteOncePod' | 'ReadWriteMany' | 'ReadOnlyMany')[];
    readonly storageClassName?: string;
    readonly resources: { readonly requests: { readonly storage: string } };
  };
  readonly status?: { readonly phase?: 'Pending' | 'Bound' | 'Lost' };
};

export type Node = {
  readonly metadata: ObjectMeta;
  readonly spec?: { readonly unschedulable?: boolean; readonly taints?: readonly { readonly key: string; readonly value?: string; readonly effect: string }[] };
  readonly status?: {
    readonly conditions?: readonly { readonly type: string; readonly status: 'True' | 'False' | 'Unknown' }[];
    readonly allocatable?: Readonly<Partial<Record<'cpu' | 'memory' | 'pods', string>>>;
  };
};

type Objects = { pods: Pod; persistentvolumeclaims: PersistentVolumeClaim; nodes: Node };
export type Kind = keyof Objects;
/** The verbs ADR 0019 uses, per kind: claims are never listed, nodes never written. */
export type Writable = 'pods' | 'persistentvolumeclaims';
export type Listable = 'pods' | 'nodes';

const NAMESPACED: Readonly<Record<Kind, boolean>> = { pods: true, persistentvolumeclaims: true, nodes: false };

export type List<T> = { readonly metadata: { readonly resourceVersion: string }; readonly items: readonly T[] };
export type Selectors = { readonly labelSelector?: string; readonly fieldSelector?: string };
export type WatchOptions = { readonly labelSelector?: string; readonly resourceVersion?: string; readonly signal: AbortSignal };
export type WatchEvent<T> =
  | { readonly type: 'ADDED' | 'MODIFIED' | 'DELETED'; readonly object: T }
  | { readonly type: 'BOOKMARK'; readonly object: { readonly metadata: { readonly resourceVersion: string } } };

type Status = { readonly kind: 'Status'; readonly code?: number; readonly reason?: string; readonly message?: string };

/** Kubernetes answered with a non-2xx status; `reason` is the Status reason, or derived from the code the way client-go does. */
export class KubeError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }

  static from(method: string, path: string, status: number, body: string): KubeError {
    let parsed: Partial<Status> = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const derived = status === 409 ? (method === 'POST' ? 'AlreadyExists' : 'Conflict') : (DERIVED[status] ?? 'Unknown');
    return parsed.kind === 'Status'
      ? new KubeError(status, parsed.reason || derived, parsed.message ?? '')
      : new KubeError(status, derived, `${method} ${path} answered ${status}: ${body.trim()}`);
  }
}

const DERIVED: Readonly<Record<number, string>> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'NotFound', 410: 'Expired', 422: 'Invalid' };

export type KubeConfig = {
  readonly server: string;
  readonly ca?: string | Buffer;
  readonly token: () => Promise<string>;
  readonly namespace: string;
  readonly timeoutMs?: number;
};

const query = (params: Readonly<Record<string, string | number | undefined>>): string => {
  const defined = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  return defined.length ? `?${new URLSearchParams(defined.map(([key, value]) => [key, String(value)]))}` : '';
};

async function read(res: IncomingMessage): Promise<string> {
  res.setEncoding('utf8');
  let body = '';
  try {
    for await (const chunk of res) body += chunk;
  } catch (error) {
    throw Object.assign(new Unavailable('container'), { cause: error });
  }
  return body;
}

/** Newline-delimited lines; utf8 decoding keeps a character split across chunks whole. */
async function* lines(res: IncomingMessage): AsyncGenerator<string> {
  res.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of res) {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
}

export const tokenFile = (path: string) => async (): Promise<string> => (await readFile(path, 'utf8')).trim();

export class KubeClient {
  readonly namespace: string;
  readonly #server: string;
  readonly #token: () => Promise<string>;
  readonly #timeoutMs: number;
  readonly #transport: typeof http | typeof https;
  readonly #agent: http.Agent;

  constructor(config: KubeConfig) {
    this.namespace = config.namespace;
    this.#server = config.server.replace(/\/$/, '');
    this.#token = config.token;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    const secure = new URL(this.#server).protocol === 'https:';
    this.#transport = secure ? https : http;
    this.#agent = secure ? new https.Agent({ keepAlive: true, ca: config.ca }) : new http.Agent({ keepAlive: true });
  }

  /** A 409 throws KubeError `AlreadyExists`; a caller that creates by deterministic name treats it as success. */
  async create<K extends Writable>(kind: K, object: Objects[K]): Promise<Objects[K]> {
    return JSON.parse(await this.#call('POST', this.#path(kind), object));
  }

  async get<K extends Writable>(kind: K, name: string): Promise<Objects[K]> {
    return JSON.parse(await this.#call('GET', this.#path(kind, name)));
  }

  /** With `uid`, only the object of that uid is deleted; another one under the name answers 409 Conflict. */
  async delete<K extends Writable>(kind: K, name: string, options: { readonly gracePeriodSeconds?: number; readonly uid?: string } = {}): Promise<Objects[K]> {
    const { gracePeriodSeconds, uid } = options;
    const body = { apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds, preconditions: uid === undefined ? undefined : { uid } };
    return JSON.parse(await this.#call('DELETE', this.#path(kind, name), body));
  }

  async list<K extends Listable>(kind: K, selectors: Selectors = {}): Promise<List<Objects[K]>> {
    return JSON.parse(await this.#call('GET', this.#path(kind) + query(selectors)));
  }

  async log(pod: string, options: { readonly container?: string; readonly tailLines?: number; readonly limitBytes?: number } = {}): Promise<string> {
    return this.#call('GET', this.#path('pods', pod, 'log') + query(options));
  }

  /**
   * Events until `signal` aborts. Without `resourceVersion` the current objects arrive first as ADDED. A server-closed
   * stream resumes from the last resourceVersion seen; an expired one (410) lists again and resumes from the list's
   * resourceVersion, sending the listed objects as ADDED, so a change missed in the gap still arrives as current state.
   */
  async *watch<K extends Listable>(kind: K, options: WatchOptions): AsyncGenerator<WatchEvent<Objects[K]>> {
    const { labelSelector, signal } = options;
    let resourceVersion = options.resourceVersion;
    while (!signal.aborted) {
      let expired = false;
      try {
        const path = this.#path(kind) + query({ watch: 'true', allowWatchBookmarks: 'true', labelSelector, resourceVersion });
        const res = await this.#open('GET', path, signal);
        try {
          if (res.statusCode === 410) {
            res.resume();
            expired = true;
          } else if (res.statusCode !== 200) {
            throw KubeError.from('GET', path, res.statusCode ?? 0, await read(res));
          } else {
            for await (const line of lines(res)) {
              const event = JSON.parse(line) as WatchEvent<Objects[K]> | { type: 'ERROR'; object: Status };
              if (event.type === 'ERROR') {
                if (event.object.code === 410) {
                  expired = true;
                  break;
                }
                throw new KubeError(event.object.code ?? 0, event.object.reason ?? 'Unknown', event.object.message ?? '');
              }
              resourceVersion = event.object.metadata.resourceVersion;
              yield event;
            }
          }
        } finally {
          res.destroy();
        }
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (expired) {
        const listed = await this.list(kind, { labelSelector });
        resourceVersion = listed.metadata.resourceVersion;
        for (const object of listed.items) yield { type: 'ADDED', object };
      }
    }
  }

  #path(kind: Kind, name?: string, sub?: string): string {
    const scope = NAMESPACED[kind] ? `/namespaces/${this.namespace}` : '';
    return `/api/v1${scope}/${kind}${name ? `/${name}` : ''}${sub ? `/${sub}` : ''}`;
  }

  async #call(method: string, path: string, body?: unknown): Promise<string> {
    const res = await this.#open(method, path, AbortSignal.timeout(this.#timeoutMs), body);
    const text = await read(res);
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) throw KubeError.from(method, path, status, text);
    return text;
  }

  /** No answer at all (refused, timed out, TLS rejected) is Unavailable, so the Guard does not count it against the app. */
  async #open(method: string, path: string, signal: AbortSignal, body?: unknown): Promise<IncomingMessage> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: http.OutgoingHttpHeaders = { authorization: `Bearer ${await this.#token()}`, accept: 'application/json' };
    if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    return new Promise((resolve, reject) => {
      const req = this.#transport.request(this.#server + path, { method, headers, agent: this.#agent, signal }, resolve);
      req.on('error', (error) => reject(Object.assign(new Unavailable('container'), { cause: error })));
      req.end(payload);
    });
  }
}

const ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

/** In a Pod: the API server from the service env, `ca.crt` read once, the projected token re-read per request since it rotates. */
export async function inClusterClient(namespace?: string): Promise<KubeClient> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) throw new Error('KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT are unset; the gateway is not running in a Pod');
  return new KubeClient({
    server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    ca: await readFile(`${ACCOUNT}/ca.crt`),
    token: tokenFile(`${ACCOUNT}/token`),
    namespace: namespace ?? (await readFile(`${ACCOUNT}/namespace`, 'utf8')).trim(),
  });
}
