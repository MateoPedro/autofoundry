import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cycleStart, onScoutIdle, type CycleNaive } from "../src/lib/server/foundry/cycle";
import { proposeOffer } from "../src/lib/server/foundry/review";
import { screenBatch, type ScreenModel } from "../src/lib/server/foundry/screen";
import type { ToolContext } from "../src/lib/server/foundry/tool";
import { loadCompliance } from "../scripts/compliance-config";
import { NOW, run, seedCluster, seedLead, testContext } from "./helpers/fixtures";

const rules = () => readFile("rules/idea-screen.md", "utf8");
const lead = (buyer: string) => ({ buyer_type: buyer, evidence: [{ url: "https://example.com", observation: "Asked publicly for an app like this." }],
  revenue: { payer: "consumers", offer: "small web app", model: "monthly", price_usd: 4, channel_ready: false } });

// A model that returns a fixed screen and records what it was sent.
function model(reply: (n: number) => unknown, sent: unknown[] = []): ScreenModel {
  return {
    messages: async (body) => {
      sent.push(body);
      const n = (body.messages[0].content.match(/Screen these (\d+) ideas/) ?? [])[1];
      return { id: "pc_fixture", model: "google/gemma-4-31B-it", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply(Number(n))) }] };
    },
    billedMicroUsd: async () => 900,
  };
}
const pickAll = (n: number, approve: number, hard: number[] = []) => ({
  selected: Array.from({ length: approve }, (_, i) => ({ pick: i + 1, reason: "Clear ask.", experiment: "Build a tiny prototype.", risks: [] })),
  excluded: Array.from({ length: n - approve }, (_, i) => approve + i + 1).map((pick) => hard.includes(pick)
    ? { pick, category: "obvious_illegal" as const, reason: "Scraping private data." }
    : { pick, category: "lower_priority" as const, reason: "Weaker signal." }),
});

async function batch(ctx: ToolContext, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = await seedCluster(ctx.db, `idea ${i}`, "pending");
    await ctx.db.query("update clusters set unserved_score = $2 where id = $1", [id, 1 - i / 100]);
    const leadId = await seedLead(ctx.db, id, { name: `lead ${i}` });
    await ctx.db.query("update leads set data = $2, created_at = $3 where id = $1", [leadId, lead("consumer"), new Date(NOW.getTime() - 30 * 60_000)]);
    ids.push(id);
  }
  return ids;
}

test("screen_batch approves the picks for Creator, rejects only hard blockers and keeps the rest pending", async () => {
  const sent: { messages: { content: string }[] }[] = [];
  const ctx = await testContext({ screenModel: model((n) => pickAll(n, 10, [12]), sent as never), screenRules: rules });
  const ids = await batch(ctx, 14);
  const out = (await run(screenBatch, ctx, {})) as { candidates: number; approved: unknown[]; rejected: { category: string }[]; kept_pending: number; billed_micro_usd: number };
  assert.equal(out.candidates, 14);
  assert.equal(out.approved.length, 10);
  assert.deepEqual(out.rejected.map((r) => r.category), ["obvious_illegal"]);
  assert.equal(out.kept_pending, 3);
  assert.equal(out.billed_micro_usd, 900);
  const statuses = await ctx.db.query<{ id: string; review_status: string }>("select id, review_status from clusters");
  const by = Object.fromEntries(statuses.map((s) => [s.id, s.review_status]));
  assert.equal(by[ids[0]], "approved");
  assert.equal(by[ids[11]], "rejected");
  assert.equal(by[ids[13]], "pending");
  const decisions = await ctx.db.query<{ n: number }>("select count(*)::int as n from decisions where agent = 'compliance'");
  assert.equal(decisions[0].n, 11);
  // The model sees summaries only: no contact routes or lead names.
  assert.doesNotMatch(sent[0].messages[0].content, /lead 0|contact_url|example\.com/);
});

test("screen_batch screens each cycle once and leaves the batch pending when the model reply is unusable", async () => {
  const ctx = await testContext({ screenModel: model(() => ({ selected: [] })), screenRules: rules });
  await batch(ctx, 10);
  await assert.rejects(run(screenBatch, ctx, {}), /idea screen failed/);
  assert.equal((await ctx.db.query("select 1 from clusters where review_status <> 'pending'")).length, 0);
  const [failed] = await ctx.db.query<{ status: string }>("select status from screens");
  assert.equal(failed.status, "failed");

  const ok = await testContext({ screenModel: model((n) => pickAll(n, 8)), screenRules: rules });
  await batch(ok, 9);
  await run(screenBatch, ok, {});
  const again = (await run(screenBatch, ok, {})) as { already_screened?: boolean };
  assert.equal(again.already_screened, true);
});

test("screen_batch refuses without a configured model", async () => {
  const ctx = await testContext();
  await assert.rejects(run(screenBatch, ctx, {}), /not configured/);
});

test("the cycle trigger waits for all 8 Scout runs, then starts one Compliance screen", async () => {
  const ctx = await testContext();
  const started: string[] = [];
  const at = cycleStart(NOW).toISOString();
  let sessions = Array.from({ length: 8 }, (_, i) => ({ id: `ses_${i}`, status: i < 7 ? "idle" : "running", created_at: at }));
  const naive: CycleNaive = { scoutSessionsSince: async () => sessions, startComplianceScreen: async (key) => { started.push(key); return { id: "ses_screen" }; } };
  assert.equal((await onScoutIdle(ctx.db, naive, NOW)).started, false);
  sessions = sessions.map((s) => ({ ...s, status: "idle" }));
  assert.deepEqual(await onScoutIdle(ctx.db, naive, NOW), { cycle_start: at, started: true, session_id: "ses_screen" });
  assert.equal((await onScoutIdle(ctx.db, naive, NOW)).started, false, "a later idle event in the same cycle does not start another");
  assert.deepEqual(started, [`screen-${at}`]);
});

test("a failed Compliance start releases the cycle so the next idle event retries", async () => {
  const ctx = await testContext();
  const at = cycleStart(NOW).toISOString();
  const sessions = Array.from({ length: 8 }, (_, i) => ({ id: `ses_${i}`, status: "idle", created_at: at }));
  let fail = true;
  const naive: CycleNaive = { scoutSessionsSince: async () => sessions,
    startComplianceScreen: async () => { if (fail) throw new Error("rate limited"); return { id: "ses_screen" }; } };
  await assert.rejects(onScoutIdle(ctx.db, naive, NOW), /rate limited/);
  fail = false;
  assert.equal((await onScoutIdle(ctx.db, naive, NOW)).started, true);
});

test("offers are approved on submission so Creator can spawn", async () => {
  const ctx = await testContext();
  const clusterId = await seedCluster(ctx.db, "approved idea", "approved");
  const out = (await run(proposeOffer, ctx, { cluster_id: clusterId, buyer: "SF dentists", sample: "a rebuilt site", product: "the site on your domain",
    price_cents: 9900, channel: "contact_form", outreach_message: "Hi {{lead_name}}, I'm an AI agent: {{sample_url}}", delivery: "a link by email" })) as { review_status: string };
  assert.equal(out.review_status, "approved");
  const [decision] = await ctx.db.query<{ kind: string }>("select kind from decisions where offer_id is not null");
  assert.equal(decision.kind, "approve");
});

test("Compliance in screen mode can only call screen_batch", async () => {
  const screen = await loadCompliance("screen");
  assert.deepEqual(Object.keys(screen.tools!.configs!).sort(), ["apps", "foundry.screen_batch"]);
  assert.equal(screen.tools!.default_config.permission, "deny");
  assert.equal(screen.structured_output_required, false);
});
