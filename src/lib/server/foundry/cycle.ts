import type { Db } from "../db";

// Scout runs its scheduled playbooks every 3 hours (SCHEDULED_PLAYBOOKS in scripts/scout-playbooks.ts).
// Each Scout deployment's on_idle webhook records that one run of the cycle ended. Compliance polls
// screen_batch every 10 minutes early in the cycle; the batch is ready once every run has ended, or 90 minutes into the
// cycle at the latest (a run that hangs or a webhook that never arrives can't block the screen).
export const CYCLE_HOURS = 3;
// Must equal SCHEDULED_PLAYBOOKS.length; a test checks it.
export const RUNS_PER_CYCLE = 4;
export const READY_AFTER_MINUTES = 90;

export function cycleStart(now: Date) {
  const ms = CYCLE_HOURS * 3_600_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export async function recordScoutIdle(db: Db, now: Date) {
  const start = cycleStart(now);
  await db.query("insert into scout_pings (cycle_start, received_at) values ($1, $2)", [start, now]);
  const [row] = await db.query<{ n: number }>("select count(*)::int as n from scout_pings where cycle_start = $1", [start]);
  return { cycle_start: start.toISOString(), scout_runs_ended: row.n };
}

export async function batchReady(db: Db, now: Date) {
  const start = cycleStart(now);
  const [row] = await db.query<{ n: number }>("select count(*)::int as n from scout_pings where cycle_start = $1", [start]);
  const minutes = Math.floor((now.getTime() - start.getTime()) / 60_000);
  const ready = row.n >= RUNS_PER_CYCLE || minutes >= READY_AFTER_MINUTES;
  return { ready, cycle_start: start.toISOString(), scout_runs_ended: row.n, minutes_into_cycle: minutes };
}
