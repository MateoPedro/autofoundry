import { z } from "zod";

const text = z.string().trim().min(1).max(1000);
const link = z.url().regex(/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/);
const evidence = z.strictObject({ url: link, observation: text });
export const assessmentSchema = z.strictObject({
  target: z.enum(["cluster", "offer"]),
  id: z.string().regex(/^(cl|of)_[a-z0-9]+$/),
  cluster_id: z.string().regex(/^cl_[a-z0-9]+$/),
  decision: z.enum(["approve", "reject", "needs_evidence"]),
  reason: z.string().trim().min(1).max(500),
  buyer_type: z.enum(["B2B", "B2C", "B2A", "unknown"]),
  buyer: text,
  need: text,
  evidence: z.array(evidence).max(12),
  verified_lead_ids: z.array(z.string().regex(/^ld_[a-z0-9]+$/)).max(100),
  digital_delivery: text,
  legal: z.strictObject({
    status: z.enum(["clear", "blocked", "needs_review"]),
    jurisdictions: z.array(text).max(5),
    basis: z.array(evidence).max(8),
    risks: z.array(text).max(8),
  }),
  monetization: z.strictObject({
    status: z.enum(["plausible", "unviable", "needs_evidence"]),
    payer: text,
    value: text,
    currency: z.literal("USD"),
    price_low_cents: z.number().int().min(0),
    price_high_cents: z.number().int().min(0),
    cost_high_cents: z.number().int().min(0),
    assumptions: z.array(text).max(10),
    evidence: z.array(evidence).max(8),
    payment_route: text,
    payment_verified: z.boolean(),
  }),
  evidence_strength: z.number().int().min(0).max(3),
  delivery_readiness: z.number().int().min(0).max(3),
  gaps: z.array(text).max(12),
});
export const complianceOutputSchema = z.strictObject({
  assessments: z.array(assessmentSchema).max(40),
  coverage_complete: z.boolean(),
  research_needed: z.array(text).max(30),
});
// A hosted run reviews one target. Holds/rejections do not need a padded business
// plan; approved opportunities retain the full evidence gate used by the handoff.
const shortReviewSchema = z.strictObject({
  target: z.enum(["cluster", "offer"]),
  id: z.string().regex(/^(cl|of)_[a-z0-9]+$/),
  cluster_id: z.string().regex(/^cl_[a-z0-9]+$/),
  decision: z.enum(["reject", "needs_evidence"]),
  buyer_type: z.enum(["B2B", "B2C", "B2A", "unknown"]),
  reason: z.string().trim().min(1).max(300),
  gaps: z.array(z.string().trim().min(1).max(200)).max(3),
});
export const complianceReviewSchema = z.strictObject({
  assessment: z.union([shortReviewSchema, assessmentSchema.extend({ decision: z.literal("approve") })]).nullable(),
});
export function normalizeComplianceOutput(value: unknown): ComplianceOutput {
  if (value && typeof value === "object" && "assessments" in value) return validateComplianceOutput(value);
  const { assessment: a } = complianceReviewSchema.parse(value);
  if (a === null) return { assessments: [], coverage_complete: true, research_needed: [] };
  if (a.decision === "approve") return validateComplianceOutput({ assessments: [a], coverage_complete: true, research_needed: [] });
  const held: Assessment = { ...a, buyer: "Not assessed", need: "See review reason", evidence: [], verified_lead_ids: [],
    digital_delivery: "Not assessed", legal: { status: "needs_review", jurisdictions: [], basis: [], risks: [] },
    monetization: { status: "needs_evidence", payer: "Not assessed", value: "Not assessed", currency: "USD",
      price_low_cents: 0, price_high_cents: 0, cost_high_cents: 0, assumptions: [], evidence: [], payment_route: "Not verified", payment_verified: false },
    evidence_strength: 0, delivery_readiness: 0 };
  return validateComplianceOutput({ assessments: [held], coverage_complete: true, research_needed: a.gaps });
}
export type Assessment = z.infer<typeof assessmentSchema>;
export type ComplianceOutput = z.infer<typeof complianceOutputSchema>;
export type Receipt = { id: string; review_status: "pending" | "approved" | "rejected"; cluster_id?: string; lead_ids?: string[] };

