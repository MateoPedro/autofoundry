import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify, parse } from "yaml";
import { buildShortlist, receiptsFromEvents, validateComplianceOutput, type Assessment } from "../scripts/compliance-policy";
import { loadCompliance, prepareComplianceRun } from "../scripts/compliance-config";

// Synthetic assessment fixtures test the handoff gate, never seed production rows.
function candidate(n = 1, buyerType: Assessment["buyer_type"] = "B2B"): Assessment {
  return { target: "cluster", id: `cl_${n}`, cluster_id: `cl_${n}`, decision: "approve", reason: "Documented demand, scoped legal screening and plausible contribution.",
    buyer_type: buyerType, buyer: "A buyer identified in the fixture", need: "Convert owned documents into a searchable digital index",
    evidence: [{ url: "https://example.org/request", observation: "Synthetic fixture: a direct purchasing request, not a production lead" }],
    verified_lead_ids: [`ld_${n}`], digital_delivery: "Download link to a structured index",
    legal: { status: "clear", jurisdictions: ["California, USA"], basis: [{ url: "https://www.copyright.gov/help/faq/faq-protect.html", observation: "Fixture stipulates buyer owns the source documents and grants permission" }], risks: [] },
    monetization: { status: "plausible", payer: "The document owner", value: "Save paid indexing time", currency: "USD", price_low_cents: 2000,
      price_high_cents: 3000, cost_high_cents: 1000, assumptions: ["Synthetic: 10% conversion; $10/sale includes samples, acquisition, APIs, hosting, payment fees, support and refunds"],
      evidence: [{ url: "https://example.org/pricing", observation: "Synthetic comparable at $20; an estimate, not a verified sale" }], payment_route: "Naïve checkout proposed", payment_verified: false },
    evidence_strength: 3, delivery_readiness: 2, gaps: [] };
}
function output(assessments: Assessment[]) { return { assessments, coverage_complete: true, research_needed: ["Verify checkout before proposing an offer"] }; }
function receipts(assessments: Assessment[]) { return assessments.flatMap(a => [{ id: a.cluster_id, review_status: "approved" as const, lead_ids: a.verified_lead_ids }, { id: a.id, review_status: "approved" as const, cluster_id: a.cluster_id }]); }

test("B2B, B2C and B2A qualify by the same rules, including a strong single buyer", () => {
  const a = [candidate(1, "B2B"), candidate(2, "B2C"), candidate(3, "B2A")];
  const report = buildShortlist(output(a), receipts(a));
  assert.deepEqual(report.shortlist.map(c => c.buyer_type), ["B2B", "B2C", "B2A"]);
  assert.equal(report.shortfall, 5);
  assert.ok(report.shortlist.every(c => c.stage === "needs_offer" && c.offer_id === null && c.verified_lead_count === 1));
});

test("shortlist caps at 12, keeps eligible backlog, and never rejects lower ranks", () => {
  const a = Array.from({ length: 15 }, (_, i) => candidate(i + 1));
  a[14].evidence_strength = 1;
  const report = buildShortlist(output(a), receipts(a));
  assert.equal(report.shortlist.length, 12);
  assert.equal(report.eligible_backlog.length, 3);
  assert.equal(report.shortfall, 0);
  assert.ok(report.assessments.every(a => a.decision === "approve"));
  assert.equal(report.eligible_backlog.at(-1)?.cluster_id, "cl_15");
});

test("legal uncertainty, missing evidence and economics cannot pass the handoff gate", () => {
  for (const mutate of [
    (a: Assessment) => { a.legal.status = "needs_review"; },
    (a: Assessment) => { a.legal.status = "blocked"; },
    (a: Assessment) => { a.legal.jurisdictions = []; },
    (a: Assessment) => { a.legal.basis = []; },
    (a: Assessment) => { a.monetization.status = "needs_evidence"; },
    (a: Assessment) => { a.monetization.status = "unviable"; },
    (a: Assessment) => { a.monetization.cost_high_cents = 2000; },
    (a: Assessment) => { a.monetization.evidence = []; },
    (a: Assessment) => { a.monetization.assumptions = []; },
    (a: Assessment) => { a.evidence = []; },
    (a: Assessment) => { a.verified_lead_ids = []; },
    (a: Assessment) => { a.gaps = ["Only an appointment booking page; no inquiry route verified"]; },
  ]) {
    const a = candidate(); mutate(a);
    assert.throws(() => validateComplianceOutput(output([a])), /Approval/);
  }
});

test("pending legal review and rejected in-person/false-claim offers produce no shortlist", () => {
  const pending = candidate(1); pending.decision = "needs_evidence"; pending.legal.status = "needs_review";
  pending.gaps = ["Identify buyer jurisdiction and confirm commercial reuse license"];
  const inPerson = candidate(2); inPerson.target = "offer"; inPerson.id = "of_2";
  inPerson.decision = "reject"; inPerson.reason = "Requires an in-person visit, which our tools cannot deliver.";
  const falseClaim = candidate(3); falseClaim.target = "offer"; falseClaim.id = "of_3";
  falseClaim.decision = "reject"; falseClaim.reason = "Claims Google certification with no supporting evidence.";
  const report = buildShortlist(output([pending, inPerson, falseClaim]), []);
  assert.equal(report.shortlist.length, 0);
  assert.equal(report.shortfall, 8);
  assert.equal(report.assessments[0].decision, "needs_evidence");
});

