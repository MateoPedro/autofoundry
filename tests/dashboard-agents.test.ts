import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Agents, Companies, DecisionLog } from "../src/app/dashboard";
import { sampleAgents, sampleMetrics } from "../src/lib/dashboard/sample";
import type { Db } from "../src/lib/server/db";
import { loadDashboard } from "../src/lib/server/dashboard";
import { agentActivity, decisionTargets } from "../src/lib/server/foundry/activity";
import { NOW, seedCluster, seedCompany, seedLead, testContext } from "./helpers/fixtures";

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

async function crew(db: Db, companyId: string, slug: string) {
  for (const role of ["outreach", "closer", "builder"]) {
    await db.query("insert into company_resources (company_id, kind, role, naive_id, name) values ($1, 'agent', $2, $3, $4)", [
      companyId,
      role,
      `agt_${slug}_${role}`,
      `${slug}-${role}`,
    ]);
  }
}

test("foundry agents show their newest recorded work, latest spend and whether they acted in the last three hours", async () => {
  const ctx = await testContext();
  const cluster = await seedCluster(ctx.db, "Agents buying MCP tools", "rejected");
  const { companyId } = await seedCompany(ctx.db, { slug: "co-01" });
  await ctx.db.query(
    `insert into decisions (id, agent, kind, cluster_id, company_id, amount_micro_usd, reason, at) values
       ('dc_rej', 'compliance', 'reject', $1, null, null, 'no buyer', $3),
       ('dc_fund', 'vc', 'fund', null, $2, 5000000, 'good sample', $4)`,
    [cluster, companyId, hoursAgo(1), hoursAgo(4)],
  );
  await ctx.db.query(
    "insert into screens (id, since, cutoff, status, candidate_count, created_at, finished_at) values ('sc_1', $1, $1, 'done', 12, $1, $2)",
    [hoursAgo(6), hoursAgo(5)],
  );
  await ctx.db.query("insert into monid_reads (id, source, query, cost_micro_usd, created_at) values ('mr_1', 'reddit', 'site broken on phone', 1000, $1)", [hoursAgo(6)]);
  const lead = await seedLead(ctx.db, cluster, { name: "Folsom Street Dental" });
  await ctx.db.query("update leads set created_at = $2 where id = $1", [lead, hoursAgo(5)]);
  await ctx.db.query(
    "insert into spend (company_id, agent_id, agent_name, micro_usd, synced_at) values (null, 'agt_scout', 'scout', 100000, $1), (null, 'agt_scout', 'scout', 620000, $2)",
    [hoursAgo(2), hoursAgo(1)],
  );

  const { rows, synced_at } = await agentActivity(ctx.db, NOW);
  assert.equal(synced_at, hoursAgo(1));
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(rows.map((r) => r.name), ["Scout", "Compliance", "Creator", "VC", "Feedback", "Outreach", "Closer"]);

  assert.equal(byKey.scout.latest, "Saved a lead: Folsom Street Dental", "the lead is newer than the Monid read");
  assert.equal(byKey.scout.status, "idle");
  assert.equal(byKey.scout.spend_micro_usd, 620_000, "the latest spend snapshot, not the sum");
  assert.equal(byKey.compliance.latest, "Rejected “Agents buying MCP tools”", "the decision is newer than the screen");
  assert.equal(byKey.compliance.status, "active");
  assert.equal(byKey.vc.latest, "Funded co-01 with $5.00");
  assert.equal(byKey.vc.status, "idle");
  assert.equal(byKey.creator.latest, null);
  assert.equal(byKey.creator.spend_micro_usd, null, "no spend row means unknown, not $0");

  await ctx.db.query("delete from decisions where id = 'dc_rej'");
  const later = await agentActivity(ctx.db, NOW);
  assert.equal(later.rows.find((r) => r.key === "compliance")?.latest, "Screened 12 ideas");
});

test("the agents panel lists the seven fixed agents and no per-company crew", async () => {
  const ctx = await testContext();
  const running = await seedCompany(ctx.db, { slug: "co-01" });
  await crew(ctx.db, running.companyId, "co-01");
  const lead = await seedLead(ctx.db, running.clusterId, { companyId: running.companyId, name: "Mission Bay Smiles" });
  await ctx.db.query(
    "insert into touches (id, company_id, lead_id, agent_name, channel, kind, at) values ('tc_1', $1, $2, 'closer', 'email', 'reply_received', $3), ('tc_0', $1, $2, 'outreach', 'email', 'sent', $4), ('tc_2', $1, $2, 'creator', 'email', 'sample_delivered', $4)",
    [running.companyId, lead, hoursAgo(0.5), hoursAgo(1)],
  );
  await ctx.db.query("insert into spend (company_id, agent_id, agent_name, micro_usd, synced_at) values (null, 'agt_closer', 'closer', 760000, $1)", [hoursAgo(1)]);

  const { rows } = await agentActivity(ctx.db, NOW);
  assert.deepEqual(rows.map((r) => r.name), ["Scout", "Compliance", "Creator", "VC", "Feedback", "Outreach", "Closer"]);
  assert.ok(rows.every((r) => r.group === "Foundry"));
  const closer = rows.find((r) => r.key === "closer")!;
  assert.equal(closer.latest, "Got a reply from Mission Bay Smiles");
  assert.equal(closer.status, "active");
  assert.equal(closer.spend_micro_usd, 760_000);
  assert.equal(rows.find((r) => r.key === "outreach")!.latest, "Messaged Mission Bay Smiles");
  assert.equal(rows.find((r) => r.key === "creator")!.latest, "Built a sample for Mission Bay Smiles");
});

test("the decision feed names clusters and offers by their label", async () => {
  const ctx = await testContext();
  const cluster = await seedCluster(ctx.db, "Florists needing same-day delivery", "rejected");
  await ctx.db.query("insert into decisions (id, agent, kind, cluster_id, reason) values ('dc_1', 'compliance', 'reject', $1, 'needs delivery')", [cluster]);
  assert.deepEqual(await decisionTargets(ctx.db, []), {});

  const live = await loadDashboard({}, ctx);
  assert.equal(live.source, "live");
  if (live.source !== "live") return;
  assert.deepEqual(live.targets, { [cluster]: "Florists needing same-day delivery" });
  assert.equal(live.agents.rows.length, 7, "the seven crew agents");
  const html = renderToStaticMarkup(createElement(DecisionLog, { metrics: live.metrics, href: (s: string) => s, targets: live.targets }));
  assert.match(html, /cluster <b>“Florists needing same-day delivery”<\/b>/);
});

test("the sample's agent spend adds up to its total spend", () => {
  const sum = sampleAgents.rows.reduce((total, r) => total + (r.spend_micro_usd ?? 0), 0);
  assert.equal(sum, sampleMetrics.totals.spend_micro_usd);
});

test("the companies filter shows only the matching companies, and agents render every group", () => {
  const props = { metrics: sampleMetrics, href: (s: string) => `/?company=${s}`, showHref: (s: string) => `/?show=${s}` };
  const killed = renderToStaticMarkup(createElement(Companies, { ...props, show: "killed" }));
  assert.match(killed, />co-02</);
  assert.doesNotMatch(killed, />co-01</);
  assert.match(killed, /aria-current="page"[^>]*>Killed \(1\)/);

  const agents = renderToStaticMarkup(createElement(Agents, { agents: sampleAgents }));
  for (const group of ["Foundry", "co-01", "Not running"]) assert.match(agents, new RegExp(`>${group}</th>`));
  assert.match(agents, /Start once VC funds co-03/);
});
