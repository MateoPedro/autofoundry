import type { Db } from "../db";

export async function isRunning(db: Db): Promise<boolean> {
  const [row] = await db.query<{ running: boolean }>("select running from foundry_state where id = 1");
  return row?.running ?? false;
}

export async function setRunning(db: Db, running: boolean, at: Date): Promise<void> {
  await db.query("update foundry_state set running = $1, changed_at = $2 where id = 1", [running, at.toISOString()]);
}

export async function stateOf(db: Db): Promise<{ running: boolean; changed_at: string }> {
  const [row] = await db.query<{ running: boolean; changed_at: Date | string }>("select running, changed_at from foundry_state where id = 1");
  return { running: row?.running ?? false, changed_at: new Date(row.changed_at).toISOString() };
}
