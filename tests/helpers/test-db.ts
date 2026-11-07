import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db } from "../../src/lib/server/db";

const MIGRATION = join(import.meta.dirname, "../../migrations/0001_foundry.sql");

type Runner = Pick<PGlite, "query"> | Transaction;

function wrap(runner: Runner, pg: PGlite, inTx: boolean): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await runner.query<T>(sql, params)).rows;
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      if (inTx) return fn(wrap(runner, pg, true));
      return pg.transaction((t) => fn(wrap(t, pg, true)));
    },
  };
}

export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(await readFile(MIGRATION, "utf8"));
  return wrap(pg, pg, false);
}
