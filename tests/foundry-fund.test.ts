import assert from "node:assert/strict";
import test from "node:test";
import { fund, kill } from "../src/lib/server/foundry/company";
import { logTouch } from "../src/lib/server/foundry/leads";
import { reconcile } from "../src/lib/server/foundry/reconcile";
import { companyRow, proposed } from "./helpers/company";
import { run, seedLead, testContext } from "./helpers/fixtures";

const titles = (s: { naive: { cards: { title: string }[] } }) => s.naive.cards.map((c) => c.title);

test("a first grant activates the company and hands each sampled lead to Outreach", async () => {
  const s = await proposed(5);
  const out = (await run(fund, s.ctx, { company_id: s.companyId, reason: "5 leads, clear sample" })) as Record<string, unknown>;

  assert.equal(out.status, "active");
  assert.equal(out.granted_micro_usd, 5_000_000);
  assert.equal(out.pool_left_micro_usd, 5_000_000);
  assert.equal(out.leads_added, 0);
  assert.equal(out.work_created, 6);
  assert.ok(!s.naive.calls.includes("setBudget"));
  const contacts = s.naive.cards.filter((c) => c.assignee === "outreach");
  assert.deepEqual(contacts.map((c) => c.title).sort(), s.sampled.map((id) => `Contact ${id} for ${s.companyId}`).sort());
  const row = await companyRow(s.ctx, s.companyId);
  assert.equal(row.status, "active");
  assert.ok(row.funded_at);
  const [d] = await s.ctx.db.query<Record<string, unknown>>("select agent, kind, company_id, amount_micro_usd, reason from decisions where kind = 'fund'");
  assert.deepEqual({ ...d, amount_micro_usd: Number(d.amount_micro_usd) }, {
    agent: "vc",
    kind: "fund",
    company_id: s.companyId,
    amount_micro_usd: 5_000_000,
    reason: "5 leads, clear sample",
  });
});

test("a first grant skips a lead Outreach already contacted", async () => {
  const s = await proposed(2);
  await run(logTouch, s.ctx, { company_id: s.companyId, lead_id: s.sampled[0], agent_name: "outreach", channel: "contact_form", kind: "sent" });
  await run(fund, s.ctx, { company_id: s.companyId, reason: "go" });
  assert.deepEqual(titles(s).filter((t) => t.startsWith("Contact")), [`Contact ${s.sampled[1]} for ${s.companyId}`]);
});

test("a second grant adds the next 5 leads and wakes Creator to sample them", async () => {
  const s = await proposed(5);
  for (let i = 0; i < 7; i++) await seedLead(s.ctx.db, s.clusterId, { name: `More ${i}` });
  await run(fund, s.ctx, { company_id: s.companyId, reason: "first" });
  const out = (await run(fund, s.ctx, { company_id: s.companyId, reason: "2 replies" })) as Record<string, unknown>;

  assert.equal(out.leads_added, 5);
  assert.equal(out.granted_micro_usd, 10_000_000);
  assert.ok(titles(s).includes(`Sample new leads for ${s.companyId}`));
  const [{ n }] = await s.ctx.db.query<{ n: number }>("select count(*)::int as n from leads where company_id = $1", [s.companyId]);
  assert.equal(n, 10);
});

test("fund still refuses past the pool, the grant count and max_active", async () => {
  const s = await proposed(1);
  await run(fund, s.ctx, { company_id: s.companyId, reason: "first" });
  await run(fund, s.ctx, { company_id: s.companyId, reason: "second" });
  await assert.rejects(run(fund, s.ctx, { company_id: s.companyId, reason: "third" }), { code: "policy", message: /^pool:/ });

  await s.ctx.db.query("update funding_policy set max_grants_per_company = 2, pool_micro_usd = 100000000");
  await assert.rejects(run(fund, s.ctx, { company_id: s.companyId, reason: "third" }), { code: "policy", message: /max_grants_per_company/ });

  await s.ctx.db.query("update funding_policy set max_active = 1");
  const [{ id: waiting }] = await s.ctx.db.query<{ id: string }>(
    "insert into companies (id, slug, offer_id, cluster_id, status) select 'co_waiting', 'co-77', offer_id, cluster_id, 'proposed' from companies where id = $1 returning id",
    [s.companyId],
  );
  await assert.rejects(run(fund, s.ctx, { company_id: waiting, reason: "another" }), { code: "policy", message: /max_active: 1/ });
});

