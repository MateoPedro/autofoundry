import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../src/lib/server/db";
import { compactFeedback, feedbackContext, NOTES_BEFORE_COMPACT, scoutMemory, writeFeedback } from "../src/lib/server/foundry/feedback";
import type { ToolContext } from "../src/lib/server/foundry/tool";
import { newId } from "../src/lib/server/ids";
import { run, seedCompany, seedLead, testContext } from "./helpers/fixtures";

type Context = {
  memory: { live_notes: number; compact_needed: boolean };
  decisions: { decision_id: string; kind: string; company: { slug: string; funnel: Record<string, number>; leads_by: Record<string, Record<string, number>>; failed_touches: number } | null }[];
  more: boolean;
};

let minute = 0;
async function decide(db: Db, agent: string, kind: string, companyId: string | null, reason = "reason") {
  const id = newId("dc");
  await db.query("insert into decisions (id, agent, kind, company_id, reason, at) values ($1, $2, $3, $4, $5, $6)", [
    id,
    agent,
    kind,
    companyId,
    reason,
    new Date(Date.UTC(2026, 10, 8, 0, minute++)),
  ]);
  return id;
}

async function fillNotes(ctx: ToolContext, companyId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const id = await decide(ctx.db, "vc", "hold", companyId);
    await run(writeFeedback, ctx, { note: `note ${i}`, through_decision_id: id });
  }
}

test("feedback_context shows VC decisions with the company's cluster, funnel and lead mix, and skips other agents", async () => {
  const ctx = await testContext();
  const { companyId, clusterId } = await seedCompany(ctx.db, { slug: "co-01" });
  for (const signal of ["inferred_gap", "inferred_gap", "explicit_request"]) {
    const lead = await seedLead(ctx.db, clusterId, { companyId, status: "contacted" });
    await ctx.db.query("update leads set data = $2 where id = $1", [lead, { buyer_type: "business", signal_type: signal, channel: "contact_form" }]);
  }
  await decide(ctx.db, "creator", "spawn", companyId);
  const kill = await decide(ctx.db, "vc", "kill", companyId, "3 contacted, 0 replies in 26h");

  const out = (await run(feedbackContext, ctx, {})) as Context;
  assert.deepEqual(out.decisions.map((d) => d.decision_id), [kill]);
  const company = out.decisions[0].company!;
  assert.equal(company.slug, "co-01");
  assert.deepEqual(company.funnel, { leads: 3, contacted: 3, replied: 0, paid: 0 });
  assert.deepEqual(company.leads_by.signal_type, { inferred_gap: 2, explicit_request: 1 });
  assert.deepEqual(out.memory, { live_notes: 0, has_summary: false, compact_needed: false });
});

test("a note moves the cursor, and a retry returns the same note", async () => {
  const ctx = await testContext();
  const { companyId } = await seedCompany(ctx.db);
  const first = await decide(ctx.db, "vc", "fund", companyId);
  const second = await decide(ctx.db, "vc", "kill", companyId);

  const page = (await run(feedbackContext, ctx, { limit: 1 })) as Context;
  assert.deepEqual(page.decisions.map((d) => d.decision_id), [first]);
  assert.equal(page.more, true);

  const note = (await run(writeFeedback, ctx, { note: "FUND maps/dentists", through_decision_id: first })) as { note_id: string; live_notes: number };
  assert.equal(note.live_notes, 1);
  assert.deepEqual(await run(writeFeedback, ctx, { note: "again", through_decision_id: first }), { ...note, has_summary: false, compact_needed: false });

  const next = (await run(feedbackContext, ctx, {})) as Context;
  assert.deepEqual(next.decisions.map((d) => d.decision_id), [second]);
  await run(writeFeedback, ctx, { note: "KILL", through_decision_id: second });
  await assert.rejects(run(writeFeedback, ctx, { note: "x", through_decision_id: newId("dc") }), /no decision/);
});

test("write_feedback refuses decisions that aren't VC's or that notes already cover", async () => {
  const ctx = await testContext();
  const { companyId } = await seedCompany(ctx.db);
  const spawn = await decide(ctx.db, "creator", "spawn", companyId);
  const older = await decide(ctx.db, "vc", "fund", companyId);
  const newer = await decide(ctx.db, "vc", "kill", companyId);
  await assert.rejects(run(writeFeedback, ctx, { note: "x", through_decision_id: spawn }), /not a VC decision/);
  await run(writeFeedback, ctx, { note: "x", through_decision_id: newer });
  await assert.rejects(run(writeFeedback, ctx, { note: "x", through_decision_id: older }), /already cover/);
  assert.equal(((await run(feedbackContext, ctx, {})) as Context).decisions.length, 0);
});