export function auditComplianceTools(events: { type: string; data: Record<string, unknown> }[], mode: string) {
  const counts: Record<string, number> = {};
  const violations: string[] = [];
  const allowed = new Set(["web_search", "web_fetch", "foundry.list_pending", "foundry.list_clusters", "foundry.review_context", "submit_output", "vetta.tools_search"]);
  if (mode === "enforce") allowed.add("foundry.review");
  for (const event of events) {
    if (event.type !== "tool.started") continue;
    const name = String(event.data.name);
    counts[name] = (counts[name] ?? 0) + 1;
    if (!allowed.has(name)) violations.push(`Unexpected tool: ${name}`);
  }
  for (const [name, limit] of Object.entries({ web_search: 1, web_fetch: 1, "foundry.review_context": 2, "foundry.list_pending": 1, "foundry.review": 1 })) {
    if ((counts[name] ?? 0) > limit) violations.push(`${name} exceeded ${limit} calls`);
  }
  return { counts, violations: [...new Set(violations)] };
}

// These checks protect the collected handoff as well as fixture validation. The native
// agent applies the full rules before calling review; this is not a second reviewer.
export function validateComplianceOutput(value: unknown): ComplianceOutput {
  const output = complianceOutputSchema.parse(value);
  const ids = new Set<string>();
  for (const a of output.assessments) {
    if (ids.has(a.id)) throw new Error("Duplicate review target.");
    ids.add(a.id);
    if ((a.target === "cluster" && a.id !== a.cluster_id) || (a.target === "offer" && !a.id.startsWith("of_"))) throw new Error("Review target and cluster identity disagree.");
    if (new Set(a.verified_lead_ids).size !== a.verified_lead_ids.length) throw new Error("Verified leads must be distinct.");
    const m = a.monetization;
    if (m.price_high_cents < m.price_low_cents) throw new Error("Price range is reversed.");
    if (a.decision === "approve") {
      if (a.buyer_type === "unknown" || !a.verified_lead_ids.length || !a.evidence.length || a.gaps.length ||
          a.legal.status !== "clear" || !a.legal.jurisdictions.length || !a.legal.basis.length ||
          m.status !== "plausible" || !m.evidence.length || !m.assumptions.length || m.price_low_cents < 50 || m.price_low_cents <= m.cost_high_cents ||
          (a.target === "offer" && !m.payment_verified)) throw new Error(`Approval ${a.id} lacks required evidence, legal clearance, margin, or payment readiness.`);
    }
    if (a.decision === "needs_evidence" && !a.gaps.length) throw new Error("Pending assessments need an actionable evidence gap.");
  }
  return output;
}

