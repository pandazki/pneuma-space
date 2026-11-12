import type { SqlDatabase } from './sql.ts';

export interface StateStore<T> {
  read(): T;
  update<R>(change: (state: T) => R): R;
}

export class SqlState<T> implements StateStore<T> {
  readonly #database: SqlDatabase;
  readonly #key: string;
  readonly #initial: () => T;

  constructor(database: SqlDatabase, key: string, initial: () => T) {
    this.#database = database;
    this.#key = key;
    this.#initial = initial;
    database.query('CREATE TABLE IF NOT EXISTS pneuma_space_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  read(): T {
    const row = this.#database.query('SELECT value FROM pneuma_space_state WHERE key = ?', this.#key)[0];
    if (!row) return this.#initial();
    if (typeof row.value !== 'string') throw new Error('Invalid stored state.');
    return JSON.parse(row.value) as T;
  }

  update<R>(change: (state: T) => R): R {
    return this.#database.transaction(() => {
      const state = this.read();
      const result = change(state);
      this.#database.query('INSERT OR REPLACE INTO pneuma_space_state (key, value) VALUES (?, ?)', this.#key, JSON.stringify(state));
      return result;
    });
  }
}
