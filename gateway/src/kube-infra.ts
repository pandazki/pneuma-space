// Infra of the kubernetes plane: image references resolve to digests in the organization's registry (ADR 0019 item 6).
import { readFile } from 'node:fs/promises';
import { Conflict, type ImageId, type Infra, type JobResult } from './model.ts';

const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

type Reference = { readonly host: string; readonly repo: string; readonly ref: string };
type DockerConfig = { readonly auths?: Readonly<Record<string, { readonly auth?: string; readonly username?: string; readonly password?: string }>> };

const named = (first: string): boolean => first.includes('.') || first.includes(':') || first === 'localhost';

/** `host/repo:tag` or `host/repo@sha256:…`; a reference without a host is under `registry`. */
export function parseReference(reference: string, registry: string | null): Reference {
  const slash = reference.indexOf('/');
  if (slash < 0 || !named(reference.slice(0, slash))) {
    if (!registry) throw new Error(`image reference "${reference}" names no registry and PNEUMA_SPACE_REGISTRY is unset`);
    return parseReference(`${registry.replace(/\/$/, '')}/${reference}`, null);
  }
  const host = reference.slice(0, slash);
  const path = reference.slice(slash + 1);
  const at = path.indexOf('@');
  if (at >= 0) return { host, repo: path.slice(0, at), ref: path.slice(at + 1) };
  const colon = path.lastIndexOf(':');
  return colon > path.lastIndexOf('/') ? { host, repo: path.slice(0, colon), ref: path.slice(colon + 1) } : { host, repo: path, ref: 'latest' };
}

const hostOf = (key: string): string => key.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
/** Plain HTTP only for a registry on this machine, as Docker allows. */
const scheme = (host: string): string => (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');

export type KubeInfraOptions = {
  /** PNEUMA_SPACE_REGISTRY. */
  readonly registry: string | null;
  /** PNEUMA_SPACE_REGISTRY_AUTH: a dockerconfigjson file, read per call so a rotated Secret applies. */
  readonly authFile: string | null;
};

export class KubeInfra implements Infra {
  readonly #registry: string | null;
  readonly #authFile: string | null;

  constructor(options: KubeInfraOptions) {
    this.#registry = options.registry;
    this.#authFile = options.authFile;
  }

  /** Providers stop using jobs with ADR 0025 item 9; until then no job runs on this plane. */
  async runJob(): Promise<JobResult> {
    throw new Conflict('the kubernetes plane runs no provisioning jobs (ADR 0025 item 9)');
  }

  /** `HEAD /v2/<repo>/manifests/<ref>`; a 401 is answered once, with Basic credentials or a Bearer token exchanged for them. Null when the registry has no such image. */
  async resolveImage(reference: string): Promise<ImageId | null> {
    const { host, repo, ref } = parseReference(reference, this.#registry);
    const url = `${scheme(host)}://${host}/v2/${repo}/manifests/${ref}`;
    const head = (authorization: string | null) => fetch(url, { method: 'HEAD', headers: { accept: MANIFESTS, ...(authorization ? { authorization } : {}) } });
    let res = await head(null);
    if (res.status === 401) {
      const basic = await this.#basic(host);
      const challenge = res.headers.get('www-authenticate') ?? '';
      const authorization = /^bearer /i.test(challenge) ? `Bearer ${await this.#token(challenge, repo, basic)}` : basic;
      if (!authorization) throw new Error(`registry ${host} asks for credentials and PNEUMA_SPACE_REGISTRY_AUTH has none for it`);
      res = await head(authorization);
    }
    if (res.status === 404) return null;
    const digest = res.headers.get('docker-content-digest');
    if (!res.ok || !digest) throw new Error(`registry ${host} answered ${res.status}${digest ? '' : ' without Docker-Content-Digest'} for ${repo}:${ref}`);
    return `${host}/${repo}@${digest}` as ImageId;
  }

  async #basic(host: string): Promise<string | null> {
    if (!this.#authFile) return null;
    const config = JSON.parse(await readFile(this.#authFile, 'utf8')) as DockerConfig;
    const entry = Object.entries(config.auths ?? {}).find(([key]) => hostOf(key) === host)?.[1];
    if (!entry) return null;
    return `Basic ${entry.auth ?? Buffer.from(`${entry.username}:${entry.password}`).toString('base64')}`;
  }

  async #token(challenge: string, repo: string, basic: string | null): Promise<string> {
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    if (!params.realm) throw new Error(`registry challenge has no realm: ${challenge}`);
    const url = new URL(params.realm);
    if (params.service) url.searchParams.set('service', params.service);
    url.searchParams.set('scope', params.scope ?? `repository:${repo}:pull`);
    const res = await fetch(url, { headers: basic ? { authorization: basic } : {} });
    if (!res.ok) throw new Error(`registry token endpoint ${url.origin} answered ${res.status}`);
    const body = (await res.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new Error(`registry token endpoint ${url.origin} returned no token`);
    return token;
  }
}
