/// <reference types="@cloudflare/workers-types" />
import type { SqlDatabase, SqlRow, SqlValue } from '../../core/sql.ts';

export class DurableSqlDatabase implements SqlDatabase {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) { this.#storage = storage; }

  query(sql: string, ...bindings: SqlValue[]): SqlRow[] {
    return Array.from(this.#storage.sql.exec(sql, ...bindings), row =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof ArrayBuffer ? new Uint8Array(value) : value])));
  }

  transaction<T>(operation: () => T): T { return this.#storage.transactionSync(operation); }
}
