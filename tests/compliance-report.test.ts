import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeComplianceOutput } from "../scripts/compliance-policy";
import { aggregateComplianceReviews, saveComplianceReport } from "../scripts/compliance-report";

function hold(id: string) {
  return normalizeComplianceOutput({ assessment: { target: "cluster", id, cluster_id: id, decision: "needs_evidence", buyer_type: "B2C", reason: "Jurisdiction is unknown.", gaps: ["Confirm seller and buyer jurisdictions."] } });
}
function record(id: string, cluster: string) { return { session_id: id, outcome: "complete", created_at: "2026-11-08T01:00:00Z", consumed_micro_usd: 12000, receipts: [], ...hold(cluster) }; }

test("report assembly is deterministic, counts each session's cost once and keeps failures visible", () => {
  const good = record("ses_a", "cl_a");
  const bad = { session_id: "ses_b", outcome: "failed", consumed_micro_usd: 14000, assessments: [], failure: "Model reached its output limit." };
  const report = aggregateComplianceReviews([bad, good, good]);
  assert.equal(report.outcome, "partial");
  assert.equal(report.completed_reviews, 1);
  assert.equal(report.failed_reviews.length, 1);
  assert.equal(report.assessments.length, 1);
  assert.equal(report.consumed_micro_usd, 26000);
  assert.equal(report.shortfall, 8);
  assert.deepEqual(report, aggregateComplianceReviews([good, bad]));
  assert.throws(() => aggregateComplianceReviews([good, { ...good, consumed_micro_usd: 1 }]), /Conflicting/);
  assert.throws(() => aggregateComplianceReviews([{ ...bad, assessments: good.assessments }]), /failed review/);
});

test("a later completed assessment replaces an earlier hold while both real costs remain", () => {
  const first = record("ses_a", "cl_a");
  const next = { ...record("ses_b", "cl_a"), created_at: "2026-11-08T02:00:00Z" };
  next.assessments[0].reason = "A supported channel is still missing.";
  const report = aggregateComplianceReviews([next, first]);
  assert.equal(report.assessments.length, 1);
  assert.equal(report.assessments[0].reason, next.assessments[0].reason);
  assert.equal(report.consumed_micro_usd, 24000);
  assert.equal(report.shortlist.length, 0);
});

test("tool overruns remain operational warnings in the report", () => {
  const report = aggregateComplianceReviews([{ ...record("ses_a", "cl_a"), tool_audit: { violations: ["web_fetch exceeded 1 calls"] } }]);
  assert.equal(report.outcome, "partial");
  assert.equal(report.operational_warnings.length, 1);
});

test("offline report writes JSON/text with immutable replay and validates selected checkpoint IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compliance-report-"));
  await writeFile(join(dir, "ses_a.json"), JSON.stringify(record("ses_a", "cl_a")));
  const first = await saveComplianceReport(["ses_a"], "report-001", dir);
  assert.match(await readFile(first.textPath, "utf8"), /Jurisdiction is unknown/);
  assert.deepEqual(await saveComplianceReport(["ses_a"], "report-001", dir), first);
  await assert.rejects(saveComplianceReport(["../escape"], "report-001", dir));
  await assert.rejects(saveComplianceReport(["ses_a", "ses_a"], "report-001", dir));
  await writeFile(join(dir, "ses_b.json"), JSON.stringify(record("ses_c", "cl_a")));
  await assert.rejects(saveComplianceReport(["ses_b"], "report-002", dir), /does not match/);
});
