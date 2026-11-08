import postgres from "postgres";

export type Db = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
};

type Runner = { unsafe: (sql: string, params?: never[]) => Promise<unknown> };

function wrap(runner: Runner, begin: (fn: (inner: Runner) => Promise<unknown>) => Promise<unknown>): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return Array.from((await runner.unsafe(sql, params as never[])) as T[]);
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      return (await begin((inner) => fn(wrap(inner, (nested) => nested(inner))))) as T;
    },
  };
}

export function fromPostgres(sql: postgres.Sql): Db {
  return wrap(sql, (fn) => sql.begin((inner) => fn(inner as unknown as Runner)));
}

// prepare: false because Supabase's pooler runs in transaction mode. Short idle and connect
// timeouts suit serverless instances that get suspended between requests.
export function createPgDb(url: string): Db {
  return fromPostgres(postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10 }));
}
