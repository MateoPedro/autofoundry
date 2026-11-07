import { z } from "zod";
import type { Db } from "../db";
import { requireCompany } from "./leads";
import { defineTool, type ToolContext } from "./tool";

const SPEND_FRESH_MS = 5 * 60_000;

export function formatPrice(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

export async function syncSpend(ctx: ToolContext): Promise<{ synced: boolean; stale: boolean }> {
  const [{ last }] = await ctx.db.query<{ last: Date | null }>("select max(synced_at) as last from spend");
  const now = ctx.now();
  if (last && now.getTime() - new Date(last).getTime() < SPEND_FRESH_MS) return { synced: false, stale: false };
  if (!ctx.spend) return { synced: false, stale: true };
  try {
    const agents = await ctx.spend.listAgentSpend();
    await ctx.db.tx(async (db) => {
      for (const agent of agents) {
        await db.query(
          `insert into spend (company_id, agent_id, agent_name, micro_usd, synced_at)
           values ((select company_id from company_resources where kind = 'agent' and naive_id = $1 limit 1), $1, $2, $3, $4)
           on conflict do nothing`,
          [agent.agent_id, agent.agent_name, agent.micro_usd, now],
        );
      }
    });
    return { synced: true, stale: false };
  } catch (error) {
    console.error("spend sync failed", error);
    return { synced: false, stale: true };
  }
}

async function countBy(db: Db, sql: string, params: unknown[] = []) {
  const rows = await db.query<{ company_id: string | null; n: unknown }>(sql, params);
  return new Map(rows.map((r) => [r.company_id, num(r.n)]));
}

async function companyEntries(db: Db, companyId: string | null) {
  const companies = await db.query<
    Record<string, unknown> & { id: string; offer_id: string; price_cents: number; product: string; granted_micro_usd: unknown }
  >(
    `select co.id, co.slug, co.status, co.offer_id, co.cluster_id, co.parent_id, co.spawned_at, co.funded_at, co.killed_at,
            co.granted_micro_usd, o.product, o.price_cents
     from companies co join offers o on o.id = co.offer_id
     where $1::text is null or co.id = $1
     order by co.spawned_at`,
    [companyId],
  );
  const funnels = await db.query<{ company_id: string } & Record<string, unknown>>(
    `select company_id, count(*) as leads, count(sample_url) as sampled,
            count(*) filter (where status in ('contacted', 'replied', 'paid')) as contacted,
            count(*) filter (where status in ('replied', 'paid')) as replied,
            count(*) filter (where status = 'paid') as paid
     from leads where company_id is not null group by company_id`,
  );
  const channels = await db.query<{ company_id: string; channel: string; n: unknown }>(
    "select company_id, channel, count(*) as n from touches group by company_id, channel",
  );
  const spend = await countBy(
    db,
    `select company_id, sum(micro_usd) as n from (
       select distinct on (agent_id) agent_id, company_id, micro_usd from spend order by agent_id, synced_at desc
     ) latest group by company_id`,
  );
  const revenue = await countBy(db, "select company_id, sum(amount_cents - refunded_cents) as n from payments group by company_id");

  return companies.map((co) => {
    const f = funnels.find((row) => row.company_id === co.id);
    const funnel = {
      leads: num(f?.leads),
      sampled: num(f?.sampled),
      contacted: num(f?.contacted),
      replied: num(f?.replied),
      paid: num(f?.paid),
    };
    const spent = spend.get(co.id) ?? 0;
    const { product, price_cents, ...rest } = co;
    return {
      ...rest,
      offer_summary: `${product}, ${formatPrice(price_cents)}`,
      granted_micro_usd: num(co.granted_micro_usd),
      spend_micro_usd: spent,
      revenue_cents: revenue.get(co.id) ?? 0,
      funnel,
      touches_by_channel: Object.fromEntries(channels.filter((c) => c.company_id === co.id).map((c) => [c.channel, num(c.n)])),
      cost_per_reply_micro_usd: funnel.replied ? Math.round(spent / funnel.replied) : null,
    };
  });
}

export const getMetrics = defineTool({
  name: "get_metrics",
  description:
    "The foundry's numbers: funding policy and pool left, totals, every company's funnel, spend and revenue, and recent decisions. Pass company_id for one company. spend_stale is true when spend couldn't be refreshed from Naïve.",
  input: z.object({
    company_id: z.string().min(1).nullish(),
    decisions_limit: z.number().int().min(0).max(50).default(10),
  }),
  async run(ctx, input) {
    const companyId = input.company_id ?? null;
    if (companyId) await requireCompany(ctx.db, companyId);
    const { stale } = await syncSpend(ctx);
    const db = ctx.db;

    const [policy] = await db.query<Record<string, unknown>>(
      "select pool_micro_usd, grant_micro_usd, max_proposed, max_active, (select coalesce(sum(granted_micro_usd), 0) from companies) as granted from funding_policy",
    );
    const [t] = await db.query<Record<string, unknown>>(
      `select
         (select count(*) from clusters) as clusters,
         (select count(*) from clusters where review_status = 'approved') as clusters_approved,
         (select count(*) from offers) as offers,
         (select count(*) from offers where review_status = 'approved') as offers_approved,
         (select count(*) from companies where status = 'proposed') as companies_proposed,
         (select count(*) from companies where status = 'active') as companies_active,
         (select count(*) from companies where status = 'killed') as companies_killed,
         (select count(*) from leads) as leads,
         (select count(*) from touches) as touches,
         (select count(*) from leads where status in ('replied', 'paid')) as replies,
         (select count(*) from payments) as payments,
         (select coalesce(sum(micro_usd), 0) from (select distinct on (agent_id) micro_usd from spend order by agent_id, synced_at desc) s) as spend_micro_usd,
         (select coalesce(sum(amount_cents - refunded_cents), 0) from payments) as revenue_cents`,
    );
    const decisions = await db.query(
      `select id, agent, kind, cluster_id, offer_id, company_id, amount_micro_usd, reason, at from decisions
       where $1::text is null or company_id = $1 order by at desc limit $2`,
      [companyId, input.decisions_limit],
    );

    const pool = num(policy.pool_micro_usd);
    const granted = num(policy.granted);
    return {
      as_of: ctx.now().toISOString(),
      spend_stale: stale,
      policy: {
        pool_micro_usd: pool,
        granted_micro_usd: granted,
        pool_left_micro_usd: Math.max(0, pool - granted),
        grant_micro_usd: num(policy.grant_micro_usd),
        max_proposed: num(policy.max_proposed),
        max_active: num(policy.max_active),
      },
      totals: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, num(v)])),
      companies: await companyEntries(db, companyId),
      decisions: decisions.map((d) => ({ ...d, amount_micro_usd: d.amount_micro_usd === null ? null : num(d.amount_micro_usd) })),
    };
  },
});