test("fund refuses a killed, unfinished or unknown company", async () => {
  const s = await proposed(1);
  await s.ctx.db.query("update companies set status = 'spawning' where id = $1", [s.companyId]);
  await assert.rejects(run(fund, s.ctx, { company_id: s.companyId, reason: "r" }), { code: "conflict" });
  await s.ctx.db.query("update companies set status = 'killed' where id = $1", [s.companyId]);
  await assert.rejects(run(fund, s.ctx, { company_id: s.companyId, reason: "r" }), { code: "killed" });
  await assert.rejects(run(fund, s.ctx, { company_id: "co_missing", reason: "r" }), { code: "not_found" });
});

test("a Naïve outage while funding keeps the grant, and the sweep hands out its cards", async () => {
  const s = await proposed(2);
  s.naive.failOn.set("createCard", new Error("board unavailable"));
  const out = (await run(fund, s.ctx, { company_id: s.companyId, reason: "go" })) as { work_created: number };
  assert.equal(out.work_created, 0);
  assert.equal((await companyRow(s.ctx, s.companyId)).status, "active");
  s.naive.failOn.clear();
  await reconcile(s.ctx);
  assert.equal(s.naive.cards.filter((c) => c.assignee === "outreach").length, 2);
});

test("kill closes the company's cards and wakes Feedback, and Creator only if leads remain", async () => {
  const s = await proposed(2);
  await run(fund, s.ctx, { company_id: s.companyId, reason: "go" });
  const out = (await run(kill, s.ctx, { company_id: s.companyId, reason: "10 contacted, 0 replies in 26h" })) as Record<string, unknown>;
  assert.deepEqual(out, { company_id: s.companyId, status: "killed", cards_closed: 2 });
  assert.ok(s.naive.cards.filter((c) => c.assignee === "outreach").every((c) => c.status === "done"));
  assert.ok(!titles(s).some((t) => t.startsWith("Revise")));
  const row = await companyRow(s.ctx, s.companyId);
  assert.equal(row.status, "killed");
  assert.ok(row.killed_at);
  await assert.rejects(run(kill, s.ctx, { company_id: s.companyId, reason: "again" }), { code: "killed" });

  const more = await proposed(1);
  await seedLead(more.ctx.db, more.clusterId, { name: "Unassigned" });
  await run(kill, more.ctx, { company_id: more.companyId, reason: "declined: no inquiry forms" });
  assert.ok(titles(more).includes(`Revise the offer for cluster ${more.clusterId} after ${more.companyId} was killed`));
});

test("fund and kill wake Feedback with the decision id", async () => {
  const s = await proposed(1);
  await run(fund, s.ctx, { company_id: s.companyId, reason: "go" });
  await run(kill, s.ctx, { company_id: s.companyId, reason: "stop" });
  const feedback = s.naive.cards.filter((c) => c.assignee === "feedback").map((c) => c.title);
  const decisions = await s.ctx.db.query<{ id: string }>("select id from decisions where kind in ('fund', 'kill') order by at, kind");
  assert.equal(feedback.length, 2);
  for (const title of feedback) assert.match(title, /^Write feedback through dc_/);
  assert.deepEqual(feedback.sort(), decisions.map((d) => `Write feedback through ${d.id}`).sort());
});

test("fund and kill refuse without the write key", async () => {
  const ctx = await testContext();
  await assert.rejects(run(kill, ctx, { company_id: "co_x", reason: "r" }), { code: "internal", message: /NAIVE_WRITE_KEY/ });
  const s = await proposed(1);
  await assert.rejects(run(fund, { ...s.ctx, naive: null }, { company_id: s.companyId, reason: "r" }), { code: "internal", message: /NAIVE_WRITE_KEY/ });
  assert.equal((await companyRow(s.ctx, s.companyId)).status, "proposed");
});
