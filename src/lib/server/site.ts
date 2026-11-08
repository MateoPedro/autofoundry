import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { CompanyStatus, Decision } from "../dashboard/types";
import { AGENT_ROLE, FOUNDRY_AGENTS } from "../dashboard/view";
import type { AgentProfile, ChannelCycle, FeedbackNote, LiveSite, Site, SiteAgent, SiteCompany } from "../site/types";
import { median, minutesBetween, titleOf } from "../site/view";
import { dashboardContext } from "./dashboard";
import type { Db } from "./db";
import { agentActivity } from "./foundry/activity";
import { syncSpend } from "./foundry/metrics";
import { ROLE_BUDGETS, type CrewRole } from "./foundry/roles";
import { stateOf } from "./foundry/state";
import type { ToolContext } from "./foundry/tool";

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const iso = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).toISOString());
const isoOr = (value: unknown) => iso(value) ?? new Date(0).toISOString();

type CompanyRow = {
  id: string;
  slug: string;
  status: CompanyStatus;
  parent_id: string | null;
  spawned_at: Date;
  funded_at: Date | null;
  killed_at: Date | null;
  granted_micro_usd: unknown;
  label: string;
  source: string;
  buyer: string;
  product: string;
  sample: string;
  delivery: string;
  outreach_message: string;
  price_cents: number;
  channel: string;
};

// Everything the public site shows, read straight from the foundry tables. Read-only: it can refresh
// spend from Naïve like the dashboard does, and nothing else.
export async function loadSite(ctx: ToolContext | null = dashboardContext()): Promise<Site> {
  const snapshot = process.env.SITE_SNAPSHOT;
  if (!ctx && snapshot) {
    // Local design work without the database: a JSON file written by loadSite against a copy of it.
    return JSON.parse(await readFile(snapshot, "utf8")) as Site;
  }
  if (!ctx) return { source: "error", message: "This server has no foundry database, so there's nothing live to show." };
  try {
    return await readSite(ctx);
  } catch (error) {
    console.error("site load failed", error);
    return { source: "error", message: "The foundry database didn't answer. Reload in a minute." };
  }
}

