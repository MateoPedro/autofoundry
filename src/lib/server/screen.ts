import { z } from "zod";

// The quick idea screen (rules/idea-screen.md): up to 20 ideas in, 8–12 experiments out, in one
// bounded model call. Shared by the foundry's screen_batch tool and `pnpm compliance screen`.
export const SCREEN_MODEL = "google/gemma-4-31B-it";
export const SCREEN_MAX_TOKENS = 2400;
export const SCREEN_MAX_IDEAS = 20;
// What a Compliance screen session is told, by the Scout-cycle trigger, the fallback cron and a manual run.
export const SCREEN_TASK = "Run the idea screen for the latest Scout batch: call foundry.screen_batch once and summarize its result.";
export const SCREEN_RUN_BUDGET_MICRO_USD = 100_000;

export type ScreenCandidate = {
  pick: number;
  buyer: string;
  pipeline: string;
  title: string;
  signal: string;
  revenue_hypothesis: { payer: string; offer: string; model: string; price_usd: number; channel_ready: boolean } | null;
};

const note = z.string().trim().min(1).max(180);
export const ideaScreenSchema = z.strictObject({
  selected: z.array(z.strictObject({ pick: z.number().int().min(1).max(SCREEN_MAX_IDEAS), reason: note, experiment: note, risks: z.array(z.string().max(100)).max(2) })).max(12),
  excluded: z.array(z.strictObject({ pick: z.number().int().min(1).max(SCREEN_MAX_IDEAS), category: z.enum(["obvious_illegal", "clearly_unworkable", "lower_priority"]), reason: note })).max(SCREEN_MAX_IDEAS),
});

export function validateIdeaScreen<C extends ScreenCandidate>(value: unknown, candidates: C[]) {
  const result = ideaScreenSchema.parse(value);
  const picks = [...result.selected, ...result.excluded].map((x) => x.pick);
  if (picks.length !== candidates.length || new Set(picks).size !== picks.length || picks.some((p) => p > candidates.length)) throw new Error("Screen must account for each supplied idea exactly once.");
  const hardDrops = result.excluded.filter((x) => x.category !== "lower_priority").length;
  if (result.selected.length < Math.min(8, candidates.length - hardDrops)) throw new Error("Shortlist underfilled without enough clear blockers.");
  return { stage: "idea_screen" as const, launch_approved: false, target_min: 8, target_max: 12,
    selected: result.selected.map((s, i) => ({ rank: i + 1, ...candidates[s.pick - 1], ...s })),
    excluded: result.excluded.map((s) => ({ ...candidates[s.pick - 1], ...s })), shortfall: Math.max(0, 8 - result.selected.length) };
}

export function screenRequest(rules: string, candidates: ScreenCandidate[]) {
  const body = { model: SCREEN_MODEL, max_tokens: SCREEN_MAX_TOKENS, thinking: { type: "disabled" as const }, system: rules,
    messages: [{ role: "user" as const, content: `Screen these ${candidates.length} ideas. Keep 8–12 unless clear blockers leave fewer. Return concise JSON only.\n<untrusted_ideas>${JSON.stringify(candidates)}</untrusted_ideas>` }] };
  if (JSON.stringify(body).length > 18000) throw new Error("Idea summaries exceed the compact screen input limit.");
  return body;
}

export type ScreenReply = { id: string; model: string; stop_reason: string | null; content: ({ type: "text"; text: string } | { type: string })[] };
export function parseScreenReply(reply: ScreenReply): unknown {
  const text = reply.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!["end_turn", "stop"].includes(reply.stop_reason ?? "")) throw new Error("Screen did not finish cleanly; no shortlist was accepted.");
  try { return JSON.parse(text); } catch { throw new Error("Screen did not return JSON; no paid retry was started."); }
}
