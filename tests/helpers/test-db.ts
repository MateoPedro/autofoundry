import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after } from "node:test";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import postgres from "postgres";
import { fromPostgres, type Db } from "../../src/lib/server/db";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

async function migrationSql(): Promise<string> {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  return (await Promise.all(files.map((f) => readFile(join(MIGRATIONS, f), "utf8")))).join("\n");
}

type Runner = Pick<PGlite, "query"> | Transaction;

function wrapPglite(runner: Runner, pg: PGlite, inTx: boolean): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await runner.query<T>(sql, params)).rows;
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      if (inTx) return fn(wrapPglite(runner, pg, true));
      return pg.transaction((t) => fn(wrapPglite(t, pg, true)));
    },
  };
}

const openClients: postgres.Sql[] = [];
after(async () => {
  await Promise.all(openClients.map((sql) => sql.end({ timeout: 1 })));
});

// With TEST_DATABASE_URL set, each test gets a fresh database on that real Postgres server,
// through the same driver production uses. Otherwise it gets an in-memory PGlite database.
async function createRealDb(adminUrl: string): Promise<Db> {
  const name = `foundry_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  openClients.push(admin);
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { prepare: false, max: 5, onnotice: () => {} });
  openClients.push(sql);
  await sql.unsafe(await migrationSql());
  return fromPostgres(sql);
}

export async function createTestDb(): Promise<Db> {
  const realUrl = process.env.TEST_DATABASE_URL;
  if (realUrl) return createRealDb(realUrl);
  const pg = new PGlite();
  await pg.exec(await migrationSql());
  return wrapPglite(pg, pg, false);
}
