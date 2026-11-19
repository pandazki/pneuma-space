export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlDatabase {
  query(sql: string, ...bindings: SqlValue[]): SqlRow[];
  transaction<T>(operation: () => T): T;
}
