import { DatabaseSync } from 'node:sqlite';
import { need } from './env.ts';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;
export type Db = {
  query<T extends Row = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  exec(sql: string, params?: readonly SqlValue[]): Promise<void>;
};

export function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\?/g, (token) => (token === '?' ? `$${++n}` : token));
}

function sqlite(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  return {
    async query<T extends Row>(sql: string, params: readonly SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async exec(sql, params) {
      if (params?.length) db.prepare(sql).run(...params);
      else db.exec(sql);
    },
  };
}

function postgres(url: string): Db {
  const pool = import('pg').then(({ default: pg }) => new pg.Pool({ connectionString: url }));
  return {
    async query<T extends Row>(sql: string, params: readonly SqlValue[] = []) {
      return (await (await pool).query(toPg(sql), [...params])).rows as T[];
    },
    async exec(sql, params = []) {
      await (await pool).query(params.length ? toPg(sql) : sql, params.length ? [...params] : undefined);
    },
  };
}

let shared: Db | undefined;

export function db(): Db {
  if (shared) return shared;
  const url = need('db').url;
  const scheme = url.slice(0, url.indexOf(':'));
  if (scheme === 'sqlite') shared = sqlite(decodeURIComponent(new URL(url).pathname));
  else if (scheme === 'postgresql' || scheme === 'postgres') shared = postgres(url);
  else throw new Error(`PNEUMA_SPACE_DB_URL scheme "${scheme}" is neither sqlite nor postgresql`);
  return shared;
}
