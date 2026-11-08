import assert from "node:assert/strict";
import test from "node:test";
import { fund, kill, spawn } from "../src/lib/server/foundry/company";
import { setup, spawnArgs } from "./helpers/company";
import type { FakeNaive } from "./helpers/fake-naive";
import { run, seedCluster, seedCompany, seedOffer, testContext } from "./helpers/fixtures";

const crewTeam = (naive: FakeNaive) => ({
  type: "coordinator",
  agents: [{ type: "self" }, { type: "agent", id: naive.agent("co-01-outreach").id }, { type: "agent", id: naive.agent("co-01-closer").id }],
  board: true,
});

test("spawn creates the identity, app, three zero-budget agents, inbox and one Builder card per lead", async () => {
  const { naive, ctx, offerId, leadIds } = await setup();
  const out = (await run(spawn, ctx, spawnArgs(offerId))) as Record<string, unknown>;

  assert.equal(out.slug, "co-01");
  assert.equal(out.status, "proposed");
  assert.deepEqual(out.agents, ["co-01-outreach", "co-01-closer", "co-01-builder"]);
  assert.equal(out.cards, 3);
  assert.equal(out.inbox, "co-01@auto-foundry-03s9ve.usenaive.ai");
  assert.equal(out.app_url, "https://co-01-p2jr2103s9ve-naive-e9517ea2.vercel.app");

  assert.equal(naive.identities.length, 1);
  assert.equal(naive.apps.length, 1);
  assert.ok(naive.agents.every((a) => a.budget.cap_micro_usd === 0 && a.budget.max_task_micro_usd === 0 && a.budget.period === "month"));
  assert.ok(naive.agents.every((a) => a.identities.includes(naive.identities[0].id)));
  assert.equal(naive.inboxes[0].owner, naive.agent("co-01-closer").id);
  assert.deepEqual(
    naive.cards.map((c) => [c.assignee, c.status, JSON.parse(c.body).lead_id]),
    leadIds.map((id) => ["co-01-builder", "blocked", id]),
  );

  const leads = await ctx.db.query<{ company_id: string; status: string }>("select company_id, status from leads");
  assert.ok(leads.every((l) => l.company_id === out.company_id && l.status === "assigned"));
  const [d] = await ctx.db.query("select agent, kind, company_id, offer_id, reason from decisions");
  assert.deepEqual(d, { agent: "creator", kind: "spawn", company_id: out.company_id, offer_id: offerId, reason: "3 leads, approved, nobody serving the cluster" });
});

test("spawn fills the offer into the templates and leaves the per-lead placeholders", async () => {
  const { naive, ctx, offerId } = await setup(1);
  const out = (await run(spawn, ctx, spawnArgs(offerId))) as { company_id: string };
  const app = naive.apps[0];

  const outreach = naive.agent("co-01-outreach").config;
  assert.match(String(outreach.system), /Hi \{\{lead_name\}\}, I am an AI agent\. \{\{sample_url\}\}/);
  assert.match(String(outreach.system), /through contact_form/);
  const closer = naive.agent("co-01-closer").config;
  assert.match(String(closer.system), new RegExp(`co-01@auto-foundry-03s9ve\\.usenaive\\.ai for ${out.company_id}\\. Sell One-page site on your domain for \\$99`));
  const builder = naive.agent("co-01-builder").config as { tools: { configs: { apps: { config: { allowed_apps: string[] } } } }; metadata: Record<string, unknown> };
  assert.deepEqual(builder.tools.configs.apps.config.allowed_apps, ["app_foundry", app.id]);
  assert.deepEqual(builder.metadata, { template: "child", company: out.company_id, project: "autofoundry", company_id: out.company_id, role: "builder" });
});

test("spawn makes the Builder its crew's board coordinator, with Outreach and the Closer as members", async () => {
  const { naive, ctx, offerId } = await setup(1);
  await run(spawn, ctx, spawnArgs(offerId));

  assert.deepEqual(naive.agent("co-01-builder").config.multiagent, crewTeam(naive));
  assert.equal(naive.agent("co-01-outreach").config.multiagent, undefined);
  assert.equal(naive.agent("co-01-closer").config.multiagent, undefined);
  assert.deepEqual(naive.boards.map((b) => b.agent_id), [naive.agent("co-01-builder").id]);
});

test("a retry makes a Builder that isn't coordinating its crew the coordinator", async () => {
  const { naive, ctx, offerId } = await setup(1);
  naive.failOn.set("createInbox", Object.assign(new Error("service unavailable"), { status: 503 }));
  await assert.rejects(run(spawn, ctx, spawnArgs(offerId)), { code: "naive_error" });
  delete naive.agent("co-01-builder").config.multiagent;

  naive.failOn.clear();
  await run(spawn, ctx, spawnArgs(offerId));
  assert.deepEqual(naive.agent("co-01-builder").config.multiagent, crewTeam(naive));
});