export function buildShortlist(value: unknown, receipts: Receipt[]) {
  const output = validateComplianceOutput(value);
  const confirmed = new Map(receipts.map(r => [r.id, r.review_status]));
  const inspected = new Map<string, Set<string>>();
  const offerClusters = new Map<string, string>();
  for (const r of receipts) {
    if (r.id.startsWith("cl_") && r.lead_ids) {
      const ids = inspected.get(r.id) ?? new Set<string>();
      r.lead_ids.forEach(id => ids.add(id)); inspected.set(r.id, ids);
    }
    if (r.id.startsWith("of_") && r.cluster_id) offerClusters.set(r.id, r.cluster_id);
  }
  // A successful review receipt, or current review_context read, is required.
  // Text in the model's response cannot establish an approved database status.
  const confirmedApproval = (a: Assessment) => confirmed.get(a.id) === "approved" && confirmed.get(a.cluster_id) === "approved" &&
    a.verified_lead_ids.every(id => inspected.get(a.cluster_id)?.has(id)) && (a.target === "cluster" || offerClusters.get(a.id) === a.cluster_id);
  const eligible = output.assessments.filter(a => a.decision === "approve" && confirmedApproval(a))
    .sort((a, b) => b.evidence_strength - a.evidence_strength || b.delivery_readiness - a.delivery_readiness || b.verified_lead_ids.length - a.verified_lead_ids.length || a.cluster_id.localeCompare(b.cluster_id));
  const distinct = new Map<string, Assessment>();
  for (const a of eligible) {
    const previous = distinct.get(a.cluster_id);
    if (!previous || (a.target === "offer" && previous.target === "cluster")) distinct.set(a.cluster_id, a);
  }
  const candidates = [...distinct.values()].sort((a, b) => b.evidence_strength - a.evidence_strength || b.delivery_readiness - a.delivery_readiness || b.verified_lead_ids.length - a.verified_lead_ids.length || a.cluster_id.localeCompare(b.cluster_id));
  const entry = (a: Assessment, index: number) => ({ rank: index + 1, cluster_id: a.cluster_id,
    offer_id: a.target === "offer" ? a.id : null, stage: a.target === "offer" ? "ready_for_spawn" : "needs_offer",
    buyer: a.buyer, buyer_type: a.buyer_type, need: a.need, evidence: a.evidence,
    verified_lead_count: a.verified_lead_ids.length, digital_delivery: a.digital_delivery,
    legal: a.legal, monetization: a.monetization, selection_reason: a.reason });
  return { target_min: 8, target_max: 12, shortlist: candidates.slice(0, 12).map(entry),
    shortfall: Math.max(0, 8 - candidates.length), eligible_backlog: candidates.slice(12).map((a, i) => entry(a, i + 12)),
    assessments: output.assessments, coverage_complete: output.coverage_complete,
    unconfirmed_reviews: output.assessments.filter(a => a.decision === "approve" ? !confirmedApproval(a) : a.decision === "reject" && confirmed.get(a.id) !== "rejected").map(a => a.id),
    research_needed: output.research_needed };
}

// Tool event payloads come from Naïve, never from structured_output. Unknown shapes
// fail closed: keep the raw session for inspection and do not claim spawn readiness.
export function receiptsFromEvents(events: { type: string; data: Record<string, unknown> }[]): Receipt[] {
  const receipts: Receipt[] = [];
  const receipt = z.object({ id: z.string().regex(/^(cl|of)_[a-z0-9]+$/), review_status: z.enum(["pending", "approved", "rejected"]), cluster_id: z.string().regex(/^cl_[a-z0-9]+$/).optional() });
  function accept(v: unknown) { const parsed = receipt.safeParse(v); if (parsed.success) receipts.push(parsed.data); }
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const name = event.data.name ?? event.data.tool;
    if (name !== "foundry.review" && name !== "foundry.review_context") continue;
    if (event.data.is_error) continue;
    let result: unknown = event.data.output;
    if (typeof result === "string") { try { result = JSON.parse(result); } catch { continue; } }
    if (!result || typeof result !== "object") continue;
    const r = result as Record<string, unknown>;
    if (r.isError || r.error) continue;
    if (Array.isArray(r.content)) {
      const block = r.content.find(b => b && typeof b === "object" && b.type === "text");
      try { result = JSON.parse(block?.text); } catch { continue; }
    }
    if (!result || typeof result !== "object") continue;
    if (name === "foundry.review") accept(result);
    else {
      const context = result as Record<string, unknown>;
      const cluster = receipt.safeParse(context.cluster);
      if (!cluster.success || !cluster.data.id.startsWith("cl_") || !Array.isArray(context.leads)) continue;
      const ids = z.array(z.object({ id: z.string().regex(/^ld_[a-z0-9]+$/) })).safeParse(context.leads);
      if (!ids.success) continue;
      receipts.push({ ...cluster.data, lead_ids: ids.data.map(l => l.id) });
      const offer = receipt.safeParse(context.offer);
      if (offer.success && offer.data.cluster_id === cluster.data.id) receipts.push(offer.data);
    }
  }
  return receipts;
}
