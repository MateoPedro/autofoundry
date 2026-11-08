import assert from "node:assert/strict";
import test from "node:test";
import { compactItems, monidRead } from "../src/lib/server/foundry/monid";
import type { MonidReader } from "../src/lib/server/monid";
import { run, testContext } from "./helpers/fixtures";

const completed = (data: unknown, cost = 350) => ({ runId: "run_fixture_0000000001", status: "COMPLETED", providerResponse: { httpStatus: 200 },
  billing: { reportedCost: { value: cost } }, output: { data } });
function reader(result: unknown | (() => unknown), calls: unknown[] = []): MonidReader {
  return {
    readSource: async (name, body) => { calls.push({ name, body }); return typeof result === "function" ? (result as () => unknown)() : result; },
    getRun: async () => completed({ posts: [] }),
  };
}

test("monid_read runs a fixed read source, records the billed cost and returns compact public items", async () => {
  const calls: unknown[] = [];
  const posts = [
    { id: "p1", title: "Is there an app to track chores?", selftext: "x".repeat(500), permalink: "/r/apps/comments/p1", subreddit: "apps", score: 4, createdUtc: 1_762_560_000, author: "someone" },
    { id: "p2", title: "nsfw", permalink: "/r/x/p2", nsfw: true },
  ];
  const ctx = await testContext({ monid: reader(completed({ posts }), calls) });
  const out = (await run(monidRead, ctx, { source: "reddit", query: "\"is there an app\"" })) as Record<string, unknown> & { items: Record<string, unknown>[] };
  assert.deepEqual(calls, [{ name: "reddit", body: { query: "\"is there an app\"", timeframe: "month" } }]);
  assert.equal(out.cost_micro_usd, 350);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].url, "https://www.reddit.com/r/apps/comments/p1");
  assert.equal((out.items[0].text as string).length, 300);
  assert.equal("author" in out.items[0], false);
  const [row] = await ctx.db.query<{ status: string; cost_micro_usd: number; run_id: string }>("select status, cost_micro_usd, run_id from monid_reads");
  assert.deepEqual(row, { status: "COMPLETED", cost_micro_usd: 350, run_id: "run_fixture_0000000001" });
});

test("monid_read refuses before a billed run once the daily cap would be exceeded", async () => {
  const calls: unknown[] = [];
  const ctx = await testContext({ monid: reader(completed({ issues: [] }, 2400), calls), monidDailyCapMicroUsd: 5000 });
  await run(monidRead, ctx, { source: "github_issues", query: "mcp server" });
  await run(monidRead, ctx, { source: "github_issues", query: "mcp support" });
  await assert.rejects(run(monidRead, ctx, { source: "github_issues", query: "agent api" }), /daily Monid cap reached: 4800 of 5000/);
  assert.equal(calls.length, 2);
});

test("a lost Monid response keeps the worst-case cost on the ledger and is not retried", async () => {
  let calls = 0;
  const ctx = await testContext({ monid: reader(() => { calls++; throw new Error("socket hang up"); }) });
  await assert.rejects(run(monidRead, ctx, { source: "hackernews", query: "Ask HN MCP" }), /without a usable receipt/);
  assert.equal(calls, 1);
  const [row] = await ctx.db.query<{ status: string; cost_micro_usd: number }>("select status, cost_micro_usd from monid_reads");
  assert.deepEqual(row, { status: "lost", cost_micro_usd: 1500 });
});

test("a failed provider response returns no items and is reported, not retried", async () => {
  const ctx = await testContext({ monid: reader({ runId: "run_fixture_0000000002", status: "FAILED", providerResponse: { httpStatus: 503 } }) });
  const out = (await run(monidRead, ctx, { source: "x_search", query: "need an app" })) as { items: unknown[]; note?: string; cost_micro_usd: number };
  assert.deepEqual(out.items, []);
  assert.match(out.note!, /not retried/);
  assert.equal(out.cost_micro_usd, 0);
});

test("without MONID_API_KEY the tool refuses with a policy error", async () => {
  const ctx = await testContext();
  await assert.rejects(run(monidRead, ctx, { source: "reddit", query: "x" }), /not configured/);
});

test("compact items drop replies, pull requests and author identity", () => {
  assert.deepEqual(compactItems("x_search", { items: [{ id: "1", text: "is there an app", isReply: true }, { id: "2", text: "wish there was an app", username: "h" }] }).map((i) => i.url),
    ["https://x.com/i/web/status/2"]);
  const issues = compactItems("github_issues", { issues: [{ id: 1, title: "Add MCP server", url: "https://github.com/o/r/issues/1", repo: "o/r", reactions: { total_count: 7 } }, { id: 2, isPullRequest: true }] });
  assert.deepEqual(issues.map((i) => i.reactions), [7]);
});