test(`the ${NOTES_BEFORE_COMPACT}th note asks for compaction, the next is refused, and compacting leaves one summary`, async () => {
  const ctx = await testContext();
  const { companyId } = await seedCompany(ctx.db);
  await fillNotes(ctx, companyId, NOTES_BEFORE_COMPACT);

  const memory = (await run(scoutMemory, ctx, {})) as { notes: { id: string; body: string }[]; compact_needed: boolean };
  assert.equal(memory.notes.length, NOTES_BEFORE_COMPACT);
  assert.equal(memory.notes[0].body, "note 0");
  assert.equal(memory.compact_needed, true);

  const blocked = await decide(ctx.db, "vc", "kill", companyId);
  await assert.rejects(run(writeFeedback, ctx, { note: "11th", through_decision_id: blocked }), /compact_feedback/);
  await assert.rejects(run(compactFeedback, ctx, { summary: "s", note_ids: memory.notes.slice(1).map((n) => n.id) }), /aren't the live notes/);

  const ids = memory.notes.map((n) => n.id);
  const done = (await run(compactFeedback, ctx, { summary: "maps gaps: 10 holds, nothing funded", note_ids: ids })) as { folded: number; live_notes: number };
  assert.equal(done.folded, NOTES_BEFORE_COMPACT);
  assert.equal(done.live_notes, 0);

  // The cursor survives compaction: the 11th decision is still the next to report, then it can be written.
  const next = (await run(feedbackContext, ctx, {})) as Context;
  assert.deepEqual(next.decisions.map((d) => d.decision_id), [blocked]);
  await run(writeFeedback, ctx, { note: "11th", through_decision_id: blocked });
  const after = (await run(scoutMemory, ctx, {})) as { summary: { body: string }; notes: { body: string }[] };
  assert.equal(after.summary.body, "maps gaps: 10 holds, nothing funded");
  assert.deepEqual(after.notes.map((n) => n.body), ["11th"]);

  // A second compaction folds the old summary in too, so only one summary is ever live.
  await fillNotes(ctx, companyId, NOTES_BEFORE_COMPACT - 1);
  const full = (await run(scoutMemory, ctx, {})) as { notes: { id: string }[] };
  const second = (await run(compactFeedback, ctx, { summary: "v2", note_ids: full.notes.map((n) => n.id) })) as { folded: number };
  assert.equal(second.folded, NOTES_BEFORE_COMPACT + 1);
  const [{ n }] = await ctx.db.query<{ n: unknown }>("select count(*) as n from scout_feedback where compacted_into is null");
  assert.equal(Number(n), 1);
});

test("compact_feedback refuses before 10 notes", async () => {
  const ctx = await testContext();
  const { companyId } = await seedCompany(ctx.db);
  await fillNotes(ctx, companyId, 2);
  const memory = (await run(scoutMemory, ctx, {})) as { notes: { id: string }[] };
  await assert.rejects(run(compactFeedback, ctx, { summary: "s", note_ids: memory.notes.map((n) => n.id) }), /only 2 notes/);
});

test("feedback_context counts only live payments as paid leads and revenue", async () => {
  const ctx = await testContext();
  const { companyId, clusterId } = await seedCompany(ctx.db, { slug: "co-01" });
  for (const [id, cents, livemode] of [["py_live", 9900, true], ["py_test", 100, false]] as const) {
    const lead = await seedLead(ctx.db, clusterId, { companyId, status: "paid" });
    await ctx.db.query(
      "insert into payments (id, company_id, lead_id, amount_cents, source, external_ref, livemode) values ($1, $2, $3, $4, 'stripe', $1, $5)",
      [id, companyId, lead, cents, livemode],
    );
  }
  await decide(ctx.db, "vc", "fund", companyId);

  const company = ((await run(feedbackContext, ctx, {})) as Context).decisions[0].company as unknown as { funnel: Record<string, number>; revenue_cents: number };
  assert.deepEqual(company.funnel, { leads: 2, contacted: 2, replied: 2, paid: 1 });
  assert.equal(company.revenue_cents, 9900);
});
