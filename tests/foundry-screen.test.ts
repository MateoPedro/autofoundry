import assert from "node:assert/strict";
import test from "node:test";
import { batchReady, cycleStart, recordScoutIdle } from "../src/lib/server/foundry/cycle";
import { proposeOffer } from "../src/lib/server/foundry/review";
import { screenBatch, submitScreen } from "../src/lib/server/foundry/screen";
import type { ToolContext } from "../src/lib/server/foundry/tool";
import { loadCompliance } from "../scripts/compliance-config";
import { NOW, run, seedCluster, seedLead, testContext } from "./helpers/fixtures";

const lead = (buyer: string) => ({ buyer_type: buyer, evidence: [{ url: "https://example.com", observation: "Asked publicly for an app like this." }],
  revenue: { payer: "consumers", offer: "small web app", model: "monthly", price_usd: 4, channel_ready: false } });

const verdicts = (n: number, approve: number, hard: number[] = []) => ({
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
async function scoutDone(ctx: ToolContext) {
  for (let i = 0; i < 8; i++) await recordScoutIdle(ctx.db, NOW);
}

test("screen_batch waits until all 8 Scout runs of the cycle have ended", async () => {
  // 40 minutes into the cycle, before the 90-minute fallback.
  const at = new Date(cycleStart(NOW).getTime() + 40 * 60_000);
  const ctx = await testContext({ now: () => at });
  await batch(ctx, 10);
  for (let i = 0; i < 7; i++) await recordScoutIdle(ctx.db, at);
  const waiting = (await run(screenBatch, ctx, {})) as { ready: boolean; scout_runs_ended: number };
  assert.deepEqual([waiting.ready, waiting.scout_runs_ended], [false, 7]);
  await recordScoutIdle(ctx.db, at);
  assert.equal(((await run(screenBatch, ctx, {})) as { ready: boolean }).ready, true);
});

test("the batch is ready 90 minutes into the cycle even if a Scout run never reports", async () => {
  const ctx = await testContext();
  const start = cycleStart(NOW);
  assert.equal((await batchReady(ctx.db, new Date(start.getTime() + 89 * 60_000))).ready, false);
  assert.equal((await batchReady(ctx.db, new Date(start.getTime() + 90 * 60_000))).ready, true);
});

test("submit_screen approves the picks for Creator, rejects only hard blockers and keeps the rest pending", async () => {
  const ctx = await testContext();
  const ids = await batch(ctx, 14);
  await scoutDone(ctx);
  const opened = (await run(screenBatch, ctx, {})) as { screen_id: string; candidates: number; ideas: string[] };
  assert.equal(opened.candidates, 14);
  assert.match(opened.ideas[0], /^1\. \[consumer\/google_maps\] idea 0 \| signal: Asked publicly/);
  // The agent sees summaries only: no contact routes or lead names.
  assert.doesNotMatch(opened.ideas.join("\n"), /lead 0|example\.com/);
  const out = (await run(submitScreen, ctx, { screen_id: opened.screen_id, ...verdicts(14, 10, [12]) })) as Record<string, unknown>;
  assert.deepEqual(out, { screen_id: opened.screen_id, approved: 10, rejected: 1, kept_pending: 3, shortfall: 0 });
  const by = Object.fromEntries((await ctx.db.query<{ id: string; review_status: string }>("select id, review_status from clusters")).map((s) => [s.id, s.review_status]));
  assert.deepEqual([by[ids[0]], by[ids[11]], by[ids[13]]], ["approved", "rejected", "pending"]);
  const [decisions] = await ctx.db.query<{ n: number }>("select count(*)::int as n from decisions where agent = 'compliance'");
  assert.equal(decisions.n, 11);
  // One screen per cycle: later polls report it as done.
  assert.equal(((await run(screenBatch, ctx, {})) as { already_screened?: boolean }).already_screened, true);
});

test("submit_screen refuses verdicts that skip an idea or underfill the list, and writes nothing", async () => {
  const ctx = await testContext();
  await batch(ctx, 10);
  await scoutDone(ctx);
  const { screen_id } = (await run(screenBatch, ctx, {})) as { screen_id: string };
  await assert.rejects(run(submitScreen, ctx, { screen_id, ...verdicts(9, 8) }), { code: "invalid" });
  await assert.rejects(run(submitScreen, ctx, { screen_id, ...verdicts(10, 5) }), { code: "invalid" });
  assert.equal((await ctx.db.query("select 1 from clusters where review_status <> 'pending'")).length, 0);
  // A corrected submission still goes through, once.
  assert.equal(((await run(submitScreen, ctx, { screen_id, ...verdicts(10, 8) })) as { approved: number }).approved, 8);
  await assert.rejects(run(submitScreen, ctx, { screen_id, ...verdicts(10, 8) }), { code: "conflict" });
});

test("an empty batch closes the cycle with nothing to submit", async () => {
  const ctx = await testContext();
  await scoutDone(ctx);
  assert.equal(((await run(screenBatch, ctx, {})) as { candidates: number }).candidates, 0);
  assert.equal(((await run(screenBatch, ctx, {})) as { already_screened?: boolean }).already_screened, true);
});

test("offers are approved on submission so Creator can spawn", async () => {
  const ctx = await testContext();
  const clusterId = await seedCluster(ctx.db, "approved idea", "approved");
  const out = (await run(proposeOffer, ctx, { cluster_id: clusterId, buyer: "SF dentists", sample: "a rebuilt site", product: "the site on your domain",
    price_cents: 9900, channel: "contact_form", outreach_message: "Hi {{lead_name}}, I'm an AI agent: {{sample_url}}", delivery: "a link by email" })) as { review_status: string };
  assert.equal(out.review_status, "approved");
});

test("Compliance in screen mode can only read the batch and submit verdicts, and carries the idea-screen rules", async () => {
  const screen = await loadCompliance("screen");
  assert.deepEqual(Object.keys(screen.tools!.configs!).sort(), ["apps", "foundry.screen_batch", "foundry.submit_screen"]);
  assert.equal(screen.tools!.default_config.permission, "deny");
  assert.match(String(screen.system), /Quick idea screen/);
});