export async function readSite(ctx: ToolContext): Promise<LiveSite> {
  await syncSpend(ctx).catch(() => undefined);
  const db = ctx.db;
  const now = ctx.now();

  const companyRows = await db.query<CompanyRow>(
    `select co.id, co.slug, co.status, co.parent_id, co.spawned_at, co.funded_at, co.killed_at, co.granted_micro_usd,
            cl.label, cl.source, o.buyer, o.product, o.sample, o.delivery, o.outreach_message, o.price_cents, o.channel
     from companies co join offers o on o.id = co.offer_id join clusters cl on cl.id = co.cluster_id
     order by co.spawned_at`,
  );
  const decisions = (
    await db.query<Decision & { amount_micro_usd: unknown; at: Date }>(
      "select id, agent, kind, cluster_id, offer_id, company_id, amount_micro_usd, reason, at from decisions order by at desc",
    )
  ).map((d) => ({ ...d, amount_micro_usd: d.amount_micro_usd === null ? null : num(d.amount_micro_usd), at: isoOr(d.at) }));

  const funnels = await db.query<Record<string, unknown> & { company_id: string }>(
    `select company_id, count(*) as leads, count(sample_url) as sampled,
            count(*) filter (where status in ('contacted', 'replied', 'paid')) as contacted,
            count(*) filter (where status in ('replied', 'paid')) as replied,
            count(*) filter (where exists (select 1 from payments p where p.lead_id = leads.id and p.livemode)) as paid,
            min(sample_url) as sample_url
     from leads where company_id is not null group by company_id`,
  );
  const failed = await db.query<{ company_id: string; n: unknown }>(
    "select company_id, count(*) as n from touches where kind = 'failed' group by company_id",
  );
  const crew = await db.query<{ company_id: string; agent_name: string; micro_usd: unknown; sessions: unknown }>(
    `select company_id, agent_name, sum(micro_usd) as micro_usd, count(*) as sessions
     from session_spend where company_id is not null group by company_id, agent_name order by agent_name`,
  );
  const revenue = await db.query<{ company_id: string; n: unknown }>(
    "select company_id, sum(amount_cents - refunded_cents) as n from payments where livemode group by company_id",
  );
  const touches = await db.query<{ company_id: string; agent_name: string; channel: string; kind: string; detail: string | null; at: Date; lead: string | null }>(
    `select t.company_id, t.agent_name, t.channel, t.kind, left(t.detail, 220) as detail, t.at, l.name as lead
     from touches t left join leads l on l.id = t.lead_id order by t.at`,
  );
  const leads = await db.query<{ company_id: string; name: string; status: string; url: string | null; sample_url: string | null }>(
    "select company_id, name, status, url, sample_url from leads where company_id is not null order by created_at",
  );

  const companies: SiteCompany[] = companyRows.map((co) => {
    const f = funnels.find((r) => r.company_id === co.id);
    const mine = decisions.filter((d) => d.company_id === co.id).reverse();
    const last = (kind: Decision["kind"]) => [...mine].reverse().find((d) => d.kind === kind)?.reason ?? null;
    const spend = crew.filter((r) => r.company_id === co.id);
    return {
      id: co.id,
      slug: co.slug,
      status: co.status,
      parent_id: co.parent_id,
      title: titleOf(co.product),
      market: co.label,
      source: co.source,
      buyer: co.buyer,
      product: co.product,
      sample: co.sample,
      delivery: co.delivery,
      outreach_message: co.outreach_message,
      price_cents: num(co.price_cents),
      channel: co.channel,
      spawned_at: isoOr(co.spawned_at),
      funded_at: iso(co.funded_at),
      killed_at: iso(co.killed_at),
      granted_micro_usd: num(co.granted_micro_usd),
      spend_micro_usd: spend.reduce((sum, r) => sum + num(r.micro_usd), 0),
      revenue_cents: num(revenue.find((r) => r.company_id === co.id)?.n),
      funnel: { leads: num(f?.leads), sampled: num(f?.sampled), contacted: num(f?.contacted), replied: num(f?.replied), paid: num(f?.paid) },
      failed_touches: num(failed.find((r) => r.company_id === co.id)?.n),
      sample_url: (f?.sample_url as string | null) ?? null,
      spawn_reason: mine.find((d) => d.kind === "spawn")?.reason ?? null,
      fund_reason: mine.find((d) => d.kind === "fund")?.reason ?? null,
      kill_reason: last("kill"),
      decisions: mine,
      crew: spend.map((r) => ({ agent: r.agent_name, micro_usd: num(r.micro_usd), sessions: num(r.sessions) })),
      touches: touches
        .filter((t) => t.company_id === co.id)
        .map((t) => ({ agent: t.agent_name, channel: t.channel, kind: t.kind, detail: t.detail, at: isoOr(t.at), lead: t.lead })),
      leads: leads.filter((l) => l.company_id === co.id).map(({ name, status, url, sample_url }) => ({ name, status, url, sample_url })),
    };
  });

  const feedback: FeedbackNote[] = (
    await db.query<{ id: string; kind: "note" | "summary"; body: string; through_at: Date; created_at: Date; compacted_into: string | null }>(
      "select id, kind, body, through_at, created_at, compacted_into from scout_feedback order by created_at",
    )
  ).map((r) => ({ id: r.id, kind: r.kind, body: r.body, through_at: isoOr(r.through_at), created_at: isoOr(r.created_at), live: !r.compacted_into }));

  const channels: ChannelCycle[] = (
    await db.query<{ at: Date; email: unknown; form: unknown; other: unknown }>(
      `select date_trunc('hour', c.created_at at time zone 'UTC') at time zone 'UTC' as at,
              count(*) filter (where l.data->>'channel' = 'email') as email,
              count(*) filter (where l.data->>'channel' = 'contact_form') as form,
              count(*) filter (where coalesce(l.data->>'channel', '') not in ('email', 'contact_form')) as other
       from leads l join clusters c on c.id = l.cluster_id group by 1 order by 1`,
    )
  ).map((r) => ({ at: isoOr(r.at), email: num(r.email), form: num(r.form), other: num(r.other) }));

  const [counts] = await db.query<Record<string, unknown>>(
    `select (select count(*) from clusters) as markets,
            (select count(*) from clusters where review_status = 'approved') as markets_approved,
            (select count(*) from clusters where review_status = 'rejected') as markets_rejected,
            (select count(*) from leads) as leads,
            (select count(*) from leads where sample_url is not null) as samples,
            (select count(*) from touches where kind = 'sent') as messages_sent,
            (select count(*) from touches where kind = 'failed') as failed_touches,
            (select count(*) from leads where status in ('replied', 'paid')) as replies,
            (select count(*) from payments where livemode) as payments,
            (select coalesce(sum(amount_cents - refunded_cents), 0) from payments where livemode) as revenue_cents,
            (select coalesce(sum(micro_usd), 0) from (select distinct on (agent_id) micro_usd from spend order by agent_id, synced_at desc) s) as spend,
            (select coalesce(sum(micro_usd), 0) from session_spend where company_id is not null) as child_spend`,
  );
  const [policy] = await db.query<Record<string, unknown>>(
    "select pool_micro_usd, grant_micro_usd, max_active, max_proposed, updated_at from funding_policy where id = 1",
  );
  const killed = companies.filter((c) => c.status === "killed");
  const totals = {
    markets: num(counts.markets),
    markets_approved: num(counts.markets_approved),
    markets_rejected: num(counts.markets_rejected),
    companies: companies.length,
    alive: companies.filter((c) => c.status !== "killed" && c.status !== "failed").length,
    killed: killed.length,
    leads: num(counts.leads),
    samples: num(counts.samples),
    messages_sent: num(counts.messages_sent),
    failed_touches: num(counts.failed_touches),
    replies: num(counts.replies),
    payments: num(counts.payments),
    revenue_cents: num(counts.revenue_cents),
    spend_micro_usd: num(counts.spend),
    child_spend_micro_usd: num(counts.child_spend),
    granted_micro_usd: companies.reduce((s, c) => s + c.granted_micro_usd, 0),
    pool_micro_usd: num(policy?.pool_micro_usd),
    killed_spend_micro_usd: killed.reduce((s, c) => s + c.spend_micro_usd, 0),
    median_minutes_to_kill: median(killed.filter((c) => c.killed_at).map((c) => minutesBetween(c.spawned_at, c.killed_at as string))),
  };

  const agents = await siteAgents(db, now, totals, feedback.length);
  const labels = Object.fromEntries(
    (await db.query<{ id: string; label: string }>("select id, label from clusters union all select id, product as label from offers")).map((r) => [r.id, r.label]),
  );
  const { running } = await stateOf(db);

  return {
    source: "live",
    as_of: now.toISOString(),
    running,
    totals,
    policy: {
      pool_micro_usd: num(policy?.pool_micro_usd),
      grant_micro_usd: num(policy?.grant_micro_usd),
      max_active: num(policy?.max_active),
      max_proposed: num(policy?.max_proposed),
      updated_at: iso(policy?.updated_at),
    },
    companies,
    decisions,
    feedback,
    channels,
    agents,
    labels,
  };
}

