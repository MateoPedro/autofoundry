import assert from "node:assert/strict";
import test from "node:test";
import { agentProfiles, readSite } from "../src/lib/server/site";
import { titleOf } from "../src/lib/site/view";
import { NOW, seedCompany, seedLead, testContext } from "./helpers/fixtures";

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

test("the site reads each company's story: kill reason, lifespan, spend, failed outreach and the crew that ran it", async () => {
  const ctx = await testContext();
  const alive = await seedCompany(ctx.db, { slug: "co-01" });
  const dead = await seedCompany(ctx.db, { slug: "co-02", status: "killed" });
  await ctx.db.query("update companies set spawned_at = $2, killed_at = $3, granted_micro_usd = 2500000 where id = $1", [dead.companyId, minutesAgo(90), minutesAgo(30)]);
  await ctx.db.query("update companies set spawned_at = $2, funded_at = $3, granted_micro_usd = 2500000 where id = $1", [alive.companyId, minutesAgo(120), minutesAgo(100)]);
  const lead = await seedLead(ctx.db, dead.clusterId, { companyId: dead.companyId, name: "Be Salon", sampleUrl: "https://foundry.test/s/1" });
  await ctx.db.query(
    `insert into decisions (id, agent, kind, cluster_id, company_id, amount_micro_usd, reason, at) values
       ('dc_spawn', 'creator', 'spawn', null, $1, null, 'nobody serves it', $3),
       ('dc_kill', 'vc', 'kill', null, $1, null, 'phone-only, no form', $4),
       ('dc_fund', 'vc', 'fund', null, $2, 2500000, 'emails verified', $5)`,
    [dead.companyId, alive.companyId, minutesAgo(90), minutesAgo(30), minutesAgo(100)],
  );
  await ctx.db.query(
    "insert into touches (id, company_id, lead_id, agent_name, channel, kind, detail, at) values ('tc_1', $1, $2, 'outreach', 'contact_form', 'failed', 'form requires a phone number', $3)",
    [dead.companyId, lead, minutesAgo(40)],
  );
  await ctx.db.query(
    "insert into session_spend (session_id, agent_name, company_id, micro_usd, started_at, synced_at) values ('ses_1', 'outreach', $1, 70000, $2, $2)",
    [dead.companyId, minutesAgo(40)],
  );
  await ctx.db.query(
    "insert into scout_feedback (id, kind, body, through_at, through_id, created_at) values ('fb_1', 'note', 'KILL salons: phone-only → verify route', $1, 'dc_kill', $1)",
    [minutesAgo(29)],
  );

  const site = await readSite(ctx);
  const co2 = site.companies.find((c) => c.slug === "co-02");
  assert.ok(co2);
  assert.equal(co2.kill_reason, "phone-only, no form");
  assert.equal(co2.spawn_reason, "nobody serves it");
  assert.equal(co2.failed_touches, 1);
  assert.equal(co2.spend_micro_usd, 70_000);
  assert.deepEqual(co2.crew, [{ agent: "outreach", micro_usd: 70_000, sessions: 1 }]);
  assert.equal(co2.sample_url, "https://foundry.test/s/1");
  assert.deepEqual(co2.decisions.map((d) => d.kind), ["spawn", "kill"], "oldest first");
  assert.equal(site.companies.find((c) => c.slug === "co-01")?.fund_reason, "emails verified");

  assert.equal(site.totals.companies, 2);
  assert.equal(site.totals.alive, 1);
  assert.equal(site.totals.killed, 1);
  assert.equal(site.totals.median_minutes_to_kill, 60);
  assert.equal(site.totals.killed_spend_micro_usd, 70_000);
  assert.equal(site.feedback.length, 1);
  assert.equal(site.feedback[0].live, true);
  assert.equal(site.decisions[0].id, "dc_kill", "newest first");
  assert.deepEqual(site.agents.map((a) => a.key), ["scout", "compliance", "creator", "vc", "feedback", "outreach", "closer"]);
  assert.equal(site.agents.find((a) => a.key === "vc")?.work, 2);
});

test("agent profiles come from the deployed agent configs and prompts", async () => {
  const profiles = await agentProfiles();
  assert.ok(profiles.vc.prompt.length > 100);
  assert.ok(profiles.vc.tools.includes("foundry.kill"));
  assert.match(profiles.vc.model, /GLM/);
});

test("a company's title is its product line's headline, without inventing a name", () => {
  assert.equal(titleOf("The complete sync engine design package: full specification"), "Complete sync engine design package");
  assert.equal(titleOf("A full web-presence audit report — exact steps to fix"), "Full web-presence audit report");
  assert.equal(titleOf("One month of agent-run bookkeeping: transaction categorization"), "Month of agent-run bookkeeping");
});
