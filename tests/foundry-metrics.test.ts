import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../src/lib/server/db";
import { formatPrice, getCompany, getMetrics } from "../src/lib/server/foundry/metrics";
import type { AgentSpend } from "../src/lib/server/foundry/tool";
import { NOW, run, seedCluster, seedCompany, seedLead, testContext } from "./helpers/fixtures";

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

async function seedPortfolio(db: Db) {
  const clusterId = await seedCluster(db);
  const active = await seedCompany(db, { clusterId, status: "active", slug: "co-01" });
  const killed = await seedCompany(db, { clusterId, status: "killed", slug: "co-02" });
  await db.query("update companies set granted_micro_usd = 5000000");
  await db.query("insert into company_resources (company_id, kind, role, naive_id, name) values ($1, 'agent', 'builder', 'agt_1', 'co-01-builder')", [
    active.companyId,
  ]);

  const a = active.companyId;
  await seedLead(db, clusterId, { companyId: a, status: "new" });
  for (const status of ["assigned", "contacted", "replied"]) await seedLead(db, clusterId, { companyId: a, status, sampleUrl: "https://s" });
  const paid = await seedLead(db, clusterId, { companyId: a, status: "paid", sampleUrl: "https://s", name: "Paid Dental" });
  await seedLead(db, clusterId, { companyId: killed.companyId, status: "contacted", sampleUrl: "https://s" });

  for (const channel of ["contact_form", "contact_form", "email"]) {
    await db.query("insert into touches (id, company_id, lead_id, agent_name, channel, kind) values ($1, $2, $3, 'co-01-outreach', $4, 'sent')", [
      `tc_${channel}_${Math.random()}`,
      a,
      paid,
      channel,
    ]);
  }
  await db.query(
    "insert into payments (id, company_id, lead_id, amount_cents, source, external_ref, livemode) values ('py_1', $1, $2, 9900, 'naive_checkout', 'chk_1', false)",
    [a, paid],
  );
  for (const [agent, company, micro, at] of [
    ["agt_1", a, 1_000_000, minutesAgo(10)],
    ["agt_1", a, 2_000_000, minutesAgo(1)],
    ["agt_2", a, 500_000, minutesAgo(1)],
  ] as const) {
    await db.query("insert into spend (company_id, agent_id, agent_name, micro_usd, synced_at) values ($1, $2, $2, $3, $4)", [company, agent, micro, at]);
  }
  await db.query("insert into decisions (id, agent, kind, company_id, reason, at) values ('dc_1', 'funder', 'kill', $1, 'no replies', $2)", [
    killed.companyId,
    minutesAgo(30),
  ]);
  return { active: a, killed: killed.companyId, paid };
}

type Metrics = {
  spend_stale: boolean;
  policy: Record<string, number>;
  totals: Record<string, number>;
  companies: Record<string, unknown>[];
  decisions: { id: string }[];
};

test("get_metrics returns the contract's shape and totals", async () => {
  const ctx = await testContext();
  const { active, killed } = await seedPortfolio(ctx.db);
  const m = (await run(getMetrics, ctx, {})) as Metrics;

  assert.equal(m.spend_stale, false);
  assert.deepEqual(m.policy, {
    pool_micro_usd: 10_000_000,
    granted_micro_usd: 10_000_000,
    pool_left_micro_usd: 0,
    grant_micro_usd: 5_000_000,
    max_proposed: 3,
    max_active: 2,
  });
  assert.equal(m.totals.companies_active, 1);
  assert.equal(m.totals.companies_killed, 1);
  assert.equal(m.totals.companies_proposed, 0);
  assert.equal(m.totals.leads, 6);
  assert.equal(m.totals.touches, 3);
  assert.equal(m.totals.replies, 2);
  assert.equal(m.totals.payments, 1);
  assert.equal(m.totals.revenue_cents, 9900);
  assert.equal(m.totals.spend_micro_usd, 2_500_000);

  const co = m.companies.find((c) => c.id === active)!;
  assert.deepEqual(co.funnel, { leads: 5, sampled: 4, contacted: 3, replied: 2, paid: 1 });
  assert.deepEqual(co.touches_by_channel, { contact_form: 2, email: 1 });
  assert.equal(co.spend_micro_usd, 2_500_000);
  assert.equal(co.revenue_cents, 9900);
  assert.equal(co.cost_per_reply_micro_usd, 1_250_000);
  assert.equal(co.offer_summary, "One-page site on your domain, $99");
  assert.equal(co.granted_micro_usd, 5_000_000);
  assert.equal(m.companies.find((c) => c.id === killed)!.cost_per_reply_micro_usd, null);
  assert.deepEqual(m.decisions.map((d) => d.id), ["dc_1"]);
});

