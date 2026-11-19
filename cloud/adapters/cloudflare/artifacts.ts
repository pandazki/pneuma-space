/// <reference types="@cloudflare/workers-types" />
import type { AppId } from '../../../shared/values.ts';
import { sha256 } from '../../core/crypto.ts';
import { CloudError } from '../../core/errors.ts';
import type { Artifact, ArtifactStore, PreparedArtifact } from '../../core/model.ts';

export interface ArtifactIndex {
  reserve(appId: AppId, digest: string): Promise<void>;
  purge(appId: AppId): Promise<string[]>;
}

export class R2Artifacts implements ArtifactStore {
  readonly #bucket: R2Bucket;
  readonly #limit: number;
  readonly #index: ArtifactIndex;

  constructor(bucket: R2Bucket, limit: number, index: ArtifactIndex) { this.#bucket = bucket; this.#limit = limit; this.#index = index; }

  #prefix(appId: AppId): string {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(appId)) throw new Error('Invalid artifact identity.');
    return `apps/${appId}/`;
  }

  #key(appId: AppId, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid artifact digest.');
    return this.#prefix(appId) + digest + '.json';
  }

  #tombstone(appId: AppId): string { this.#prefix(appId); return `purged/${appId}`; }

  async put(appId: AppId, prepared: PreparedArtifact): Promise<void> {
    const key = this.#key(appId, prepared.digest);
    const content = JSON.stringify(prepared.artifact);
    if (new TextEncoder().encode(content).byteLength > this.#limit || await sha256(content) !== prepared.digest) {
      throw new Error('Artifact digest or size mismatch.');
    }
    await this.#index.reserve(appId, prepared.digest);
    const stored = await this.#bucket.put(key, content, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    if (!stored) await this.get(appId, prepared.digest);
  }

  async get(appId: AppId, digest: string): Promise<Artifact> {
    if (await this.#bucket.head(this.#tombstone(appId))) throw new CloudError(404, 'not_found', 'Application artifact not found.');
    const object = await this.#bucket.get(this.#key(appId, digest));
    if (!object || object.customMetadata?.pneuma_space_purged === '1') throw new CloudError(404, 'not_found', 'Application artifact not found.');
    if (object.size > this.#limit) throw new Error('Stored artifact exceeds its limit.');
    const content = await object.text();
    if (await sha256(content) !== digest) throw new Error('Stored artifact digest mismatch.');
    return JSON.parse(content) as Artifact;
  }

  async destroy(appId: AppId): Promise<void> {
    const digests = await this.#index.purge(appId);
    await this.#bucket.put(this.#tombstone(appId), '1');
    for (const digest of digests) await this.#mark(this.#key(appId, digest));
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list({ prefix: this.#prefix(appId), cursor, limit: 1000 });
      for (const object of page.objects) if (object.size > 0) await this.#mark(object.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }

  async #mark(key: string): Promise<void> {
    await this.#bucket.put(key, '', { customMetadata: { pneuma_space_purged: '1' } });
  }
}
