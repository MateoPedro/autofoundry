import type { Db } from "../db";
import type { CrewSession, ToolContext } from "./tool";

// Sessions of these crew agents can be charged to a company; the rest are parent overhead.
const BILLED_ROLES = ["outreach", "closer", "creator"];
const INBOUND = "closer:inbound:";

// A card wake is charged to the company of the first woken card that has one, and an inbound
// email to the company whose lead the Closer logged it against.
export async function companyOfSession(db: Db, session: Pick<CrewSession, "card_ids" | "inbound_message_id">): Promise<string | null> {
  const cards = session.card_ids.length
    ? await db.query<{ key: string; company_id: string | null }>(
        "select key, company_id from work_cards where card_id = any($1) order by array_position($1, card_id)",
        [session.card_ids],
      )
    : [];
  const charged = cards.find((c) => c.company_id);
  if (charged) return charged.company_id;
  // A sweep's "Answer email" card names the message, which the Closer logs against the lead.
  const messages = [session.inbound_message_id, ...cards.filter((c) => c.key.startsWith(INBOUND)).map((c) => c.key.slice(INBOUND.length))].filter(
    (id): id is string => !!id,
  );
  if (!messages.length) return null;
  const [touch] = await db.query<{ company_id: string }>("select company_id from touches where message_id = any($1) limit 1", [messages]);
  return touch?.company_id ?? null;
}

export async function syncSessionSpend(ctx: ToolContext, since: Date): Promise<number> {
  if (!ctx.naive) return 0;
  const naive = ctx.naive;
  const crew = await ctx.db.query<{ role: string; agent_id: string }>("select role, agent_id from crew where role = any($1)", [BILLED_ROLES]);
  let count = 0;
  for (const member of crew) {
    for (const session of await naive.sessionsSince(member.agent_id, since)) {
      const companyId = await companyOfSession(ctx.db, session);
      await ctx.db.query(
        `insert into session_spend (session_id, agent_name, company_id, micro_usd, started_at, synced_at) values ($1, $2, $3, $4, $5, $6)
         on conflict (session_id) do update set company_id = excluded.company_id, micro_usd = excluded.micro_usd, synced_at = excluded.synced_at`,
        [session.id, member.role, companyId, session.consumed_micro_usd, session.created_at, ctx.now()],
      );
      count++;
    }
  }
  return count;
}

export async function companySpend(db: Db, companyId: string): Promise<number> {
  const [{ spent }] = await db.query<{ spent: unknown }>("select coalesce(sum(micro_usd), 0) as spent from session_spend where company_id = $1", [companyId]);
  return Number(spent);
}
