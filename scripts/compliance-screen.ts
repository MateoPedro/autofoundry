import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { writeOnce } from "./compliance-report";

export const SCREEN_MODEL = "google/gemma-4-31B-it";
export const SCREEN_MAX_TOKENS = 2400;
const summary = z.object({ ideas: z.array(z.object({ buyer: z.string().optional(), pipeline: z.string(), why: z.string(),
  cluster: z.object({ label: z.string() }), revenue: z.object({ payer: z.string(), offer: z.string(), model: z.string(), price_usd: z.number(), channel_ready: z.boolean() }).optional(),
})).min(1).max(20) });
const note = z.string().trim().min(1).max(180);
export const ideaScreenSchema = z.strictObject({
  selected: z.array(z.strictObject({ pick: z.number().int().min(1).max(20), reason: note, experiment: note, risks: z.array(z.string().max(100)).max(2) })).max(12),
  excluded: z.array(z.strictObject({ pick: z.number().int().min(1).max(20), category: z.enum(["obvious_illegal", "clearly_unworkable", "lower_priority"]), reason: note })).max(20),
});

export function screenCandidates(value: unknown) {
  return summary.parse(value).ideas.map((i, n) => ({ pick: n + 1, buyer: i.buyer ?? "unknown", pipeline: i.pipeline,
    title: i.cluster.label.slice(0, 220), signal: i.why.slice(0, 140),
    revenue_hypothesis: i.revenue ? { payer: i.revenue.payer.slice(0, 70), offer: i.revenue.offer.slice(0, 150),
      model: i.revenue.model, price_usd: i.revenue.price_usd, channel_ready: i.revenue.channel_ready } : null }));
}
type Candidates = ReturnType<typeof screenCandidates>;
export function validateIdeaScreen(value: unknown, candidates: Candidates) {
  const result = ideaScreenSchema.parse(value);
  const picks = [...result.selected, ...result.excluded].map(x => x.pick);
  if (picks.length !== candidates.length || new Set(picks).size !== picks.length || picks.some(p => p > candidates.length)) throw new Error("Screen must account for each supplied idea exactly once.");
  const hardDrops = result.excluded.filter(x => x.category !== "lower_priority").length;
  if (result.selected.length < Math.min(8, candidates.length - hardDrops)) throw new Error("Shortlist underfilled without enough clear blockers.");
  return { stage: "idea_screen", launch_approved: false, target_min: 8, target_max: 12,
    selected: result.selected.map((s, i) => ({ rank: i + 1, ...candidates[s.pick - 1], ...s })),
    excluded: result.excluded.map(s => ({ ...candidates[s.pick - 1], ...s })), shortfall: Math.max(0, 8 - result.selected.length) };
}

export async function screenIdeas(client: Pick<VettaClient, "models" | "proxy">, ideasPath: string, requestId: string, directory = resolve("var/compliance/screens"), sourceDirectory = resolve("var/scout/ideas")) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new Error("Screen ID must be 8..100 letters, digits, underscores or hyphens.");
  const path = await realpath(resolve(ideasPath)), root = await realpath(sourceDirectory);
  if (!path.startsWith(root + sep) || !path.endsWith(".json")) throw new Error("Screen input must be a saved Scout ideas JSON file.");
  let raw: unknown; try { raw = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Saved Scout ideas are not valid JSON."); }
  const candidates = screenCandidates(raw), rules = await readFile(resolve("rules/idea-screen.md"), "utf8");
  const body = { model: SCREEN_MODEL, max_tokens: SCREEN_MAX_TOKENS, thinking: { type: "disabled" as const }, system: rules,
    messages: [{ role: "user" as const, content: `Screen these ${candidates.length} ideas. Keep 8–12 unless clear blockers leave fewer. Return concise JSON only.\n<untrusted_ideas>${JSON.stringify(candidates)}</untrusted_ideas>` }] };
  if (JSON.stringify(body).length > 18000) throw new Error("Idea summaries exceed the compact screen input limit.");
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await mkdir(directory, { recursive: true, mode: 0o700 }); const base = resolve(directory, requestId);
  try {
    const saved = JSON.parse(await readFile(base + ".json", "utf8"));
    if (saved.fingerprint !== fingerprint) throw new Error("Screen ID belongs to different input or rules.");
    return { report: saved, jsonPath: base + ".json", textPath: base + ".txt", replayed: true };
  } catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; }
  await client.models.retrieve(SCREEN_MODEL);
  try { await writeFile(base + ".started", JSON.stringify({ fingerprint, model: SCREEN_MODEL, max_tokens: SCREEN_MAX_TOKENS }), { flag: "wx", mode: 0o600 }); }
  catch (e) { if (e instanceof Error && "code" in e && e.code === "EEXIST") throw new Error("Screen already started without an accepted result; inspect it before another paid call."); throw e; }
  const reply = await client.proxy.messages(body, "immediate");
  await writeOnce(base + ".reply.json", JSON.stringify(reply, null, 2) + "\n");
  const text = reply.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!["end_turn", "stop"].includes(reply.stop_reason ?? "")) throw new Error("Screen did not finish cleanly; no shortlist was accepted.");
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error("Screen did not return JSON; the reply is saved and no paid retry was started."); }
  const result = validateIdeaScreen(value, candidates);
  let billed: number | null = null;
  try { billed = (await client.proxy.call(reply.id)).billed_micro_usd; } catch { /* Some keys cannot read billing traces. Never invent a charge. */ }
  const report = { ...result, request_id: requestId, model: reply.model, provider_request_id: reply.id, fingerprint,
    billed_micro_usd: billed, usage: reply.usage, source_path: path, candidate_count: candidates.length };
  const lines = ["Quick Compliance idea screen", `Input: ${candidates.length}; selected: ${result.selected.length}; shortfall: ${result.shortfall}.`,
    "Selected ideas are experiments; this does not approve launch or external actions.", `Recorded model cost: ${billed === null ? "unavailable" : "$" + (billed / 1e6).toFixed(6)}`, ""];
  for (const s of result.selected) lines.push(`${s.rank}. ${s.title}`, `   Why: ${s.reason}`, `   First test: ${s.experiment}`, ...s.risks.map(r => `   Flag: ${r}`), "");
  lines.push("Excluded:", ...result.excluded.map(s => `${s.pick}. ${s.title}: ${s.category} — ${s.reason}`));
  await writeOnce(base + ".json", JSON.stringify(report, null, 2) + "\n"); await writeOnce(base + ".txt", lines.join("\n") + "\n");
  return { report, jsonPath: base + ".json", textPath: base + ".txt", replayed: false };
}