test("ready for spawn requires the real approved offer, cluster receipt and payment verification", () => {
  const cluster = candidate();
  const offer = candidate(); offer.target = "offer"; offer.id = "of_1"; offer.monetization.payment_verified = true;
  assert.equal(buildShortlist(output([cluster, offer]), receipts([cluster])).shortlist[0].stage, "needs_offer");
  assert.equal(buildShortlist(output([offer]), [{ id: "of_1", review_status: "approved" }]).shortlist.length, 0);
  const ready = buildShortlist(output([cluster, offer]), receipts([offer]));
  assert.equal(ready.shortlist.length, 1);
  assert.equal(ready.shortlist[0].stage, "ready_for_spawn");
  assert.equal(ready.shortlist[0].offer_id, "of_1");
  offer.monetization.payment_verified = false;
  assert.throws(() => buildShortlist(output([offer]), receipts([offer])), /payment readiness/);
});

test("ranking prioritizes evidence, then readiness and verified count; duplicates are refused", () => {
  const a = candidate(1); a.evidence_strength = 1;
  const b = candidate(2); b.delivery_readiness = 3;
  const c = candidate(3); c.verified_lead_ids.push("ld_30");
  assert.deepEqual(buildShortlist(output([a, c, b]), receipts([a, b, c])).shortlist.map(c => c.cluster_id), ["cl_2", "cl_3", "cl_1"]);
  assert.throws(() => buildShortlist(output([a, a]), receipts([a])), /Duplicate/);
  a.verified_lead_ids.push(a.verified_lead_ids[0]);
  assert.throws(() => validateComplianceOutput(output([a])), /distinct/);
});

test("a receipt cannot validate invented lead IDs or an offer linked to another cluster", () => {
  const a = candidate();
  assert.equal(buildShortlist(output([a]), [{ id: a.id, review_status: "approved", lead_ids: ["ld_different"] }]).shortlist.length, 0);
  a.target = "offer"; a.id = "of_1"; a.monetization.payment_verified = true;
  assert.equal(buildShortlist(output([a]), [{ id: "cl_1", review_status: "approved", lead_ids: a.verified_lead_ids },
    { id: "of_1", review_status: "approved", cluster_id: "cl_other" }]).shortlist.length, 0);
});

test("only real successful Foundry review/context completion events establish receipts", () => {
  const event = (name: string, output: unknown, is_error = false) => ({ type: "tool.completed", data: { name, output, is_error } });
  const approved = { id: "cl_1", review_status: "approved" };
  assert.deepEqual(receiptsFromEvents([
    event("foundry.review", JSON.stringify(approved)),
    event("foundry.review_context", { cluster: approved, leads: [{ id: "ld_1" }], offer: { id: "of_1", cluster_id: "cl_1", review_status: "approved" } }),
    event("foundry.review", { content: [{ type: "text", text: JSON.stringify({ id: "of_2", review_status: "rejected" }) }] }),
    event("foundry.review", approved, true),
    event("foundry.review", { isError: true, content: [{ type: "text", text: JSON.stringify(approved) }] }),
    event("submit_output", approved),
    { type: "message.completed", data: { name: "foundry.review", output: approved } },
  ]), [approved, { ...approved, lead_ids: ["ld_1"] }, { id: "of_1", cluster_id: "cl_1", review_status: "approved" }, { id: "of_2", review_status: "rejected" }]);
});

test("audit is read-only; enforce permits only scoped review writes and explicit micro-USD caps", async () => {
  const audit = await loadCompliance(); const enforce = await loadCompliance("enforce");
  assert.equal(audit.tools?.default_config?.permission, "deny");
  assert.equal(audit.tools?.configs?.["foundry.review"], undefined);
  assert.equal(enforce.tools?.configs?.["foundry.review"].permission, "allow");
  assert.deepEqual(enforce.tools?.configs?.apps.config, { allowed_apps: ["app_f27yeve1gzgmztexhf9d0wbx62"], edits_apps: false });
  assert.equal(audit.budget.cap_micro_usd, 3_000_000);
  assert.equal(audit.budget.max_task_micro_usd, 500_000);
  assert.equal(audit.metadata?.config_hash, (await loadCompliance()).metadata?.config_hash);
  assert.notEqual(audit.metadata?.config_hash, enforce.metadata?.config_hash);
  assert.ok(!Object.keys(enforce.tools!.configs!).some(k => /spawn|fund|kill|send|data_run|browser/.test(k)));
});

test("config rejects excessive/fractional budgets and unexpected tool access", async () => {
  const path = "agents/compliance.agent.yaml";
  const original = parse(await readFile(path, "utf8"));
  const dir = await mkdtemp(join(tmpdir(), "compliance-config-"));
  const configPath = join(dir, "config.yaml");
  for (const mutate of [
    (c: typeof original) => { c.budget.cap_micro_usd = 3_000_001; },
    (c: typeof original) => { c.budget.max_task_micro_usd = 300_000.5; },
    (c: typeof original) => { c.budget.cap_usd = 3; },
    (c: typeof original) => { c.tools.configs["email.send"] = { enabled: true, permission: "allow" }; },
    (c: typeof original) => { c.tools.default_config.permission = "ask"; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    await writeFile(configPath, stringify(changed));
    await assert.rejects(loadCompliance("audit", undefined, configPath));
  }
});

test("retry preserves exact request and refuses reuse with changed mode/version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compliance-run-"));
  const agent = { id: "agt_test", version: 1, mode: "audit" as const };
  const first = await prepareComplianceRun("retry-test", agent, dir);
  assert.deepEqual(await prepareComplianceRun("retry-test", agent, dir), first);
  assert.equal(first.budget_micro_usd, 300_000);
  await assert.rejects(prepareComplianceRun("retry-test", { ...agent, version: 2 }, dir), /different/);
  await assert.rejects(prepareComplianceRun("retry-test", { ...agent, mode: "enforce" }, dir), /different/);
  await assert.rejects(prepareComplianceRun("../escape", agent, dir));
});
