import assert from "node:assert/strict";
import test from "node:test";
import { fund, kill } from "../src/lib/server/foundry/company";
import { followUpsDue, publishSample } from "../src/lib/server/foundry/crew";
import { logTouch } from "../src/lib/server/foundry/leads";
import { spawned } from "./helpers/company";
import { NOW, run } from "./helpers/fixtures";

async function funded(leads = 2) {
  const s = await spawned(leads);
  await run(fund, s.ctx, { company_id: s.companyId, reason: "go" });
  return s;
}

const publish = (companyId: string, leadId: string, html = "<p>sample</p>") => ({
  company_id: companyId,
  lead_id: leadId,
  agent_name: "co-01-builder",
  html,
});

test("publish_sample deploys every page, records the sample, and hands the lead to Outreach once", async () => {
  const { naive, ctx, companyId, leadIds } = await funded();
  const app = naive.apps[0];

  const first = await run(publishSample, ctx, publish(companyId, leadIds[0], "<p>A</p>"));
  assert.deepEqual(first, { lead_id: leadIds[0], sample_url: `${app.url}/${leadIds[0]}`, handed_to: "co-01-outreach" });
  await run(publishSample, ctx, publish(companyId, leadIds[1], "<p>B</p>"));
  await run(publishSample, ctx, publish(companyId, leadIds[0], "<p>A2</p>"));

  const files = naive.deploys.at(-1)!.files;
  assert.deepEqual(Object.keys(files).sort(), ["index.html", `${leadIds[0]}/index.html`, `${leadIds[1]}/index.html`].sort());
  assert.equal(files[`${leadIds[0]}/index.html`], "<p>A2</p>");
  const outreachCards = naive.cards.filter((c) => c.assignee === "co-01-outreach");
  assert.equal(outreachCards.length, 2);
  assert.deepEqual(JSON.parse(outreachCards[0].body).sample_url, `${app.url}/${leadIds[0]}`);

  const [lead] = await ctx.db.query<{ sample_url: string; status: string }>("select sample_url, status from leads where id = $1", [leadIds[0]]);
  assert.deepEqual(lead, { sample_url: `${app.url}/${leadIds[0]}`, status: "assigned" });
  const touches = await ctx.db.query("select agent_name, channel, kind from touches where lead_id = $1", [leadIds[0]]);
  assert.equal(touches.length, 2);
  assert.deepEqual(touches[0], { agent_name: "co-01-builder", channel: "contact_form", kind: "sample_delivered" });
});

test("publish_sample doesn't hand a contacted lead to Outreach again", async () => {
  const { naive, ctx, companyId, leadIds } = await funded(1);
  await ctx.db.query("update leads set status = 'contacted' where id = $1", [leadIds[0]]);
  const out = (await run(publishSample, ctx, publish(companyId, leadIds[0]))) as { handed_to: string | null };
  assert.equal(out.handed_to, null);
  assert.equal(naive.cards.filter((c) => c.assignee === "co-01-outreach").length, 0);
});

test("publish_sample refuses a lead from another company, an unfunded company, and a killed one", async () => {
  const { ctx, companyId, leadIds } = await spawned(1);
  await assert.rejects(run(publishSample, ctx, publish(companyId, leadIds[0])), { code: "conflict", message: /proposed/ });
  await run(fund, ctx, { company_id: companyId, reason: "go" });
  await assert.rejects(run(publishSample, ctx, publish(companyId, "ld_other")), { code: "not_found" });
  await run(kill, ctx, { company_id: companyId, reason: "stop" });
  await assert.rejects(run(publishSample, ctx, publish(companyId, leadIds[0])), { code: "killed" });
});

test("follow_ups_due returns leads sent once at least 20 hours ago that haven't replied", async () => {
  const { ctx, companyId, leadIds } = await funded(4);
  const sent = (leadId: string, hoursAgo: number) =>
    ctx.db.query("insert into touches (id, company_id, lead_id, agent_name, channel, kind, at) values ($1, $2, $3, 'co-01-outreach', 'contact_form', 'sent', $4)", [
      `tc_${leadId}_${hoursAgo}`,
      companyId,
      leadId,
      new Date(NOW.getTime() - hoursAgo * 3_600_000),
    ]);
  for (const id of leadIds) await ctx.db.query("update leads set status = 'contacted' where id = $1", [id]);
  await sent(leadIds[0], 21);
  await sent(leadIds[1], 19);
  await sent(leadIds[2], 30);
  await sent(leadIds[2], 5);
  await sent(leadIds[3], 25);
  await run(logTouch, ctx, { company_id: companyId, lead_id: leadIds[3], agent_name: "co-01-closer", channel: "email", kind: "reply_received" });

  const out = (await run(followUpsDue, ctx, { company_id: companyId })) as { leads: { id: string; sent_at: string }[] };
  assert.deepEqual(out.leads.map((l) => l.id), [leadIds[0]]);
  assert.equal(out.leads[0].sent_at, new Date(NOW.getTime() - 21 * 3_600_000).toISOString());
});