test("spawn takes the oldest lead_count leads that no company has", async () => {
  const { ctx, clusterId, offerId, leadIds } = await setup(4);
  const other = await seedCompany(ctx.db, { clusterId, slug: "co-07", status: "killed" });
  await ctx.db.query("update leads set company_id = $1, status = 'contacted' where id = $2", [other.companyId, leadIds[0]]);

  const out = (await run(spawn, ctx, spawnArgs(offerId, { lead_count: 2 }))) as { company_id: string; slug: string; cards: number };
  assert.equal(out.slug, "co-08");
  assert.equal(out.cards, 2);
  const mine = await ctx.db.query<{ id: string }>("select id from leads where company_id = $1 order by created_at, id", [out.company_id]);
  assert.deepEqual(mine.map((l) => l.id), [leadIds[1], leadIds[2]]);
});

test("a failed spawn marks the company failed, names the step, and resumes on retry without duplicates", async () => {
  const { naive, ctx, offerId } = await setup();
  naive.failOn.set("createInbox", Object.assign(new Error("service unavailable"), { status: 503 }));

  await assert.rejects(run(spawn, ctx, spawnArgs(offerId)), (error: { code: string; message: string }) => {
    assert.equal(error.code, "naive_error");
    assert.match(error.message, /create the inbox: 503: service unavailable/);
    return true;
  });
  const [failed] = await ctx.db.query<{ id: string; status: string }>("select id, status from companies");
  assert.equal(failed.status, "failed");

  naive.failOn.clear();
  const out = (await run(spawn, ctx, spawnArgs(offerId))) as { company_id: string; status: string; cards: number };
  assert.equal(out.company_id, failed.id);
  assert.equal(out.status, "proposed");
  assert.equal(out.cards, 3);
  assert.equal(naive.identities.length, 1);
  assert.equal(naive.apps.length, 1);
  assert.equal(naive.agents.length, 3);
  assert.equal(naive.inboxes.length, 1);
  assert.equal(naive.cards.length, 3);
  assert.equal((await ctx.db.query("select 1 from companies")).length, 1);
  assert.equal((await ctx.db.query("select 1 from decisions where kind = 'spawn'")).length, 1);
});

test("a retry adopts an agent Naïve made before the answer was lost", async () => {
  const { naive, ctx, offerId } = await setup(1);
  naive.loseAnswerOn.add("createAgent");
  await assert.rejects(run(spawn, ctx, spawnArgs(offerId)), { code: "naive_error" });
  assert.equal(naive.agents.length, 1);

  const out = (await run(spawn, ctx, spawnArgs(offerId))) as { status: string };
  assert.equal(out.status, "proposed");
  assert.deepEqual(naive.agents.map((a) => a.name), ["co-01-outreach", "co-01-closer", "co-01-builder"]);
});

test("a retry of a finished spawn answers the same company and calls nothing", async () => {
  const { naive, ctx, offerId } = await setup();
  const first = await run(spawn, ctx, spawnArgs(offerId));
  const calls = naive.calls.length;
  assert.deepEqual(await run(spawn, ctx, spawnArgs(offerId)), first);
  assert.equal(naive.calls.length, calls);
});

test("spawn refuses when max_proposed companies are waiting", async () => {
  const { ctx, offerId } = await setup();
  for (const status of ["proposed", "proposed", "spawning"]) await seedCompany(ctx.db, { status });
  await assert.rejects(run(spawn, ctx, spawnArgs(offerId)), { code: "policy", message: /max_proposed: 3/ });
  assert.equal((await ctx.db.query("select 1 from leads where company_id is not null")).length, 0);
});

test("spawn refuses an unapproved offer, an unknown offer or parent, an empty cluster, and a reused request_id", async () => {
  const { ctx, clusterId, offerId } = await setup(1);
  const pending = await seedOffer(ctx.db, clusterId, "pending");
  await assert.rejects(run(spawn, ctx, spawnArgs(pending)), { code: "not_approved" });
  await assert.rejects(run(spawn, ctx, spawnArgs("of_missing")), { code: "not_found" });
  await assert.rejects(run(spawn, ctx, spawnArgs(offerId, { parent_id: "co_missing" })), { code: "not_found" });

  const emptyCluster = await seedCluster(ctx.db, "empty");
  await assert.rejects(run(spawn, ctx, spawnArgs(await seedOffer(ctx.db, emptyCluster))), { code: "invalid" });
  assert.equal((await ctx.db.query("select 1 from companies")).length, 0);

  await run(spawn, ctx, spawnArgs(offerId));
  await assert.rejects(run(spawn, ctx, spawnArgs(await seedOffer(ctx.db, clusterId))), { code: "conflict" });
});

test("spawn, fund and kill refuse without the write key", async () => {
  const ctx = await testContext();
  await assert.rejects(run(spawn, ctx, spawnArgs("of_x")), { code: "internal", message: /NAIVE_WRITE_KEY/ });
  await assert.rejects(run(fund, ctx, { company_id: "co_x", reason: "r" }), { code: "internal" });
  await assert.rejects(run(kill, ctx, { company_id: "co_x", reason: "r" }), { code: "internal" });
});

test("spawn reports broken templates before it creates anything", async () => {
  const { naive, ctx, offerId } = await setup();
  ctx.childTemplate = async () => {
    throw new Error("ENOENT templates/child/agents/builder.agent.yaml");
  };
  await assert.rejects(run(spawn, ctx, spawnArgs(offerId)), { code: "internal", message: /templates\/child/ });
  assert.equal(naive.calls.length, 0);
  assert.equal((await ctx.db.query("select 1 from companies")).length, 0);
});

