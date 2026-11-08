import { z } from "zod";
import { newId } from "../ids";
import { ideaScreenSchema, SCREEN_MAX_IDEAS, validateIdeaScreen, type ScreenCandidate } from "../screen";
import { batchReady, cycleStart } from "./cycle";
import { defineTool, ToolError } from "./tool";
import { fillCreatorQueue } from "./work";

// The quick idea screen, in two calls by the Compliance agent: screen_batch hands it the latest Scout
// batch, it judges the ideas under rules/idea-screen.md, and submit_screen checks the verdicts and
// approves the picks. The app never calls a model itself, so its Naïve key needs no extra scopes.

const STALE_START_MS = 20 * 60_000; // a started screen older than this is treated as abandoned
const MAX_CHARS = 7_000; // Naïve cuts tool results at 8,000 characters

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

// One line per idea, shortened until the whole list fits a tool result.
export function compactIdeas(candidates: ScreenCandidate[]) {
  for (const [title, signal, offer] of [[160, 120, 100], [120, 90, 70], [90, 60, 50], [70, 40, 30]]) {
    const ideas = candidates.map((c) => {
      const r = c.revenue_hypothesis;
      const revenue = r ? `${r.payer.slice(0, 30)} pays $${r.price_usd} ${r.model} for ${r.offer.slice(0, offer)}${r.channel_ready ? "" : " (channel not ready)"}` : "none";
      return `${c.pick}. [${c.buyer}/${c.pipeline}] ${c.title.slice(0, title)} | signal: ${c.signal.slice(0, signal)} | revenue: ${revenue}`;
    });
    if (ideas.join("\n").length <= MAX_CHARS) return ideas;
  }
  throw new ToolError("internal", "the batch does not fit a tool result");
}

export const screenBatch = defineTool({
  name: "screen_batch",
  writes: true,
  description:
    "Compliance only. Start the quick idea screen of the latest Scout batch: the pending clusters that got leads since the last screen (up to 20), one line each. Returns ready: false until every scheduled Scout run of the cycle has ended (or 90 minutes have passed), and already_screened once the cycle is done. Judge the ideas under the idea-screen rules, then call submit_screen with the returned screen_id.",
  input: z.object({ window_hours: z.number().int().min(1).max(24).default(3) }),
  async run(ctx, { window_hours }) {
    const now = ctx.now();
    const cycle = cycleStart(now);
    return ctx.db.tx(async (db) => {
      await db.query("lock table screens in share row exclusive mode");
      const [done] = await db.query<{ id: string }>("select id from screens where status = 'done' and created_at >= $1 limit 1", [cycle]);
      if (done) return { ready: false, already_screened: true, screen_id: done.id };
      const readiness = await batchReady(db, now);
      if (!readiness.ready) return readiness;
      const [running] = await db.query<{ id: string }>("select id from screens where status = 'started' and created_at > $1", [new Date(now.getTime() - STALE_START_MS)]);
      if (running) throw new ToolError("conflict", `screen ${running.id} is waiting for submit_screen`);
      const [last] = await db.query<{ cutoff: Date }>("select cutoff from screens where status = 'done' order by created_at desc limit 1");
      const since = last ? new Date(last.cutoff) : new Date(now.getTime() - window_hours * 3_600_000);

      const clusters = await db.query<{ id: string; label: string; source: string }>(
        `select c.id, c.label, c.source from clusters c
         where c.review_status = 'pending' and exists (select 1 from leads l where l.cluster_id = c.id and l.created_at > $1)
         order by c.unserved_score desc, c.signal_count desc, c.created_at, c.id limit $2`,
        [since, SCREEN_MAX_IDEAS],
      );
      const candidates = await Promise.all(clusters.map(async (c, i) => {
        const [lead] = await db.query<{ data: Row }>("select data from leads where cluster_id = $1 order by created_at desc, id limit 1", [c.id]);
        return candidate(i + 1, c, lead?.data);
      }));
      const id = newId("sc");
      const status = candidates.length ? "started" : "done";
      await db.query(
        "insert into screens (id, since, cutoff, status, candidate_count, result, created_at, finished_at) values ($1, $2, $3, $4, $5, $6, $3, $7)",
        [id, since, now, status, candidates.length, { candidates, cluster_ids: clusters.map((c) => c.id) }, candidates.length ? null : now],
      );
      if (!candidates.length) return { ready: true, screen_id: id, candidates: 0, ideas: [], note: "No new pending ideas this cycle; nothing to submit." };
      return { ready: true, screen_id: id, candidates: candidates.length, ideas: compactIdeas(candidates) };
    });
  },
});