export const getCompany = defineTool({
  name: "get_company",
  description:
    "One company in detail: its offer, its leads (most recent activity first) with their touches and payments, and its spend snapshots.",
  input: z.object({
    company_id: z.string().min(1),
    leads_limit: z.number().int().min(1).max(50).default(20),
  }),
  async run(ctx, input) {
    await requireCompany(ctx.db, input.company_id);
    await syncSpend(ctx);
    const db = ctx.db;
    const [company] = await companyEntries(db, input.company_id);
    const [offer] = await db.query("select * from offers where id = $1", [company.offer_id]);
    const leads = await db.query<{ id: string }>(
      `select l.id, l.name, l.status, l.url, l.email, l.sample_url, l.data
       from leads l left join touches t on t.lead_id = l.id
       where l.company_id = $1
       group by l.id
       order by coalesce(max(t.at), l.created_at) desc, l.created_at desc
       limit $2`,
      [input.company_id, input.leads_limit],
    );
    const ids = leads.map((l) => l.id);
    const touches = await db.query<{ lead_id: string }>(
      "select lead_id, channel, kind, agent_name, detail, at from touches where lead_id = any($1) order by at",
      [ids],
    );
    const payments = await db.query<{ lead_id: string }>(
      "select lead_id, amount_cents, refunded_cents, source, at from payments where lead_id = any($1) order by at",
      [ids],
    );
    const spend = await db.query<{ micro_usd: unknown }>(
      "select agent_name, micro_usd, synced_at from spend where company_id = $1 order by synced_at desc limit 50",
      [input.company_id],
    );
    const strip = (rows: { lead_id: string }[], id: string) =>
      rows
        .filter((r) => r.lead_id === id)
        .map((r) => {
          const row: Record<string, unknown> = { ...r };
          delete row.lead_id;
          return row;
        });
    return {
      company,
      offer,
      leads: leads.map((l) => ({ ...l, touches: strip(touches, l.id), payments: strip(payments, l.id) })),
      spend: spend.map((s) => ({ ...s, micro_usd: num(s.micro_usd) })),
    };
  },
});
