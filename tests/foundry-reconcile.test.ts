import assert from "node:assert/strict";
import test from "node:test";
import { cycleStart, READY_AFTER_MINUTES, recordScoutIdle } from "../src/lib/server/foundry/cycle";
import { dismissInbound, logTouch } from "../src/lib/server/foundry/leads";
import { readInbound, reconcile } from "../src/lib/server/foundry/reconcile";
import { setRunning } from "../src/lib/server/foundry/state";
import { funded, proposed } from "./helpers/company";
import { crewContext } from "./helpers/crew";
import { NOW, run, seedCluster, seedLead } from "./helpers/fixtures";

const hours = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const titles = (s: { naive: { cards: { title: string }[] } }) => s.naive.cards.map((c) => c.title);

// A funded company whose Outreach cards were lost, so the sweep has to hand them out again.
async function lostCards(leads = 2) {
  const s = await funded(leads);
  s.naive.cards = [];
  await s.ctx.db.query("delete from work_cards");
  return s;
}

const sent = (s: Awaited<ReturnType<typeof funded>>, leadId: string, at: Date, detail = "first") =>
  s.ctx.db.query("insert into touches (id, company_id, lead_id, agent_name, channel, kind, detail, at) values ($1, $2, $3, 'outreach', 'contact_form', 'sent', $4, $5)", [
    `tc_${Math.random()}`,
    s.companyId,
    leadId,
    detail,
    at,
  ]);

test("design: queued clusters get Creator cards up to the free slots", async () => {
  const ctx = await crewContext();
  await ctx.db.query("update funding_policy set max_proposed = 3");
  for (let i = 0; i < 4; i++) await seedLead(ctx.db, await seedCluster(ctx.db, `queued ${i}`), { name: `free ${i}` });
  const out = await reconcile(ctx);
  assert.equal(out.created.design, 3);
});

test("screen: a cycle 90 minutes old with Scout pings but no screen wakes Compliance", async () => {
  const ctx = await crewContext();
  const start = cycleStart(NOW);
  await recordScoutIdle({ ...ctx, now: () => start }, start);
  const early = await reconcile({ ...ctx, now: () => new Date(start.getTime() + (READY_AFTER_MINUTES - 1) * 60_000) });
  assert.equal(early.created.screen, 0);
  const late = await reconcile({ ...ctx, now: () => new Date(start.getTime() + READY_AFTER_MINUTES * 60_000) });
  assert.equal(late.created.screen, 1);
  assert.ok(ctx.naive.cards.some((c) => c.title === `Screen Scout batch ${start.toISOString()}`));
});

test("contact: a funded company's sampled leads with no first message get Outreach cards", async () => {
  const s = await lostCards(2);
  await sent(s, s.leadIds[0], hours(1));
  const out = await reconcile(s.ctx);
  assert.equal(out.created.contact, 1);
  assert.ok(titles(s).includes(`Contact ${s.leadIds[1]} for ${s.companyId}`));
});

test("a lead due a follow-up twenty hours after its first email gets one follow-up card", async () => {
  const s = await lostCards(2);
  await s.ctx.db.query("update offers set follow_up_message = 'Following up: {{sample_url}}'");
  await s.ctx.db.query("update leads set status = 'contacted' where company_id = $1", [s.companyId]);
  await sent(s, s.leadIds[0], hours(20));
  await sent(s, s.leadIds[1], hours(19));
  const out = await reconcile(s.ctx);
  assert.equal(out.created.followUp, 1);
  assert.deepEqual(titles(s).filter((t) => t.startsWith("Follow up")), [`Follow up ${s.leadIds[0]} for ${s.companyId}`]);
});

test("followUp: no follow-up after a second message, a reply, or when the offer has none", async () => {
  const s = await lostCards(3);
  await s.ctx.db.query("update leads set status = 'contacted' where company_id = $1", [s.companyId]);
  for (const id of s.leadIds) await sent(s, id, hours(30));
  assert.equal((await reconcile(s.ctx)).created.followUp, 0, "the offer has no follow-up");
  await s.ctx.db.query("update offers set follow_up_message = 'Following up: {{sample_url}}'");
  await sent(s, s.leadIds[0], hours(5), "follow-up");
  await s.ctx.db.query("update leads set status = 'replied' where id = $1", [s.leadIds[1]]);
  await reconcile(s.ctx);
  assert.deepEqual(titles(s).filter((t) => t.startsWith("Follow up")), [`Follow up ${s.leadIds[2]} for ${s.companyId}`]);
});

