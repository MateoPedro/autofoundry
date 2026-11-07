import postgres from "postgres";

export type Db = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
};

type Runner = { unsafe: (sql: string, params?: never[]) => Promise<unknown> };

function wrap(runner: Runner, begin: (fn: (inner: Runner) => Promise<unknown>) => Promise<unknown>): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await runner.unsafe(sql, params as never[])) as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      return (await begin((inner) => fn(wrap(inner, (nested) => nested(inner))))) as T;
    },
  };
}

// prepare: false because Supabase's pooler runs in transaction mode.
export function createPgDb(url: string): Db {
  const sql = postgres(url, { prepare: false, max: 5 });
  return wrap(sql, (fn) => sql.begin((inner) => fn(inner as unknown as Runner)));
}
