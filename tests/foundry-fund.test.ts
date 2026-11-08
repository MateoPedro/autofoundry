import assert from "node:assert/strict";
import test from "node:test";
import { fund, kill } from "../src/lib/server/foundry/company";
import { logTouch } from "../src/lib/server/foundry/leads";
import { companyRow, setup, spawned } from "./helpers/company";
import { run, seedCompany } from "./helpers/fixtures";

test("the first grant splits by budget_split, activates the company, and resumes the parked cards", async () => {
  const { naive, ctx, companyId } = await spawned();
  const out = await run(fund, ctx, { company_id: companyId, reason: "3 leads, clear sample" });

  assert.deepEqual(out, {
    company_id: companyId,
    status: "active",
    granted_micro_usd: 5_000_000,
    pool_left_micro_usd: 5_000_000,
    agents: [
      { name: "co-01-builder", cap_micro_usd: 2_500_000 },
      { name: "co-01-outreach", cap_micro_usd: 1_500_000 },
      { name: "co-01-closer", cap_micro_usd: 1_000_000 },
    ],
    cards_resumed: 3,
  });
  assert.deepEqual(naive.agent("co-01-builder").budget, { cap_micro_usd: 2_500_000, max_task_micro_usd: 2_500_000, period: "month" });
  assert.ok(naive.cards.every((c) => c.status === "todo"));
  const row = await companyRow(ctx, companyId);
  assert.equal(row.status, "active");
  assert.equal(row.granted_micro_usd, 5_000_000);
  assert.ok(row.funded_at);
  const [d] = await ctx.db.query<Record<string, unknown>>("select agent, kind, company_id, amount_micro_usd, reason from decisions where kind = 'fund'");
  assert.deepEqual({ ...d, amount_micro_usd: Number(d.amount_micro_usd) }, {
    agent: "vc",
    kind: "fund",
    company_id: companyId,
    amount_micro_usd: 5_000_000,
    reason: "3 leads, clear sample",
  });
});

test("a second grant raises caps to the share of everything granted, then the empty pool refuses a third", async () => {
  const { naive, ctx, companyId } = await spawned();
  await run(fund, ctx, { company_id: companyId, reason: "first" });
  const second = (await run(fund, ctx, { company_id: companyId, reason: "it converts" })) as Record<string, unknown>;
  assert.equal(second.granted_micro_usd, 10_000_000);
  assert.equal(second.pool_left_micro_usd, 0);
  assert.equal(naive.agent("co-01-outreach").budget.cap_micro_usd, 3_000_000);

  await assert.rejects(run(fund, ctx, { company_id: companyId, reason: "more" }), { code: "policy", message: /^pool:/ });
  assert.equal((await ctx.db.query("select 1 from decisions where kind = 'fund'")).length, 2);
});

test("fund refuses past max_grants_per_company and max_active", async () => {
  const { ctx, companyId } = await spawned();
  await ctx.db.query("update funding_policy set max_grants_per_company = 1, pool_micro_usd = 100000000");
  await run(fund, ctx, { company_id: companyId, reason: "first" });
  await assert.rejects(run(fund, ctx, { company_id: companyId, reason: "again" }), { code: "policy", message: /max_grants_per_company/ });

  await seedCompany(ctx.db, { status: "active" });
  const { companyId: waiting } = await seedCompany(ctx.db, { status: "proposed" });
  await assert.rejects(run(fund, ctx, { company_id: waiting, reason: "third" }), { code: "policy", message: /max_active: 2/ });
});

test("fund refuses a killed, unfinished or unknown company", async () => {
  const { naive, ctx } = await setup(0);
  const { companyId: killed } = await seedCompany(ctx.db, { status: "killed" });
  const { companyId: failed } = await seedCompany(ctx.db, { status: "failed" });
  await assert.rejects(run(fund, ctx, { company_id: killed, reason: "r" }), { code: "killed" });
  await assert.rejects(run(fund, ctx, { company_id: failed, reason: "r" }), { code: "conflict" });
  await assert.rejects(run(fund, ctx, { company_id: "co_missing", reason: "r" }), { code: "not_found" });
  assert.equal(naive.calls.length, 0);
});

test("a Naïve failure while funding records nothing, and the retry sets the same caps", async () => {
  const { naive, ctx, companyId } = await spawned();
  naive.failOn.set("cardsOf", Object.assign(new Error("bad gateway"), { status: 502 }));
  await assert.rejects(run(fund, ctx, { company_id: companyId, reason: "go" }), { code: "naive_error" });
  const row = await companyRow(ctx, companyId);
  assert.equal(row.status, "proposed");
  assert.equal(row.granted_micro_usd, 0);
  assert.equal((await ctx.db.query("select 1 from decisions where kind = 'fund'")).length, 0);

  naive.failOn.clear();
  await run(fund, ctx, { company_id: companyId, reason: "go" });
  assert.equal(naive.agent("co-01-builder").budget.cap_micro_usd, 2_500_000);
});

test("kill zeroes every agent, checks Naïve, and marks the company killed with the reason", async () => {
  const { naive, ctx, companyId } = await spawned();
  await run(fund, ctx, { company_id: companyId, reason: "go" });
  const out = await run(kill, ctx, { company_id: companyId, reason: "40 touches, 0 replies, $4.10 spent" });

  assert.deepEqual(out, { company_id: companyId, status: "killed", agents_stopped: 3 });
  assert.ok(naive.agents.every((a) => a.budget.cap_micro_usd === 0 && a.budget.max_task_micro_usd === 0));
  assert.equal(naive.calls.filter((c) => c === "getBudget").length, 3);
  const row = await companyRow(ctx, companyId);
  assert.equal(row.status, "killed");
  assert.ok(row.killed_at);
  const [d] = await ctx.db.query("select agent, kind, reason from decisions where kind = 'kill'");
  assert.deepEqual(d, { agent: "vc", kind: "kill", reason: "40 touches, 0 replies, $4.10 spent" });

  await assert.rejects(run(kill, ctx, { company_id: companyId, reason: "again" }), { code: "killed" });
  await assert.rejects(run(logTouch, ctx, { company_id: companyId, agent_name: "co-01-outreach", channel: "email", kind: "sent" }), { code: "killed" });
});

test("kill leaves the company alive when Naïve still shows a cap", async () => {
  const { naive, ctx, companyId } = await spawned();
  await run(fund, ctx, { company_id: companyId, reason: "go" });
  naive.budgetReadback = { cap_micro_usd: 2_500_000 };
  await assert.rejects(run(kill, ctx, { company_id: companyId, reason: "stop" }), { code: "naive_error", message: /still has a cap/ });
  assert.equal((await companyRow(ctx, companyId)).status, "active");
  assert.equal((await ctx.db.query("select 1 from decisions where kind = 'kill'")).length, 0);
});