export const submitScreen = defineTool({
  name: "submit_screen",
  writes: true,
  description:
    "Compliance only. Submit the verdicts for a screen_batch: selected (ranked, 8–12 unless clear blockers leave fewer) with pick, reason, experiment and risks; excluded with pick, category (obvious_illegal, clearly_unworkable or lower_priority) and reason. Every pick appears exactly once. Approves the selected clusters for Creator, rejects obvious_illegal and clearly_unworkable ones, and leaves lower_priority ones pending.",
  input: ideaScreenSchema.extend({ screen_id: z.string().min(1) }),
  async run(ctx, { screen_id, selected, excluded }) {
    const result = await ctx.db.tx(async (db) => {
      const [screen] = await db.query<{ status: string; result: { candidates: ScreenCandidate[]; cluster_ids: string[] } }>(
        "select status, result from screens where id = $1 for update", [screen_id]);
      if (!screen) throw new ToolError("not_found", `no screen ${screen_id}`);
      if (screen.status !== "started") throw new ToolError("conflict", `screen ${screen_id} is already ${screen.status}`);
      const { candidates, cluster_ids: ids } = screen.result;
      let screened: ReturnType<typeof validateIdeaScreen<ScreenCandidate>>;
      try {
        screened = validateIdeaScreen({ selected, excluded }, candidates);
      } catch (error) {
        // Nothing is written; the agent may correct and submit once more while the screen is open.
        throw new ToolError("invalid", error instanceof Error ? error.message : "invalid screen");
      }
      const approved: { cluster_id: string; reason: string }[] = [];
      const rejected: { cluster_id: string; category: string; reason: string }[] = [];
      const decide = async (clusterId: string, decision: "approve" | "reject", reason: string) => {
        const [row] = await db.query<{ review_status: string }>("select review_status from clusters where id = $1 for update", [clusterId]);
        if (row?.review_status !== "pending") return false; // reviewed meanwhile; leave it
        await db.query("update clusters set review_status = $2, review_reason = $3, updated_at = now() where id = $1", [clusterId, decision === "approve" ? "approved" : "rejected", reason]);
        await db.query("insert into decisions (id, agent, kind, cluster_id, reason) values ($1, 'compliance', $2, $3, $4)", [newId("dc"), decision, clusterId, reason]);
        return true;
      };
      for (const s of screened.selected) {
        const reason = `Idea screen #${s.rank}: ${s.reason} First test: ${s.experiment}`.slice(0, 500);
        if (await decide(ids[s.pick - 1], "approve", reason)) approved.push({ cluster_id: ids[s.pick - 1], reason: s.reason });
      }
      for (const s of screened.excluded) {
        if (s.category === "lower_priority") continue; // stays pending as backlog
        if (await decide(ids[s.pick - 1], "reject", `Idea screen: ${s.category}: ${s.reason}`.slice(0, 500))) rejected.push({ cluster_id: ids[s.pick - 1], category: s.category, reason: s.reason });
      }
      const keptPending = screened.excluded.filter((s) => s.category === "lower_priority").length;
      await db.query("update screens set status = 'done', finished_at = $2, result = $3 where id = $1", [screen_id, ctx.now(), {
        candidates, cluster_ids: ids,
        selected: screened.selected.map((s) => ({ cluster_id: ids[s.pick - 1], rank: s.rank, reason: s.reason, experiment: s.experiment, risks: s.risks })),
        excluded: screened.excluded.map((s) => ({ cluster_id: ids[s.pick - 1], category: s.category, reason: s.reason })),
      }]);
      return { screen_id, approved: approved.length, rejected: rejected.length, kept_pending: keptPending, shortfall: screened.shortfall };
    });
    // The verdicts are committed; if waking Creator fails, the five-minute sweep hands out the queue.
    const creatorCards = await fillCreatorQueue(ctx).catch((error) => {
      console.error("waking Creator after a screen failed", error);
      return 0;
    });
    return { ...result, creator_cards: creatorCards };
  },
});
