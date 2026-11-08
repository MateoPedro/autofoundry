import { timingSafeEqual } from "node:crypto";
import { appContext } from "@/lib/server/context";
import { recordScoutIdle } from "@/lib/server/foundry/cycle";

export const dynamic = "force-dynamic";

// Each Scout deployment's on_idle webhook: records that one Scout run of the cycle ended, and the
// cycle's last ping wakes Compliance to screen the batch. The body is ignored. The token in the URL
// (SCOUT_IDLE_TOKEN, an app secret) stops strangers from adding pings; at worst a forged ping makes
// the screen start a little early, and it still screens only what is saved.

function tokenMatches(given: string | null, expected: string | undefined) {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!tokenMatches(new URL(request.url).searchParams.get("token"), process.env.SCOUT_IDLE_TOKEN?.trim())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.DATABASE_URL) return Response.json({ error: "not configured" }, { status: 503 });
  return Response.json(await recordScoutIdle(appContext(), new Date()));
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
