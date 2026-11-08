import assert from "node:assert/strict";
import test from "node:test";
import { logTouch } from "../src/lib/server/foundry/leads";
import { getMetrics } from "../src/lib/server/foundry/metrics";
import { companySpend, syncSessionSpend } from "../src/lib/server/foundry/spend";
import { wake, WORK } from "../src/lib/server/foundry/work";
import { funded } from "./helpers/company";
import { NOW, run } from "./helpers/fixtures";

const hourAgo = new Date(NOW.getTime() - 3_600_000);

async function sessionRows(s: Awaited<ReturnType<typeof funded>>) {
  return s.ctx.db.query<{ session_id: string; agent_name: string; company_id: string | null; micro_usd: unknown }>(
    "select session_id, agent_name, company_id, micro_usd from session_spend order by session_id",
  );
}

test("a session is charged to the company named on its card", async () => {
  const s = await funded(1);
  const card = s.naive.cards.find((c) => c.assignee === "outreach")!;
  s.naive.addSession("outreach", { id: "ses_1", created_at: NOW.toISOString(), consumed_micro_usd: 40_000, card_ids: [card.id], inbound_message_id: null });

  assert.equal(await syncSessionSpend(s.ctx, hourAgo), 1);
  const [row] = await sessionRows(s);
  assert.deepEqual({ ...row, micro_usd: Number(row.micro_usd) }, { session_id: "ses_1", agent_name: "outreach", company_id: s.companyId, micro_usd: 40_000 });
  assert.equal(await companySpend(s.ctx.db, s.companyId), 40_000);
});

test("an inbound session is charged through the message id the Closer logged", async () => {
  const s = await funded(1);
  await run(logTouch, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0], agent_name: "closer", channel: "email", kind: "reply_received", message_id: "inb_1" });
  s.naive.addSession("closer", { id: "ses_2", created_at: NOW.toISOString(), consumed_micro_usd: 25_000, card_ids: [], inbound_message_id: "inb_1" });
  await syncSessionSpend(s.ctx, hourAgo);
  assert.equal((await sessionRows(s))[0].company_id, s.companyId);
});

test("a session with neither is parent overhead", async () => {
  const s = await funded(1);
  const design = s.naive.cards.find((c) => c.assignee === "feedback")!;
  s.naive.addSession("creator", { id: "ses_3", created_at: NOW.toISOString(), consumed_micro_usd: 90_000, card_ids: ["crd_unknown"], inbound_message_id: null });
  s.naive.addSession("feedback", { id: "ses_4", created_at: NOW.toISOString(), consumed_micro_usd: 5_000, card_ids: [design.id], inbound_message_id: null });
  s.naive.addSession("outreach", { id: "ses_old", created_at: new Date(hourAgo.getTime() - 1).toISOString(), consumed_micro_usd: 1, card_ids: [], inbound_message_id: null });
  assert.equal(await syncSessionSpend(s.ctx, hourAgo), 1);
  assert.deepEqual((await sessionRows(s)).map((r) => [r.session_id, r.company_id]), [["ses_3", null]]);
});

test("a session's cost is updated as it grows", async () => {
  const s = await funded(1);
  const card = s.naive.cards.find((c) => c.assignee === "outreach")!;
  const session = s.naive.addSession("outreach", { id: "ses_5", created_at: NOW.toISOString(), consumed_micro_usd: 10, card_ids: [card.id], inbound_message_id: null });
  await syncSessionSpend(s.ctx, hourAgo);
  session.consumed_micro_usd = 30;
  await syncSessionSpend(s.ctx, hourAgo);
  assert.equal(await companySpend(s.ctx.db, s.companyId), 30);
});

test("a company at its grant gets no new Outreach work, but its Deliver card still goes out", async () => {
  const s = await funded(1);
  await s.ctx.db.query("insert into session_spend (session_id, agent_name, company_id, micro_usd, started_at) values ('ses_big', 'outreach', $1, 5000000, $2)", [s.companyId, NOW]);
  assert.deepEqual(await wake(s.ctx, WORK.followUp(s.leadIds[0], s.companyId)), { created: false, reason: "over_grant" });
  assert.deepEqual(await wake(s.ctx, WORK.deliver(s.leadIds[0], s.companyId)), { created: true });
});

test("get_metrics reports a company's spend from its sessions", async () => {
  const s = await funded(1);
  await s.ctx.db.query(
    "insert into session_spend (session_id, agent_name, company_id, micro_usd, started_at) values ('ses_a', 'outreach', $1, 300000, $2), ('ses_b', 'creator', null, 999, $2)",
    [s.companyId, NOW],
  );
  const m = (await run(getMetrics, s.ctx, { company_id: s.companyId })) as { companies: { spend_micro_usd: number }[] };
  assert.equal(m.companies[0].spend_micro_usd, 300_000);
});

test("the spend sync reads crew sessions too", async () => {
  const s = await funded(1);
  const card = s.naive.cards.find((c) => c.assignee === "outreach")!;
  s.naive.addSession("outreach", { id: "ses_sync", created_at: NOW.toISOString(), consumed_micro_usd: 70_000, card_ids: [card.id], inbound_message_id: null });
  const m = (await run(getMetrics, { ...s.ctx, spend: { listAgentSpend: async () => [] } }, { company_id: s.companyId })) as {
    spend_stale: boolean;
    companies: { spend_micro_usd: number }[];
  };
  assert.equal(m.spend_stale, false);
  assert.equal(m.companies[0].spend_micro_usd, 70_000);
});
