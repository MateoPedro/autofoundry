import type { Db } from "../db";

// Scout runs all 8 playbooks every 3 hours (scripts/scout-playbooks.ts). When every Scout run of the
// current cycle has ended, start one Compliance screen session for the batch. Each Scout deployment's
// on_idle webhook calls this; it never trusts the webhook body and re-reads session state instead.
export const CYCLE_HOURS = 3;
export const PLAYBOOK_COUNT = 8;
const ENDED = new Set(["idle", "completed", "failed", "cancelled"]);

export type CycleNaive = {
  // Scout sessions created at or after `since`, newest first.
  scoutSessionsSince(since: Date): Promise<{ id: string; status: string; created_at: string }[]>;
  startComplianceScreen(idempotencyKey: string): Promise<{ id: string }>;
};

export function cycleStart(now: Date) {
  const ms = CYCLE_HOURS * 3_600_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export async function onScoutIdle(db: Db, naive: CycleNaive, now: Date) {
  const start = cycleStart(now);
  const sessions = await naive.scoutSessionsSince(start);
  const running = sessions.filter((s) => !ENDED.has(s.status)).length;
  if (sessions.length < PLAYBOOK_COUNT || running) {
    return { cycle_start: start.toISOString(), started: false, reason: "waiting for Scout", scout_runs: sessions.length, still_running: running };
  }
  const [claimed] = await db.query<{ cycle_start: Date }>(
    "insert into screen_triggers (cycle_start) values ($1) on conflict do nothing returning cycle_start",
    [start],
  );
  if (!claimed) return { cycle_start: start.toISOString(), started: false, reason: "already started for this cycle" };
  let session: { id: string };
  try {
    session = await naive.startComplianceScreen(`screen-${start.toISOString()}`);
  } catch (error) {
    // Release the claim so the next Scout idle event can try again; the fallback cron also covers it.
    await db.query("delete from screen_triggers where cycle_start = $1 and session_id is null", [start]);
    throw error;
  }
  await db.query("update screen_triggers set session_id = $2 where cycle_start = $1", [start, session.id]);
  return { cycle_start: start.toISOString(), started: true, session_id: session.id };
}