async function siteAgents(db: Db, now: Date, totals: LiveSite["totals"], notes: number): Promise<SiteAgent[]> {
  const activity = await agentActivity(db, now);
  const byAgent = await db.query<{ agent: string; kind: string; n: unknown }>("select agent, kind, count(*) as n from decisions group by agent, kind");
  const count = (agent: string, ...kinds: string[]) => byAgent.filter((r) => r.agent === agent && kinds.includes(r.kind)).reduce((s, r) => s + num(r.n), 0);
  const [{ replies_sent }] = await db.query<{ replies_sent: unknown }>("select count(*) as replies_sent from touches where kind = 'reply_sent'");
  const work: Record<string, [number, string]> = {
    scout: [totals.markets, "markets found"],
    compliance: [count("compliance", "approve", "reject"), "screens"],
    creator: [count("creator", "spawn"), "companies started"],
    vc: [count("vc", "fund", "kill"), "fund & kill calls"],
    feedback: [notes, "lessons written"],
    outreach: [totals.messages_sent, "messages sent"],
    closer: [num(replies_sent), "replies answered"],
  };
  return activity.rows.map((row) => ({
    key: row.key,
    name: row.name,
    role: AGENT_ROLE[row.key] ?? row.role,
    latest: row.latest,
    at: row.at,
    active: row.status === "active",
    spend_micro_usd: row.spend_micro_usd,
    budget_micro_usd: ROLE_BUDGETS[row.key as CrewRole]?.cap_micro_usd ?? 0,
    work: work[row.key]?.[0] ?? 0,
    work_label: work[row.key]?.[1] ?? "",
  }));
}

// Each agent's configuration as deployed: agents/<name>.agent.yaml and the prompt it points at.
// next.config.ts traces the agents folder into the build so this works on the deployed app.
export async function agentProfiles(): Promise<Record<string, AgentProfile>> {
  const dir = join(process.cwd(), "agents");
  const entries = await Promise.all(
    Object.keys(FOUNDRY_AGENTS).map(async (key): Promise<[string, AgentProfile] | null> => {
      try {
        const config = parse(await readFile(join(dir, `${key}.agent.yaml`), "utf8")) as {
          description?: string;
          model?: string;
          system_file?: string;
          tools?: { configs?: Record<string, { enabled?: boolean }> };
          schedule?: unknown;
        };
        const prompt = config.system_file ? await readFile(join(dir, config.system_file), "utf8") : "";
        const tools = Object.entries(config.tools?.configs ?? {})
          .filter(([, c]) => c?.enabled !== false)
          .map(([name]) => name);
        return [key, { description: config.description ?? "", model: config.model ?? "", tools, prompt }];
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter((e): e is [string, AgentProfile] => e !== null));
}
