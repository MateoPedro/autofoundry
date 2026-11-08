import { z } from "zod";
import { newId } from "../ids";
import { READ_SOURCES, runCost, type MonidRun, type ReadSource } from "../monid";
import { defineTool, ToolError } from "./tool";

// Monid spend across all monid_read calls in one UTC day. MONID_DAILY_CAP_MICRO_USD overrides it.
// Three playbooks use Monid, 8 cycles a day, about 2,300 micro-USD a pass: ~55,000 a day typical.
export const DEFAULT_MONID_DAILY_CAP_MICRO_USD = 500_000; // $0.50
const MAX_ITEMS = 20;
const MAX_TEXT = 300;
const MAX_CHARS = 7_000; // Naïve cuts tool results at 8,000 characters

const BODY: Record<ReadSource, (query: string) => Record<string, unknown>> = {
  reddit: (query) => ({ query, timeframe: "month" }),
  x_search: (query) => ({ query }),
  github_issues: (query) => ({ query, limit: 30, sort: "reactions" }),
  hackernews: (query) => ({ query, tags: "story" }),
};

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : undefined);
const when = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : undefined);
type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((x): x is Row => !!x && typeof x === "object") : []);

// Public posts, issues and stories only, with no author names, handles or profile links.
export function compactItems(source: ReadSource, data: unknown): Row[] {
  const d = (data ?? {}) as Row;
  switch (source) {
    case "reddit":
      return rows(d.posts).filter((p) => !p.nsfw).map((p) => ({
        id: p.id, url: typeof p.permalink === "string" && !p.permalink.startsWith("http") ? `https://www.reddit.com${p.permalink}` : p.permalink,
        subreddit: p.subreddit, title: text(p.title), text: text(p.selftext), score: p.score, comments: p.numComments, created_at: when(p.createdUtc) }));
    case "x_search":
      return rows(d.items).filter((p) => !p.isReply && p.id).map((p) => ({
        id: p.id, url: `https://x.com/i/web/status/${p.id}`, text: text(p.text), likes: p.likeCount, replies: p.replyCount, created_at: when(p.createdUtc) }));
    case "github_issues":
      return rows(d.issues).filter((i) => !i.isPullRequest).map((i) => ({
        id: i.id, url: i.url, repo: i.repo, title: text(i.title), text: text(i.body), comments: i.comments,
        reactions: typeof i.reactions === "object" ? (i.reactions as Row | null)?.total_count : i.reactions, created_at: when(i.createdUtc) }));
    case "hackernews":
      return rows(d.results).map((h) => ({ id: h.id, url: h.permalink, title: text(h.title), points: h.points, comments: h.comments, created_at: when(h.createdUtc) }));
  }
}

function fit(items: Row[]) {
  const out = items.slice(0, MAX_ITEMS);
  while (out.length && JSON.stringify(out).length > MAX_CHARS) out.pop();
  return out;
}

export const monidRead = defineTool({
  name: "monid_read",
  description:
    "Scout only. Search public posts through Monid: reddit, x_search (X posts), github_issues or hackernews. Returns up to 20 compact items without author names. Each call is billed and counted against a daily Monid cap; a failed call is not retried.",
  input: z.object({
    source: z.enum(Object.keys(READ_SOURCES) as [ReadSource, ...ReadSource[]]),
    query: z.string().trim().min(1).max(300),
  }),
  async run(ctx, { source, query }) {
    if (!ctx.monid) throw new ToolError("policy", "Monid is not configured on the foundry app (MONID_API_KEY)");
    const worst = READ_SOURCES[source].maxMicroUsd;
    const cap = ctx.monidDailyCapMicroUsd ?? DEFAULT_MONID_DAILY_CAP_MICRO_USD;
    const id = newId("mr");
    // Reserve the worst case before the billed run, under a lock, so parallel calls can't overspend.
    const spentToday = await ctx.db.tx(async (db) => {
      await db.query("lock table monid_reads in share row exclusive mode");
      const [row] = await db.query<{ spent: string }>(
        "select coalesce(sum(cost_micro_usd), 0) as spent from monid_reads where created_at >= date_trunc('day', $1::timestamptz at time zone 'UTC') at time zone 'UTC'",
        [ctx.now().toISOString()],
      );
      const spent = Number(row.spent);
      if (spent + worst > cap) throw new ToolError("policy", `daily Monid cap reached: ${spent} of ${cap} micro-USD spent today; ${source} costs up to ${worst}`);
      await db.query("insert into monid_reads (id, source, query, cost_micro_usd, created_at) values ($1, $2, $3, $4, $5)", [id, source, query, worst, ctx.now()]);
      return spent;
    });

    let run: MonidRun;
    try {
      run = (await ctx.monid.readSource(source, BODY[source](query))) as MonidRun;
      for (let i = 0; run.status === "RUNNING" && run.runId && i < 10; i++) {
        await (ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(2000);
        run = (await ctx.monid.getRun(run.runId)) as MonidRun;
      }
    } catch (error) {
      // The run may have been billed; keep the worst case on the ledger and never retry.
      await ctx.db.query("update monid_reads set status = 'lost' where id = $1", [id]);
      throw new ToolError("naive_error", `Monid ${source} failed without a usable receipt (${error instanceof Error ? error.message.slice(0, 120) : "unknown"}); not retried`);
    }
    const cost = run.status === "RUNNING" ? worst : runCost(run, worst);
    await ctx.db.query("update monid_reads set run_id = $2, status = $3, cost_micro_usd = $4 where id = $1", [id, run.runId ?? null, run.status ?? "unknown", cost]);
    const http = run.providerResponse?.httpStatus ?? 0;
    const ok = run.status === "COMPLETED" && http >= 200 && http < 300;
    const items = ok ? fit(compactItems(source, run.output?.data)) : [];
    return { source, query, run_id: run.runId ?? null, status: run.status ?? "unknown", http_status: http, cost_micro_usd: cost,
      spent_today_micro_usd: spentToday + cost, daily_cap_micro_usd: cap, items,
      ...(ok ? {} : { note: "The run did not complete with a successful provider response; it is not retried." }) };
  },
});