test("deliver: a paid lead with no delivery gets a Deliver card", async () => {
  const s = await lostCards(1);
  await s.ctx.db.query("insert into payments (id, company_id, lead_id, amount_cents, source, external_ref, livemode) values ('py_1', $1, $2, 9900, 'stripe', 'cs_1', true)", [
    s.companyId,
    s.leadIds[0],
  ]);
  await sent(s, s.leadIds[0], hours(2));
  assert.equal((await reconcile(s.ctx)).created.deliver, 1);
  assert.ok(titles(s).includes(`Deliver ${s.leadIds[0]} for ${s.companyId}`));
});

test("inbound: an unanswered email older than ten minutes gets a Closer card", async () => {
  const s = await funded(1);
  s.naive.addInbound({ id: "inb_old", from: "dr@example.com", subject: "Re: sample", text: "Looks good", received_at: new Date(NOW.getTime() - 11 * 60_000).toISOString() });
  s.naive.addInbound({ id: "inb_new", from: "x@example.com", subject: "Hi", text: "Hi", received_at: new Date(NOW.getTime() - 5 * 60_000).toISOString() });
  s.naive.addInbound({ id: "inb_auto", from: "noreply@example.com", subject: "Out of office", text: "Away", received_at: hours(1).toISOString(), guard_reason: "auto_reply" });
  s.naive.addInbound({ id: "inb_ancient", from: "y@example.com", subject: "Old", text: "Old", received_at: hours(80).toISOString() });
  const out = await reconcile(s.ctx);
  assert.equal(out.created.inbound, 1);
  assert.ok(titles(s).includes("Answer email inb_old from dr@example.com"));
});

test("a dismissed or answered email is never handed out again", async () => {
  const s = await funded(1);
  const at = hours(1).toISOString();
  s.naive.addInbound({ id: "inb_spam", from: "spam@example.com", subject: "Win", text: "Win", received_at: at });
  s.naive.addInbound({ id: "inb_reply", from: "dr@example.com", subject: "Re", text: "Yes", received_at: at });
  await run(dismissInbound, s.ctx, { message_id: "inb_spam", reason: "spam" });
  await run(logTouch, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0], agent_name: "closer", channel: "email", kind: "reply_received", message_id: "inb_reply" });
  assert.equal((await reconcile(s.ctx)).created.inbound, 0);
});

test("a second sweep creates nothing new", async () => {
  const s = await lostCards(2);
  s.naive.addInbound({ id: "inb_1", from: "dr@example.com", subject: "Re", text: "Yes", received_at: hours(1).toISOString() });
  const first = await reconcile(s.ctx);
  assert.ok(Object.values(first.created).some((n) => n > 0));
  const cards = s.naive.cards.length;
  const second = await reconcile(s.ctx);
  assert.ok(Object.values(second.created).every((n) => n === 0));
  assert.equal(s.naive.cards.length, cards);
});

test("the sweep does nothing while stopped", async () => {
  const s = await lostCards(2);
  await setRunning(s.ctx.db, false, NOW);
  const out = await reconcile(s.ctx);
  assert.equal(out.stopped, true);
  assert.ok(Object.values(out.created).every((n) => n === 0));
  assert.equal(s.naive.cards.length, 0);
});

test("a proposed company's leads get no Outreach cards", async () => {
  const s = await proposed(2);
  assert.equal((await reconcile(s.ctx)).created.contact, 0);
});

test("read_inbound gives the Closer the email a sweep card names", async () => {
  const s = await funded(1);
  s.naive.addInbound({ id: "inb_9", from: "dr@example.com", subject: "Price?", text: "How much on our domain?", received_at: hours(1).toISOString() });
  assert.deepEqual(await run(readInbound, s.ctx, { message_id: "inb_9" }), {
    id: "inb_9",
    from: "dr@example.com",
    subject: "Price?",
    text: "How much on our domain?",
    received_at: hours(1).toISOString(),
  });
  await assert.rejects(run(readInbound, s.ctx, { message_id: "inb_missing" }), { code: "not_found" });
});
