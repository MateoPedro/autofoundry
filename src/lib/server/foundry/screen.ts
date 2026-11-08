import { z } from "zod";
import { newId } from "../ids";
import { parseScreenReply, SCREEN_MAX_IDEAS, screenRequest, validateIdeaScreen, type ScreenCandidate, type ScreenReply } from "../screen";
import { cycleStart } from "./cycle";
import { defineTool, ToolError } from "./tool";

// One model call for the quick idea screen. The route backs it with Naïve's model proxy.
export type ScreenModel = {
  messages(body: ReturnType<typeof screenRequest>): Promise<ScreenReply>;
  billedMicroUsd?(replyId: string): Promise<number | null>;
};

const STALE_START_MS = 15 * 60_000; // a started screen older than this is treated as abandoned

type Row = Record<string, unknown>;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// What the screen sees for a cluster: its label and source, plus the buyer, signal and revenue
// hypothesis Scout recorded on its newest lead. No contacts, URLs or names of people.
function candidate(pick: number, c: { label: string; source: string }, data: Row | undefined): ScreenCandidate {
  const d = data ?? {};
  const evidence = Array.isArray(d.evidence) ? (d.evidence[0] as Row | undefined) : undefined;
  const issues = Array.isArray(d.issues) ? d.issues : [];
  const r = d.revenue && typeof d.revenue === "object" ? (d.revenue as Row) : null;
  return {
    pick, buyer: str(d.buyer_type, 20) || "unknown", pipeline: c.source.slice(0, 40), title: c.label.slice(0, 220),
    signal: str(evidence?.observation, 140) || str(issues[0], 140) || str(d.signal_type, 40) || "no signal recorded",
    revenue_hypothesis: r && typeof r.price_usd === "number" ? { payer: str(r.payer, 70), offer: str(r.offer, 150), model: str(r.model, 20),
      price_usd: r.price_usd, channel_ready: r.channel_ready === true } : null,
  };
}

