import { CloudError, forbidden, quota } from './errors.ts';
import type { ArtifactStore, ExecutionHost, Invocation, Limits, ResourceDirectory } from './model.ts';
import type { Records } from './records-contract.ts';

export async function runWithDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CloudError(504, 'invocation_timeout', 'Invocation deadline exceeded.')), milliseconds);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (signal?.aborted) throw new CloudError(504, 'invocation_timeout', 'Invocation was aborted.');
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        void reader.cancel('Body exceeds the byte limit.').catch(() => {});
        throw new CloudError(413, 'body_too_large', 'Body exceeds the byte limit.');
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class FetchRuntime {
  readonly #host: ExecutionHost;
  readonly #artifacts: ArtifactStore;
  readonly #resources: ResourceDirectory;
  readonly #limits: Limits;
  readonly #now: () => number;

  constructor(options: {
    host: ExecutionHost; artifacts: ArtifactStore; resources: ResourceDirectory; limits: Limits; now?: () => number;
  }) {
    this.#host = options.host;
    this.#artifacts = options.artifacts;
    this.#resources = options.resources;
    this.#limits = options.limits;
    this.#now = options.now ?? Date.now;
  }

  acquire(invocation: Invocation): { fetch(request: Request): Promise<Response> } {
    let used = false;
    return { fetch: async request => {
      if (used) forbidden('An invocation can be used only once.');
      used = true;
      if (request.headers.get('Upgrade')) throw new CloudError(400, 'unsupported_upgrade', 'Protocol upgrades are unavailable.');
      const expiresAt = Math.min(invocation.expiresAt, this.#now() + this.#limits.deadlineMs);
      if (expiresAt <= this.#now()) forbidden('Invocation has expired.');
      let open = true;
      let operations = 0;
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      const recordsAccess = invocation.records;
      const resource = recordsAccess ? this.#resources.records(invocation.appId) : null;
      const check = () => {
        if (!open || this.#now() >= expiresAt || controller.signal.aborted) forbidden('Records access has expired.');
        if (++operations > this.#limits.recordOperations) quota('Records operation limit exceeded.');
      };
      const records: Records | null = resource && recordsAccess ? {
        get: async key => { check(); return resource.get({ ...recordsAccess, expiresAt }, key); },
        list: async options => { check(); return resource.list({ ...recordsAccess, expiresAt }, options); },
        commit: async changes => { check(); return resource.commit({ ...recordsAccess, expiresAt }, changes); },
      } : null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          open = false;
          controller.abort('Invocation deadline exceeded.');
          reject(new CloudError(504, 'invocation_timeout', 'Invocation deadline exceeded.'));
        }, expiresAt - this.#now());
      });
      const run = async () => {
        const body = await readBoundedBody(request.body, this.#limits.requestBytes, controller.signal);
        const headers = new Headers(request.headers);
        headers.delete('Content-Length');
        const bounded = new Request(request.url, {
          method: request.method, headers, redirect: 'manual', signal: controller.signal,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
        });
        const artifact = await this.#artifacts.get(invocation.appId, invocation.release.digest);
        if (controller.signal.aborted) throw new CloudError(504, 'invocation_timeout', 'Invocation was aborted.');
        const response = await this.#host.invoke(invocation, artifact, bounded, records);
        if (!(response instanceof Response)) throw new CloudError(502, 'invalid_response', 'Application returned an invalid response.');
        if (response.status === 101) throw new CloudError(502, 'unsupported_upgrade', 'Protocol upgrades are unavailable.');
        const bytes = await readBoundedBody(response.body, this.#limits.responseBytes, controller.signal);
        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete('Content-Length');
        return new Response(request.method === 'HEAD' || [204, 205, 304].includes(response.status) ? null : bytes, {
          status: response.status, statusText: response.statusText, headers: responseHeaders,
        });
      };
      try {
        return await Promise.race([run(), timeout]);
      } finally {
        open = false;
        if (timer !== undefined) clearTimeout(timer);
        request.signal.removeEventListener('abort', abort);
      }
    } };
  }
}
