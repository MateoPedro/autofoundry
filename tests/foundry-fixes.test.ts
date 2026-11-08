import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../src/lib/server/db";
import { fund, kill } from "../src/lib/server/foundry/company";
import { publishSample } from "../src/lib/server/foundry/crew";
import { findLead } from "../src/lib/server/foundry/leads";
import { getMetrics } from "../src/lib/server/foundry/metrics";
import { reconcile } from "../src/lib/server/foundry/reconcile";
import { companyOfSession } from "../src/lib/server/foundry/spend";
import { wake, WORK } from "../src/lib/server/foundry/work";
import type { ToolContext } from "../src/lib/server/foundry/tool";
import type { FakeNaive } from "./helpers/fake-naive";
import { funded, page, proposed, spawned } from "./helpers/company";
import { crewContext } from "./helpers/crew";
import { NOW, run, seedCluster, seedLead } from "./helpers/fixtures";

const later = (ctx: ToolContext, hours: number) => ({ ...ctx, now: () => new Date(NOW.getTime() + hours * 3_600_000) });

// Records whether each Naïve card is created while a transaction is still open.
function watchTransactions(ctx: ToolContext & { naive: FakeNaive }) {
  let open = 0;
  const seen: boolean[] = [];
  const db = ctx.db;
  const watched: Db = { query: (sql, params) => db.query(sql, params), tx: async (fn) => { open++; try { return await db.tx(fn); } finally { open--; } } };
  ctx.db = watched;
  const create = ctx.naive.createCard.bind(ctx.naive);
  ctx.naive.createCard = async (...args) => {
    seen.push(open > 0);
    return create(...args);
  };
  return seen;
}

test("a grant's cards go out only after it commits, and the sweep posts any that failed", async () => {
  const s = await proposed(3);
  const inTx = watchTransactions(s.ctx);
  let calls = 0;
  const create = s.naive.createCard;
  s.naive.createCard = async (...args) => {
    if (++calls === 2) throw Object.assign(new Error("rate limited"), { status: 429 });
    return create(...args);
  };

  const out = (await run(fund, s.ctx, { company_id: s.companyId, reason: "go" })) as { status: string };
  assert.equal(out.status, "active");
  assert.ok(inTx.length > 0 && inTx.every((open) => !open), "no card is created inside the grant's transaction");
  assert.equal(s.naive.cards.filter((c) => c.assignee === "outreach").length, 2);

  await reconcile(s.ctx);
  assert.equal(s.naive.cards.filter((c) => c.assignee === "outreach").length, 3);
});

test("publish_sample and kill create and close cards only after they commit", async () => {
  const s = await proposed(1);
  await s.ctx.db.query("update companies set status = 'active', granted_micro_usd = 5000000 where id = $1", [s.companyId]);
  await s.ctx.db.query("insert into leads (id, cluster_id, company_id, name, status) values ('ld_late', $1, $2, 'Late', 'assigned')", [s.clusterId, s.companyId]);
  const inTx = watchTransactions(s.ctx);
  await run(publishSample, s.ctx, { company_id: s.companyId, lead_id: "ld_late", agent_name: "creator", html: page("ld_late") });
  await run(kill, s.ctx, { company_id: s.companyId, reason: "stop" });
  assert.ok(inTx.length > 0 && inTx.every((open) => !open));
});

test("a card woken while stopped waits and goes out on the next sweep", async () => {
  const ctx = await crewContext();
  await ctx.db.query("update foundry_state set running = false");
  assert.deepEqual(await wake(ctx, WORK.design("cl_1")), { created: false, reason: "stopped" });
  assert.equal(ctx.naive.cards.length, 0);
  await ctx.db.query("update foundry_state set running = true");
  await reconcile(ctx);
  assert.deepEqual(ctx.naive.cards.map((c) => c.title), ["Design a company for cluster cl_1"]);
});

test("kill leaves a paid buyer's Deliver card open", async () => {
  const s = await funded(1);
  await wake(s.ctx, WORK.deliver(s.leadIds[0], s.companyId));
  await run(kill, s.ctx, { company_id: s.companyId, reason: "stop" });
  assert.equal(s.naive.cards.find((c) => c.assignee === "closer")!.status, "todo");
});

