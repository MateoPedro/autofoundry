import assert from "node:assert/strict";
import test from "node:test";
import { kill } from "../src/lib/server/foundry/company";
import { publishSample } from "../src/lib/server/foundry/crew";
import { logTouch } from "../src/lib/server/foundry/leads";
import { companyRow, page, proposed, spawned } from "./helpers/company";
import { run } from "./helpers/fixtures";

const publish = (s: { ctx: Parameters<typeof run>[1]; companyId: string }, leadId: string, html = page(leadId)) =>
  run(publishSample, s.ctx, { company_id: s.companyId, lead_id: leadId, agent_name: "creator", html });

test("the company is proposed once its last sample is published", async () => {
  const s = await spawned(5);
  for (const leadId of s.sampled.slice(0, 4)) await publish(s, leadId);
  assert.equal((await companyRow(s.ctx, s.companyId)).status, "spawning");
  await publish(s, s.sampled[4]);
  assert.equal((await companyRow(s.ctx, s.companyId)).status, "proposed");
  assert.deepEqual(s.naive.cards, []);
});

test("a lead Creator couldn't sample doesn't hold its company back", async () => {
  const s = await spawned(2);
  await publish(s, s.sampled[0]);
  await run(logTouch, s.ctx, { company_id: s.companyId, lead_id: s.sampled[1], agent_name: "creator", channel: "contact_form", kind: "failed", detail: "site is down" });
  assert.equal((await companyRow(s.ctx, s.companyId)).status, "proposed");
});

test("publish_sample stores the page and points at the foundry", async () => {
  const s = await spawned(1);
  const [leadId] = s.sampled;
  const out = (await publish(s, leadId)) as { sample_url: string };
  assert.equal(out.sample_url, `https://foundry.test/s/${leadId}`);
  await publish(s, leadId, "<p>second</p>");
  const samples = await s.ctx.db.query<{ html: string }>("select html from samples where lead_id = $1", [leadId]);
  assert.deepEqual(samples, [{ html: "<p>second</p>" }]);
  const [lead] = await s.ctx.db.query<{ sample_url: string; status: string }>("select sample_url, status from leads where id = $1", [leadId]);
  assert.deepEqual(lead, { sample_url: `https://foundry.test/s/${leadId}`, status: "assigned" });
  const touches = await s.ctx.db.query("select kind, detail from touches where lead_id = $1", [leadId]);
  assert.deepEqual(touches, [
    { kind: "sample_delivered", detail: `https://foundry.test/s/${leadId}` },
    { kind: "sample_delivered", detail: `https://foundry.test/s/${leadId}` },
  ]);
});

test("publish_sample on an active company wakes Outreach once", async () => {
  const s = await proposed(1);
  await s.ctx.db.query("update companies set status = 'active' where id = $1", [s.companyId]);
  const [leadId] = await s.ctx.db.query<{ id: string }>(
    "insert into leads (id, cluster_id, company_id, name, status) values ('ld_new', $1, $2, 'New Lead', 'assigned') returning id",
    [s.clusterId, s.companyId],
  ).then((rows) => rows.map((r) => r.id));
  await publish(s, leadId);
  await publish(s, leadId);
  assert.deepEqual(s.naive.cards.map((c) => [c.title, c.assignee]), [[`Contact ${leadId} for ${s.companyId}`, "outreach"]]);
});

test("publish_sample refuses a killed company and a lead from elsewhere", async () => {
  const s = await spawned(1);
  const other = await spawned(1);
  await assert.rejects(publish(s, other.sampled[0]), { code: "not_found" });
  await run(kill, s.ctx, { company_id: s.companyId, reason: "declined" });
  await assert.rejects(publish(s, s.sampled[0]), { code: "killed" });
});
