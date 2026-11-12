import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppId } from '../../../shared/values.ts';
import { sha256 } from '../../core/crypto.ts';
import { conflict } from '../../core/errors.ts';
import type { Artifact, ArtifactStore, PreparedArtifact } from '../../core/model.ts';
import { LocalSqliteDatabase } from './sqlite.ts';

export class LocalArtifacts implements ArtifactStore {
  readonly #directory: string;
  readonly #database: LocalSqliteDatabase;

  constructor(directory: string) {
    this.#directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#database = new LocalSqliteDatabase(join(directory, 'artifacts.sqlite'));
    this.#database.query('CREATE TABLE IF NOT EXISTS pneuma_space_artifacts (app TEXT PRIMARY KEY, purged INTEGER NOT NULL)');
  }

  #path(appId: AppId, digest?: string): string {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(appId) || (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))) throw new Error('Invalid artifact identity.');
    return digest === undefined ? join(this.#directory, appId) : join(this.#directory, appId, digest + '.json');
  }

  async put(appId: AppId, prepared: PreparedArtifact): Promise<void> {
    const body = JSON.stringify(prepared.artifact);
    if (await sha256(body) !== prepared.digest) throw new Error('Artifact digest mismatch.');
    this.#database.transaction(() => {
      if (this.#database.query('SELECT purged FROM pneuma_space_artifacts WHERE app = ?', appId)[0]?.purged === 1) conflict('Artifacts have been purged.');
      this.#database.query('INSERT OR IGNORE INTO pneuma_space_artifacts (app, purged) VALUES (?, 0)', appId);
      mkdirSync(this.#path(appId), { recursive: true, mode: 0o700 });
      try { writeFileSync(this.#path(appId, prepared.digest), body, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
        if (readFileSync(this.#path(appId, prepared.digest), 'utf8') !== body) throw new Error('Stored artifact digest mismatch.');
      }
    });
  }

  async get(appId: AppId, digest: string): Promise<Artifact> {
    const body = readFileSync(this.#path(appId, digest), 'utf8');
    if (await sha256(body) !== digest) throw new Error('Stored artifact digest mismatch.');
    return JSON.parse(body) as Artifact;
  }

  async destroy(appId: AppId): Promise<void> {
    this.#database.transaction(() => {
      this.#database.query('INSERT OR REPLACE INTO pneuma_space_artifacts (app, purged) VALUES (?, 1)', appId);
      rmSync(this.#path(appId), { recursive: true, force: true });
    });
  }

  close(): void { this.#database.close(); }
}
