import { timingSafeEqual } from "node:crypto";
import { createPgDb, type Db } from "@/lib/server/db";
import { onScoutIdle } from "@/lib/server/foundry/cycle";
import { createCycleNaive } from "@/lib/server/naive";

export const dynamic = "force-dynamic";

// Each Scout deployment's on_idle webhook. The body is ignored: the handler re-reads Scout's sessions
// from Naïve and starts the Compliance screen once all 8 runs of the cycle have ended. The token in the
// URL (SCOUT_IDLE_TOKEN, an app secret) only stops strangers from triggering that check.
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
  const naive = createCycleNaive(process.env);
  const url = process.env.DATABASE_URL;
  if (!naive || !url) return Response.json({ error: "not configured" }, { status: 503 });
  db ??= createPgDb(url);
  try {
    return Response.json(await onScoutIdle(db, naive, new Date()));
  } catch (error) {
    console.error("scout idle trigger failed", error);
    return Response.json({ error: "trigger failed" }, { status: 502 });
  }
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