export const screenBatch = defineTool({
  name: "screen_batch",
  description:
    "Screener only. Quick Compliance screen of the latest Scout batch: the pending clusters that got leads since the last screen (up to 20). One model call under rules/idea-screen.md approves 8–12 experiments for Creator, rejects only obvious illegality or clear impossibility, and leaves lower-priority ideas pending. Call it once per run; it refuses while another screen is running.",
  input: z.object({ window_hours: z.number().int().min(1).max(24).default(3) }),
  async run(ctx, { window_hours }) {
    if (!ctx.screenModel || !ctx.screenRules) throw new ToolError("policy", "the idea screen is not configured on the foundry app (needs a Naïve key with proxy:write)");
    const now = ctx.now();
    const id = newId("sc");
    const start = await ctx.db.tx(async (db) => {
      await db.query("lock table screens in share row exclusive mode");
      const [running] = await db.query<{ id: string }>("select id from screens where status = 'started' and created_at > $1", [new Date(now.getTime() - STALE_START_MS)]);
      if (running) throw new ToolError("conflict", `screen ${running.id} is still running`);
      // The cycle trigger and the fallback cron may both fire; screen each Scout cycle once.
      const [done] = await db.query<{ id: string }>("select id from screens where status = 'done' and created_at >= $1 limit 1", [cycleStart(now)]);
      if (done) return { already: done.id };
      const [last] = await db.query<{ cutoff: Date }>("select cutoff from screens where status = 'done' order by created_at desc limit 1");
      const since = last ? new Date(last.cutoff) : new Date(now.getTime() - window_hours * 3_600_000);
      await db.query("insert into screens (id, since, cutoff, created_at) values ($1, $2, $3, $3)", [id, since, now]);
      return { since };
    });
    if ("already" in start) return { screen_id: start.already, already_screened: true, approved: [], rejected: [], kept_pending: 0 };

    const finish = (status: "done" | "failed", fields: Record<string, unknown>) =>
      ctx.db.query(
        `update screens set status = $2, candidate_count = $3, model = $4, provider_request_id = $5, billed_micro_usd = $6, error = $7, result = $8, finished_at = $9 where id = $1`,
        [id, status, fields.candidate_count ?? 0, fields.model ?? null, fields.provider_request_id ?? null, fields.billed ?? null, fields.error ?? null, fields.result ?? null, ctx.now()],
      );

    const clusters = await ctx.db.query<{ id: string; label: string; source: string }>(
      `select c.id, c.label, c.source from clusters c
       where c.review_status = 'pending' and exists (select 1 from leads l where l.cluster_id = c.id and l.created_at > $1)
       order by c.unserved_score desc, c.signal_count desc, c.created_at, c.id limit $2`,
      [start.since, SCREEN_MAX_IDEAS],
    );
    if (!clusters.length) {
      await finish("done", { result: { selected: [], excluded: [] } });
      return { screen_id: id, since: start.since.toISOString(), candidates: 0, approved: [], rejected: [], kept_pending: 0, shortfall: 0 };
    }
    const candidates = await Promise.all(clusters.map(async (c, i) => {
      const [lead] = await ctx.db.query<{ data: Row }>("select data from leads where cluster_id = $1 order by created_at desc, id limit 1", [c.id]);
      return candidate(i + 1, c, lead?.data);
    }));

    let reply: ScreenReply;
    let screened: ReturnType<typeof validateIdeaScreen<ScreenCandidate>>;
    try {
      const body = screenRequest(await ctx.screenRules(), candidates);
      reply = await ctx.screenModel.messages(body);
      screened = validateIdeaScreen(parseScreenReply(reply), candidates);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "unknown";
      await finish("failed", { candidate_count: candidates.length, error: message });
      // The batch stays pending; the next screen starts from the last finished cutoff and retries it.
      throw new ToolError("naive_error", `idea screen failed: ${message}; nothing was approved or rejected, not retried`);
    }

    const approved: { cluster_id: string; label: string; reason: string }[] = [];
    const rejected: { cluster_id: string; label: string; category: string; reason: string }[] = [];
    await ctx.db.tx(async (db) => {
      const decide = async (clusterId: string, decision: "approve" | "reject", reason: string) => {
        const [row] = await db.query<{ review_status: string }>("select review_status from clusters where id = $1 for update", [clusterId]);
        if (row?.review_status !== "pending") return false; // reviewed meanwhile; leave it
        await db.query("update clusters set review_status = $2, review_reason = $3, updated_at = now() where id = $1", [clusterId, decision === "approve" ? "approved" : "rejected", reason]);
        await db.query("insert into decisions (id, agent, kind, cluster_id, reason) values ($1, 'compliance', $2, $3, $4)", [newId("dc"), decision, clusterId, reason]);
        return true;
      };
      for (const s of screened.selected) {
        const c = clusters[s.pick - 1];
        const reason = `Idea screen #${s.rank}: ${s.reason} First test: ${s.experiment}`.slice(0, 500);
        if (await decide(c.id, "approve", reason)) approved.push({ cluster_id: c.id, label: c.label, reason: s.reason });
      }
      for (const s of screened.excluded) {
        if (s.category === "lower_priority") continue; // stays pending as backlog
        const c = clusters[s.pick - 1];
        if (await decide(c.id, "reject", `Idea screen: ${s.category}: ${s.reason}`.slice(0, 500))) rejected.push({ cluster_id: c.id, label: c.label, category: s.category, reason: s.reason });
      }
    });

    let billed: number | null = null;
    try { billed = (await ctx.screenModel.billedMicroUsd?.(reply.id)) ?? null; } catch { /* some keys can't read billing traces; never invent a charge */ }
    const keptPending = screened.excluded.filter((s) => s.category === "lower_priority").length;
    await finish("done", { candidate_count: candidates.length, model: reply.model, provider_request_id: reply.id, billed,
      result: { selected: screened.selected.map((s) => ({ cluster_id: clusters[s.pick - 1].id, rank: s.rank, reason: s.reason, experiment: s.experiment, risks: s.risks })),
        excluded: screened.excluded.map((s) => ({ cluster_id: clusters[s.pick - 1].id, category: s.category, reason: s.reason })) } });
    return { screen_id: id, since: start.since.toISOString(), candidates: candidates.length, approved, rejected, kept_pending: keptPending,
      shortfall: screened.shortfall, billed_micro_usd: billed };
  },
});
