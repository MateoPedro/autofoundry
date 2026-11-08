import type { Db } from "../db";
import { describe } from "./metrics";
import type { CrewRole } from "./roles";
import { isRunning } from "./state";
import { ToolError, type NaiveWriter, type ToolContext } from "./tool";

export function requireNaive(ctx: ToolContext): NaiveWriter {
  if (!ctx.naive) throw new ToolError("internal", "the foundry has no NAIVE_WRITE_KEY; the owner runs pnpm foundry:key and redeploys");
  return ctx.naive;
}

export async function naiveStep<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    console.error(`naive call failed: ${what}`, error);
    throw new ToolError("naive_error", `${what}: ${describe(error)}`);
  }
}

export type Work = { role: CrewRole; key: string; title: string; body: string; companyId: string | null; billable: boolean };

// Every title carries the ids the agent needs, because agents may not get board tools.
export const WORK = {
  screen: (cycleStart: Date): Work => {
    const iso = cycleStart.toISOString();
    return {
      role: "compliance",
      key: `compliance:screen:${iso}`,
      title: `Screen Scout batch ${iso}`,
      body: `Screen the Scout batch from ${iso}.`,
      companyId: null,
      billable: false,
    };
  },
  design: (clusterId: string): Work => ({
    role: "creator",
    key: `creator:design:${clusterId}`,
    title: `Design a company for cluster ${clusterId}`,
    body: `Design a company for cluster ${clusterId}.`,
    companyId: null,
    billable: false,
  }),
  sample: (companyId: string, grant: number): Work => ({
    role: "creator",
    key: `creator:sample:${companyId}:${grant}`,
    title: `Sample new leads for ${companyId}`,
    body: `Sample new leads for ${companyId} (grant ${grant}).`,
    companyId,
    billable: true,
  }),
  revise: (clusterId: string, companyId: string): Work => ({
    role: "creator",
    key: `creator:revise:${companyId}`,
    title: `Revise the offer for cluster ${clusterId} after ${companyId} was killed`,
    body: `Revise the offer for cluster ${clusterId} after ${companyId} was killed.`,
    companyId: null,
    billable: false,
  }),
  sibling: (companyId: string): Work => ({
    role: "creator",
    key: `creator:sibling:${companyId}`,
    title: `Consider a sibling of ${companyId}`,
    body: `Consider a sibling of ${companyId}.`,
    companyId: null,
    billable: false,
  }),
  contact: (leadId: string, companyId: string): Work => ({
    role: "outreach",
    key: `outreach:contact:${leadId}`,
    title: `Contact ${leadId} for ${companyId}`,
    body: `Contact ${leadId} for ${companyId}.`,
    companyId,
    billable: true,
  }),
  followUp: (leadId: string, companyId: string): Work => ({
    role: "outreach",
    key: `outreach:followup:${leadId}`,
    title: `Follow up ${leadId} for ${companyId}`,
    body: `Follow up ${leadId} for ${companyId}.`,
    companyId,
    billable: true,
  }),
  deliver: (leadId: string, companyId: string): Work => ({
    role: "closer",
    key: `closer:deliver:${leadId}`,
    title: `Deliver ${leadId} for ${companyId}`,
    body: `Deliver ${leadId} for ${companyId}.`,
    companyId,
    billable: false,
  }),
  inbound: (messageId: string, from: string): Work => ({
    role: "closer",
    key: `closer:inbound:${messageId}`,
    title: `Answer email ${messageId} from ${from}`,
    body: `Answer email ${messageId} from ${from}.`,
    companyId: null,
    billable: false,
  }),
  feedback: (decisionId: string): Work => ({
    role: "feedback",
    key: `feedback:${decisionId}`,
    title: `Write feedback through ${decisionId}`,
    body: `Write feedback through ${decisionId}.`,
    companyId: null,
    billable: false,
  }),
};

export async function crewMember(db: Db, role: CrewRole) {
  const [member] = await db.query<{ agent_id: string; board_id: string; identity_id: string | null; inbox_id: string | null; inbox_address: string | null }>(
    "select agent_id, board_id, identity_id, inbox_id, inbox_address from crew where role = $1",
    [role],
  );
  if (!member) throw new ToolError("internal", "the crew isn't set up; run pnpm crew setup");
  return member;
}

// The card key is the dedupe: an event and the sweep can both ask for the same work.
export async function wake(ctx: ToolContext, work: Work): Promise<{ created: boolean; reason?: "stopped" | "exists" | "over_grant" }> {
  if (!(await isRunning(ctx.db))) return { created: false, reason: "stopped" };
  const [seen] = await ctx.db.query("select 1 from work_cards where key = $1", [work.key]);
  if (seen) return { created: false, reason: "exists" };

  const naive = requireNaive(ctx);
  const member = await crewMember(ctx.db, work.role);
  // Naïve answers the existing card for a repeated key on the same board, so a race or a lost insert re-finds the same card instead of making a second one.
  const card = await naiveStep(`wake ${work.role}`, () =>
    naive.createCard(member.board_id, { title: work.title, body: work.body, assignee: work.role, key: work.key }),
  );
  await ctx.db.query(
    "insert into work_cards (key, role, company_id, board_id, card_id, title) values ($1, $2, $3, $4, $5, $6) on conflict (key) do nothing",
    [work.key, work.role, work.companyId, member.board_id, card.id, work.title],
  );
  return { created: true };
}

export async function closeCompanyWork(ctx: ToolContext, companyId: string): Promise<number> {
  const open = await ctx.db.query<{ key: string; board_id: string; card_id: string }>(
    "select key, board_id, card_id from work_cards where company_id = $1 and status = 'open'",
    [companyId],
  );
  if (open.length === 0) return 0;
  const naive = requireNaive(ctx);
  for (const card of open) {
    await naiveStep(`close ${card.key}`, () => naive.setCardStatus(card.board_id, card.card_id, "done"));
    await ctx.db.query("update work_cards set status = 'closed', closed_at = $2 where key = $1", [card.key, ctx.now().toISOString()]);
  }
  return open.length;
}

// A design card is in progress until Creator spawns from its cluster or logs a decision about it.
// The queue fills up to max_proposed, counting waiting companies and designs in progress.
export async function fillCreatorQueue(ctx: ToolContext): Promise<number> {
  const [{ free }] = await ctx.db.query<{ free: number }>(
    `select (select max_proposed from funding_policy)
          - (select count(*) from companies where status in ('spawning', 'proposed'))
          - (select count(*) from clusters c join work_cards w on w.key = 'creator:design:' || c.id
             where w.status = 'open'
               and not exists (select 1 from companies co where co.cluster_id = c.id and co.spawned_at >= w.created_at)
               and not exists (select 1 from decisions d where d.agent = 'creator' and d.cluster_id = c.id and d.at >= w.created_at)) as free`,
  );
  if (free <= 0) return 0;
  const clusters = await ctx.db.query<{ id: string }>(
    `select c.id from clusters c
     where c.review_status = 'approved'
       and exists (select 1 from leads l where l.cluster_id = c.id and l.company_id is null and l.status = 'new')
       and not exists (select 1 from companies co where co.cluster_id = c.id and co.status in ('spawning', 'proposed', 'active'))
       and not exists (select 1 from work_cards w where w.key = 'creator:design:' || c.id)
     order by c.created_at, c.id
     limit $1`,
    [free],
  );
  let created = 0;
  for (const cluster of clusters) if ((await wake(ctx, WORK.design(cluster.id))).created) created++;
  return created;
}
