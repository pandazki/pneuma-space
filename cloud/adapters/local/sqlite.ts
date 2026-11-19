import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlRow, SqlValue } from '../../core/sql.ts';

export class LocalSqliteDatabase implements SqlDatabase {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec('PRAGMA journal_mode = WAL');
  }

  query(sql: string, ...bindings: SqlValue[]): SqlRow[] {
    return this.#database.prepare(sql).all(...bindings).map(row => {
      const result: SqlRow = {};
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'bigint') throw new Error('SQLite integer exceeds the portable SQL contract.');
        result[key] = value;
      }
      return result;
    });
  }

  transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}
