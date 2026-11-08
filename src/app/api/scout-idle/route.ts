import { timingSafeEqual } from "node:crypto";
import { createPgDb, type Db } from "@/lib/server/db";
import { recordScoutIdle } from "@/lib/server/foundry/cycle";

export const dynamic = "force-dynamic";

// Each Scout deployment's on_idle webhook: records that one Scout run of the cycle ended, so
// Compliance's screen_batch can start as soon as every scheduled run has. The body is ignored. The token in the URL
// (SCOUT_IDLE_TOKEN, an app secret) stops strangers from adding pings; at worst a forged ping makes
// the screen start a little early, and it still screens only what is saved.
let db: Db | undefined;

function tokenMatches(given: string | null, expected: string | undefined) {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!tokenMatches(new URL(request.url).searchParams.get("token"), process.env.SCOUT_IDLE_TOKEN?.trim())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = process.env.DATABASE_URL;
  if (!url) return Response.json({ error: "not configured" }, { status: 503 });
  db ??= createPgDb(url);
  return Response.json(await recordScoutIdle(db, new Date()));
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