test("get_metrics with company_id returns only that company", async () => {
  const ctx = await testContext();
  const { active } = await seedPortfolio(ctx.db);
  const m = (await run(getMetrics, ctx, { company_id: active })) as Metrics;
  assert.deepEqual(m.companies.map((c) => c.id), [active]);
  assert.deepEqual(m.decisions, []);
});

test("get_metrics with an unknown company_id returns not_found", async () => {
  const ctx = await testContext();
  await assert.rejects(run(getMetrics, ctx, { company_id: "co_missing" }), { code: "not_found" });
});

test("get_metrics syncs spend through the spend source when stale", async () => {
  const listed: AgentSpend[] = [
    { agent_id: "agt_1", agent_name: "co-01-builder", micro_usd: 3_000_000 },
    { agent_id: "agt_scout", agent_name: "scout", micro_usd: 100 },
  ];
  const ctx = await testContext({ spend: { listAgentSpend: async () => listed } });
  const { active } = await seedPortfolio(ctx.db);
  await ctx.db.query("delete from spend");

  const m = (await run(getMetrics, ctx, {})) as Metrics;
  assert.equal(m.spend_stale, false);
  const rows = await ctx.db.query<{ agent_id: string; company_id: string | null }>("select agent_id, company_id from spend order by agent_id");
  assert.deepEqual(rows, [
    { agent_id: "agt_1", company_id: active },
    { agent_id: "agt_scout", company_id: null },
  ]);
  assert.equal(m.companies.find((c) => c.id === active)!.spend_micro_usd, 3_000_000);
});

test("get_metrics answers with spend_stale when the spend source throws", async () => {
  const ctx = await testContext({
    spend: {
      listAgentSpend: async () => {
        throw new Error("Naïve is down");
      },
    },
  });
  await seedPortfolio(ctx.db);
  await ctx.db.query("update spend set synced_at = synced_at - interval '1 hour'");
  const m = (await run(getMetrics, ctx, {})) as Metrics;
  assert.equal(m.spend_stale, true);
  assert.equal(m.totals.spend_micro_usd, 2_500_000);
});

test("get_metrics answers with spend_stale when there is no spend source and the last sync is old", async () => {
  const ctx = await testContext();
  await seedPortfolio(ctx.db);
  await ctx.db.query("update spend set synced_at = synced_at - interval '1 hour'");
  assert.equal(((await run(getMetrics, ctx, {})) as Metrics).spend_stale, true);
});

test("get_metrics doesn't sync again within 5 minutes", async () => {
  let calls = 0;
  const ctx = await testContext({
    spend: {
      listAgentSpend: async () => {
        calls++;
        return [];
      },
    },
  });
  await seedPortfolio(ctx.db);
  await run(getMetrics, ctx, {});
  assert.equal(calls, 0);
});

test("get_company returns the offer, leads with touches and payments, and spend", async () => {
  const ctx = await testContext();
  const { active, paid } = await seedPortfolio(ctx.db);
  const out = (await run(getCompany, ctx, { company_id: active })) as {
    company: { id: string; funnel: object };
    offer: { price_cents: number; outreach_message: string };
    leads: { id: string; touches: unknown[]; payments: { amount_cents: number }[] }[];
    spend: { agent_name: string; micro_usd: number }[];
  };
  assert.equal(out.company.id, active);
  assert.equal(out.offer.price_cents, 9900);
  assert.equal(out.leads[0].id, paid, "the lead with the most recent activity comes first");
  assert.equal(out.leads[0].touches.length, 3);
  assert.deepEqual(out.leads[0].payments.map((p) => p.amount_cents), [9900]);
  assert.equal(out.leads.length, 5);
  assert.equal(out.spend.length, 3);
});

test("get_company with an unknown id returns not_found", async () => {
  const ctx = await testContext();
  await assert.rejects(run(getCompany, ctx, { company_id: "co_missing" }), { code: "not_found" });
});

test("formatting a price: 9900 → $99, 9950 → $99.50", () => {
  assert.equal(formatPrice(9900), "$99");
  assert.equal(formatPrice(9950), "$99.50");
  assert.equal(formatPrice(50), "$0.50");
});
