import type { Db } from "./db";

// Agents write these pages, so they get no scripts, no forms and an opaque origin.
const POLICY = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; sandbox";

export async function serveSample(db: Db, leadId: string): Promise<Response> {
  const [sample] = /^ld_[a-z0-9]+$/.test(leadId) ? await db.query<{ html: string }>("select html from samples where lead_id = $1", [leadId]) : [];
  if (!sample) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(sample.html, {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": POLICY, "x-content-type-options": "nosniff" },
  });
}
