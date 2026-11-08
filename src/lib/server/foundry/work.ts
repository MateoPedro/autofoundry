import type { Db } from "../db";
import { describe } from "./metrics";
import type { CrewRole } from "./roles";
import { companySpend } from "./spend";
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

export type Work = { role: CrewRole; key: string; title: string; body: string; companyId: string | null; clusterId?: string; billable: boolean };

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
  design: (clusterId: string, attempt = 1): Work => ({
    role: "creator",
    key: attempt === 1 ? `creator:design:${clusterId}` : `creator:design:${clusterId}:${attempt}`,
    title: `Design a company for cluster ${clusterId}`,
    body: `Design a company for cluster ${clusterId}.`,
    companyId: null,
    clusterId,
    billable: false,
  }),
  // round is the grant number, or sweep-N for the sweep's retries of unfinished samples.
  sample: (companyId: string, round: number | string): Work => ({
    role: "creator",
    key: `creator:sample:${companyId}:${round}`,
    title: `Sample new leads for ${companyId}`,
    body: `Sample new leads for ${companyId} (${typeof round === "number" ? `grant ${round}` : round}).`,
    companyId,
    billable: true,
  }),
  revise: (clusterId: string, companyId: string): Work => ({
    role: "creator",
    key: `creator:revise:${companyId}`,
    title: `Revise the offer for cluster ${clusterId} after ${companyId} was killed`,
    body: `Revise the offer for cluster ${clusterId} after ${companyId} was killed.`,
    companyId: null,
    clusterId,
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

type Row = { key: string; role: CrewRole; company_id: string | null; title: string; body: string; billable: boolean; status: string };

async function overGrant(db: Db, companyId: string): Promise<boolean> {
  const [company] = await db.query<{ granted_micro_usd: unknown }>("select granted_micro_usd from companies where id = $1", [companyId]);
  return (await companySpend(db, companyId)) >= Number(company?.granted_micro_usd ?? 0);
}

// Writes the work down without touching Naïve, so it can go inside a transaction: if that rolls
// back, so does the card. postPending sends it once the transaction commits.
export async function queue(db: Db, work: Work, at: Date): Promise<void> {
  await db.query(
    `insert into work_cards (key, role, company_id, cluster_id, title, body, billable, status, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) on conflict (key) do nothing`,
    [work.key, work.role, work.companyId, work.clusterId ?? null, work.title, work.body, work.billable, at.toISOString()],
  );
}

// Naïve answers the existing card for a repeated key on the same board, so a race or a lost update
// re-finds the same card instead of making a second one.
async function post(ctx: ToolContext, row: Row): Promise<boolean> {
  if (row.billable && row.company_id && (await overGrant(ctx.db, row.company_id))) return false;
  const naive = requireNaive(ctx);
  const member = await crewMember(ctx.db, row.role);
  const card = await naiveStep(`wake ${row.role}`, () =>
    naive.createCard(member.board_id, { title: row.title, body: row.body, assignee: row.role, key: row.key }),
  );
  await ctx.db.query("update work_cards set board_id = $2, card_id = $3, status = 'open' where key = $1 and status = 'pending'", [row.key, member.board_id, card.id]);
  return true;
}

const ROW = "select key, role, company_id, title, body, billable, status from work_cards";

// The card key is the dedupe: an event and the sweep can both ask for the same work. While the
// company is stopped the card waits, and the first sweep after Launch posts it.
export async function wake(ctx: ToolContext, work: Work): Promise<{ created: boolean; reason?: "stopped" | "exists" | "over_grant" }> {
  if (work.billable && work.companyId && (await overGrant(ctx.db, work.companyId))) return { created: false, reason: "over_grant" };
  await queue(ctx.db, work, ctx.now());
  const [row] = await ctx.db.query<Row>(`${ROW} where key = $1`, [work.key]);
  if (row.status !== "pending") return { created: false, reason: "exists" };
  if (!(await isRunning(ctx.db))) return { created: false, reason: "stopped" };
  await post(ctx, row);
  return { created: true };
}

// Posts waiting cards: all of them, or only the given keys. A Naïve failure leaves a card waiting
// for the next sweep instead of failing the caller, whose own change is already committed.
export async function postPending(ctx: ToolContext, keys?: string[]): Promise<number> {
  if (keys?.length === 0 || !(await isRunning(ctx.db))) return 0;
  const rows = await ctx.db.query<Row>(`${ROW} where status = 'pending' and ($1::text[] is null or key = any($1)) order by created_at, key`, [keys ?? null]);
  let posted = 0;
  for (const row of rows) {
    try {
      if (await post(ctx, row)) posted++;
    } catch (error) {
      console.error(`card ${row.key} waits for the next sweep`, error);
    }
  }
  return posted;
}

// A killed company's cards close, except Deliver: a buyer who paid is still served.
export async function closeCompanyWork(ctx: ToolContext, companyId: string): Promise<number> {
  const rows = await ctx.db.query<{ key: string; board_id: string | null; card_id: string | null; status: string }>(
    "select key, board_id, card_id, status from work_cards where company_id = $1 and status in ('pending', 'open') and key not like 'closer:deliver:%'",
    [companyId],
  );
  let closed = 0;
  for (const row of rows) {
    try {
      if (row.status === "open") await naiveStep(`close ${row.key}`, () => requireNaive(ctx).setCardStatus(row.board_id!, row.card_id!, "done"));
      await ctx.db.query("update work_cards set status = 'closed', closed_at = $2 where key = $1", [row.key, ctx.now().toISOString()]);
      closed++;
    } catch (error) {
      console.error(`card ${row.key} stays open; its agent refuses the killed company`, error);
    }
  }
  return closed;
}

// A design card is in progress until Creator spawns from its cluster or logs a decision about it,
// for at most DESIGN_HOURS: a run that died frees its slot then, and the cluster gets one more try.
const DESIGN_HOURS = 6;
const DESIGN_ATTEMPTS = 2;
const IN_PROGRESS = `w.key like 'creator:design:%' and w.status <> 'closed'
  and (w.status = 'pending' or w.created_at > $1)
  and not exists (select 1 from companies co where co.cluster_id = w.cluster_id)
  and not exists (select 1 from decisions d where d.agent = 'creator' and d.cluster_id = w.cluster_id)`;

// The queue fills up to max_proposed, counting waiting companies and designs in progress.
export async function fillCreatorQueue(ctx: ToolContext): Promise<number> {
  const since = new Date(ctx.now().getTime() - DESIGN_HOURS * 3_600_000);
  const [{ free }] = await ctx.db.query<{ free: number }>(
    `select (select max_proposed from funding_policy)
          - (select count(*) from companies where status in ('spawning', 'proposed'))
          - (select count(*) from work_cards w where ${IN_PROGRESS}) as free`,
    [since],
  );
  if (free <= 0) return 0;
  const clusters = await ctx.db.query<{ id: string; attempts: number }>(
    `select c.id, (select count(*)::int from work_cards w where w.key like 'creator:design:%' and w.cluster_id = c.id) as attempts
     from clusters c
     where c.review_status = 'approved'
       and exists (select 1 from leads l where l.cluster_id = c.id and l.company_id is null and l.status = 'new')
       and not exists (select 1 from companies co where co.cluster_id = c.id)
       and not exists (select 1 from work_cards w where w.cluster_id = c.id and ${IN_PROGRESS})
       and (select count(*) from work_cards w where w.key like 'creator:design:%' and w.cluster_id = c.id) < ${DESIGN_ATTEMPTS}
     order by attempts, c.created_at, c.id
     limit $2`,
    [since, free],
  );
  let created = 0;
  for (const cluster of clusters) if ((await wake(ctx, WORK.design(cluster.id, cluster.attempts + 1))).created) created++;
  return created;
}
