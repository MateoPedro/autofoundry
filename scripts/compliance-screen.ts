import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { writeOnce } from "./compliance-report";
import { parseScreenReply, screenRequest, SCREEN_MAX_TOKENS, SCREEN_MODEL, validateIdeaScreen } from "../src/lib/server/screen";

// Shared with the foundry's screen_batch tool.
export { ideaScreenSchema, SCREEN_MAX_TOKENS, SCREEN_MODEL, validateIdeaScreen } from "../src/lib/server/screen";

const summary = z.object({ ideas: z.array(z.object({ buyer: z.string().optional(), pipeline: z.string(), why: z.string(),
  cluster: z.object({ label: z.string() }), revenue: z.object({ payer: z.string(), offer: z.string(), model: z.string(), price_usd: z.number(), channel_ready: z.boolean() }).optional(),
})).min(1).max(20) });
export function screenCandidates(value: unknown) {
  return summary.parse(value).ideas.map((i, n) => ({ pick: n + 1, buyer: i.buyer ?? "unknown", pipeline: i.pipeline,
    title: i.cluster.label.slice(0, 220), signal: i.why.slice(0, 140),
    revenue_hypothesis: i.revenue ? { payer: i.revenue.payer.slice(0, 70), offer: i.revenue.offer.slice(0, 150),
      model: i.revenue.model, price_usd: i.revenue.price_usd, channel_ready: i.revenue.channel_ready } : null }));
}
export async function screenIdeas(client: Pick<VettaClient, "models" | "proxy">, ideasPath: string, requestId: string, directory = resolve("var/compliance/screens"), sourceDirectory = resolve("var/scout/ideas")) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new Error("Screen ID must be 8..100 letters, digits, underscores or hyphens.");
  const path = await realpath(resolve(ideasPath)), root = await realpath(sourceDirectory);
  if (!path.startsWith(root + sep) || !path.endsWith(".json")) throw new Error("Screen input must be a saved Scout ideas JSON file.");
  let raw: unknown; try { raw = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Saved Scout ideas are not valid JSON."); }
  const candidates = screenCandidates(raw), rules = await readFile(resolve("rules/idea-screen.md"), "utf8");
  const body = screenRequest(rules, candidates);
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
  const value = parseScreenReply(reply);
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
