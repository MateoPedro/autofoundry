import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { assessmentSchema, buildShortlist } from "./compliance-policy";

const receipt = z.object({ id: z.string(), review_status: z.enum(["pending", "approved", "rejected"]), cluster_id: z.string().optional(), lead_ids: z.array(z.string()).optional() });
const checkpoint = z.object({
  session_id: z.string().regex(/^ses_[a-z0-9]+$/),
  outcome: z.enum(["complete", "failed"]).default("complete"),
  created_at: z.string().optional(), consumed_micro_usd: z.number().int().nonnegative().safe(),
  assessments: z.array(assessmentSchema).max(40), receipts: z.array(receipt).default([]),
  research_needed: z.array(z.string()).default([]), failure: z.string().optional(),
  tool_audit: z.object({ violations: z.array(z.string()) }).optional(),
});

export function aggregateComplianceReviews(values: unknown[]) {
  const unique = new Map<string, z.infer<typeof checkpoint>>();
  for (const value of values) {
    const record = checkpoint.parse(value);
    if (record.outcome === "failed" && record.assessments.length) throw new Error("A failed review cannot supply assessments.");
    if (unique.has(record.session_id) && JSON.stringify(unique.get(record.session_id)) !== JSON.stringify(record)) throw new Error("Conflicting checkpoints for one session.");
    unique.set(record.session_id, record);
  }
  const records = [...unique.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.session_id.localeCompare(b.session_id));
  const latest = new Map<string, z.infer<typeof assessmentSchema>>();
  for (const r of records) for (const a of r.assessments) latest.set(a.id, a);
  const failed = records.filter(r => r.outcome === "failed").map(r => ({ session_id: r.session_id, failure: r.failure ?? "Review failed" }));
  const warnings = records.flatMap(r => (r.tool_audit?.violations ?? []).map(message => ({ session_id: r.session_id, message })));
  const research = [...new Set(records.flatMap(r => r.research_needed))];
  const report = buildShortlist({ assessments: [...latest.values()], coverage_complete: !failed.length, research_needed: research.slice(0, 30) }, records.flatMap(r => r.receipts));
  return { ...report, outcome: failed.length || warnings.length ? "partial" : "complete", scope: "collected reviews, not the entire Foundry queue", operational_warnings: warnings,
    completed_reviews: records.filter(r => r.outcome === "complete").length, failed_reviews: failed,
    sessions: records.map(r => r.session_id), consumed_micro_usd: records.reduce((n, r) => n + r.consumed_micro_usd, 0),
    research_gap_count: research.length };
}

export async function writeOnce(path: string, content: string) {
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || await readFile(path, "utf8") !== content) throw error; }
}

export async function saveComplianceReport(ids: string[], reportId: string, directory = resolve("var/compliance")) {
  if (!ids.length || ids.length > 40 || new Set(ids).size !== ids.length || ids.some(id => !/^ses_[a-z0-9]+$/.test(id))) throw new Error("Provide 1..40 distinct ses_ IDs already collected.");
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(reportId)) throw new Error("Report ID must be 8..100 letters, digits, underscores or hyphens.");
  const records = await Promise.all(ids.map(async id => {
    const record = JSON.parse(await readFile(resolve(directory, `${id}.json`), "utf8"));
    if (record.session_id !== id) throw new Error("Checkpoint does not match its session ID.");
    return record;
  }));
  const report = aggregateComplianceReviews(records);
  const destination = resolve(directory, "reports"); await mkdir(destination, { recursive: true, mode: 0o700 });
  const jsonPath = resolve(destination, `${reportId}.json`), textPath = resolve(destination, `${reportId}.txt`);
  const lines = ["AutoFoundry Compliance report", `Status: ${report.outcome}; scope: ${report.scope}`,
    `Completed runs: ${report.completed_reviews}; failed runs: ${report.failed_reviews.length}`,
    `Confirmed shortlist: ${report.shortlist.length}; shortfall against 8: ${report.shortfall}`,
    `Recorded review cost: $${(report.consumed_micro_usd / 1e6).toFixed(6)}`, "", "Reviews"];
  for (const a of report.assessments) lines.push(`${a.id} (${a.buyer_type}): ${a.decision} — ${a.reason}`, ...a.gaps.map(g => `  Research needed: ${g}`));
  for (const f of report.failed_reviews) lines.push(`${f.session_id}: FAILED — ${f.failure}`);
  for (const w of report.operational_warnings) lines.push(`${w.session_id}: WARNING — ${w.message}`);
  if (report.unconfirmed_reviews.length) lines.push("", `Unconfirmed decisions: ${report.unconfirmed_reviews.join(", ")}`);
  await writeOnce(jsonPath, JSON.stringify(report, null, 2) + "\n"); await writeOnce(textPath, lines.join("\n") + "\n");
  return { report, jsonPath, textPath };
}