test("a company stuck spawning gets another Creator card after two hours, three at most", async () => {
  const s = await spawned(2);
  await run(publishSample, s.ctx, { company_id: s.companyId, lead_id: s.sampled[0], agent_name: "creator", html: page(s.sampled[0]) });
  await s.ctx.db.query("update companies set spawned_at = $2 where id = $1", [s.companyId, NOW]);
  assert.equal((await reconcile(later(s.ctx, 1))).created.sample, 0);
  for (const hours of [3, 6, 9, 12]) await reconcile(later(s.ctx, hours));
  const retries = s.naive.cards.filter((c) => c.title === `Sample new leads for ${s.companyId}`);
  assert.equal(retries.length, 3);
});

test("a design card that never spawned frees its slot after six hours", async () => {
  const ctx = await crewContext();
  const clusters: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = await seedCluster(ctx.db, `queued ${i}`);
    await ctx.db.query("update clusters set created_at = $2 where id = $1", [id, new Date(Date.UTC(2026, 10, 1, i))]);
    await seedLead(ctx.db, id, { name: `free ${i}` });
    clusters.push(id);
  }
  assert.equal((await reconcile(ctx)).created.design, 3);
  assert.equal((await reconcile(later(ctx, 1))).created.design, 0);
  const after = await reconcile(later(ctx, 7));
  assert.ok(after.created.design >= 1, "expired designs free their slots");
  assert.ok(ctx.naive.cards.some((c) => c.title === `Design a company for cluster ${clusters[3]}`));
});

test("a failed session sync keeps spend stale until it succeeds", async () => {
  const s = await funded(1);
  s.naive.failOn.set("sessionsSince", Object.assign(new Error("forbidden"), { status: 403 }));
  const spend = { listAgentSpend: async () => [{ agent_id: "agt_x", agent_name: "scout", micro_usd: 1 }] };
  const first = (await run(getMetrics, { ...s.ctx, spend }, {})) as { spend_stale: boolean; spend_error?: string };
  assert.equal(first.spend_stale, true);
  assert.match(first.spend_error ?? "", /forbidden/);
  const second = (await run(getMetrics, { ...s.ctx, spend }, {})) as { spend_stale: boolean };
  assert.equal(second.spend_stale, true, "the next call tries again instead of trusting the agent totals");
});

test("inbound skips mail Naïve held for a thread cap or a sender rate limit", async () => {
  const s = await funded(1);
  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  s.naive.addInbound({ id: "inb_cap", from: "bot@example.com", subject: "Re", text: "ticket", received_at: at, guard_reason: "thread_turn_cap" });
  s.naive.addInbound({ id: "inb_rate", from: "bot@example.com", subject: "Re", text: "ticket", received_at: at, guard_reason: "sender_rate_limit" });
  assert.equal((await reconcile(s.ctx)).created.inbound, 0);
});

test("find_lead finds a paid buyer of a killed company", async () => {
  const s = await funded(2);
  await s.ctx.db.query("update leads set email = 'paid@example.com', status = 'paid' where id = $1", [s.leadIds[0]]);
  await s.ctx.db.query("update leads set email = 'other@example.com' where id = $1", [s.leadIds[1]]);
  await run(kill, s.ctx, { company_id: s.companyId, reason: "stop" });
  const paid = (await run(findLead, s.ctx, { email: "paid@example.com" })) as { leads: { id: string }[] };
  assert.deepEqual(paid.leads.map((l) => l.id), [s.leadIds[0]]);
  const other = (await run(findLead, s.ctx, { email: "other@example.com" })) as { leads: unknown[] };
  assert.deepEqual(other.leads, []);
});

test("a sweep's Answer-email session is charged through the message id it names", async () => {
  const s = await funded(1);
  await s.ctx.db.query("insert into touches (id, company_id, lead_id, agent_name, channel, kind, message_id) values ('tc_m', $1, $2, 'closer', 'email', 'reply_received', 'inb_7')", [s.companyId, s.leadIds[0]]);
  await wake(s.ctx, WORK.inbound("inb_7", "dr@example.com"));
  const card = s.naive.cards.find((c) => c.title.startsWith("Answer email"))!;
  assert.equal(await companyOfSession(s.ctx.db, { card_ids: [card.id], inbound_message_id: null }), s.companyId);
});
