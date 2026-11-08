import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { naiveClient } from "./naive-client";
import { COMPLIANCE_OWNER, COMPLIANCE_RUN_BUDGET, COMPLIANCE_TASK, loadCompliance, prepareComplianceRun, SCREEN_CRON, SCREEN_RUN_BUDGET, SCREEN_TASK, type ComplianceMode } from "./compliance-config";
import { auditComplianceTools, buildShortlist, normalizeComplianceOutput, receiptsFromEvents } from "./compliance-policy";
import { saveComplianceReport, writeOnce } from "./compliance-report";
import { screenIdeas } from "./compliance-screen";

async function main() {
  const [command = "check", ...args] = process.argv.slice(2);
  const allowed: Record<string, string[]> = { screen: ["--ideas", "--request-id"], check: [], apply: ["--mode", "--foundry-app"], run: ["--request-id", "--cluster-id", "--offer-id"], report: ["--sessions", "--request-id"], status: ["--session"], collect: ["--session"], deploy: ["--enabled", "--validated-session"] };
  if (command === "--help") {
    console.log("Idea stage: pnpm compliance screen --ideas var/scout/ideas/ID.json [--request-id ID]");
    console.log("pnpm compliance check | apply [--mode audit|enforce|screen] [--foundry-app app_ID] | run [--cluster-id cl_ID] [--offer-id of_ID] [--request-id ID] | status --session ses_ID | collect --session ses_ID | report --sessions ses_A,ses_B [--request-id ID] | deploy [--enabled false|true] [--validated-session ses_ID]");
    return;
  }
  if (!(command in allowed) || args.length % 2 || args.some((a, i) => i % 2 === 0 && !allowed[command].includes(a))) throw new Error("Unknown Compliance command or flag. Run pnpm compliance --help.");
  const flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i], args[2 * i + 1]]));
  if (new Set(args.filter((_, i) => i % 2 === 0)).size !== args.length / 2) throw new Error("Duplicate flags.");
  if (command === "screen") {
    if (!flags["--ideas"]) throw new Error("Provide --ideas with the saved Scout ideas JSON path.");
    const result = await screenIdeas(await naiveClient(60000), flags["--ideas"], flags["--request-id"] || randomUUID());
    console.log(JSON.stringify({ saved: result.jsonPath, readable_report: result.textPath, selected: result.report.selected.length,
      shortfall: result.report.shortfall, billed_micro_usd: result.report.billed_micro_usd, replayed: result.replayed }));
    return;
  }
  if (command === "report") {
    const { report, jsonPath, textPath } = await saveComplianceReport((flags["--sessions"] ?? "").split(",").filter(Boolean), flags["--request-id"] || randomUUID());
    console.log(JSON.stringify({ saved: jsonPath, readable_report: textPath, outcome: report.outcome, shortlisted: report.shortlist.length, failed_reviews: report.failed_reviews.length, consumed_micro_usd: report.consumed_micro_usd }));
    return;
  }
  if (command === "check") { const c = await loadCompliance(); console.log(JSON.stringify({ valid: true, model: c.model, default_permission: "deny", run_micro_usd: COMPLIANCE_RUN_BUDGET, budget: c.budget })); return; }
  const client = await naiveClient();
  const agents = [];
  let after: string | undefined;
  do {
    const page = await client.agents.list({ limit: 100, after });
    agents.push(...page.data.filter(a => a.name === "compliance"));
    after = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (after);
  if (agents.length > 1) throw new Error("Multiple compliance agents exist; no changes made.");
  const existing = agents[0];
  if (existing && (existing.metadata.project !== COMPLIANCE_OWNER.project || existing.metadata.role !== COMPLIANCE_OWNER.role)) throw new Error("The compliance agent belongs to another owner; no changes made.");
  if (command === "apply") {
    const config = await loadCompliance((flags["--mode"] || "audit") as ComplianceMode, flags["--foundry-app"]);
    await client.models.retrieve(config.model);
    const app = await client.apps.get(String(config.metadata!.foundry_app));
    if (app.name !== "foundry" || app.mcp !== "/mcp") throw new Error("Expected the verified native Foundry MCP app.");
    const agent = existing ? await client.agents.update(existing.id, { ...config, expected_version: existing.current_version }) : await client.agents.create(config);
    console.log(JSON.stringify({ agent_id: agent.id, version: agent.current_version, mode: agent.metadata.mode, budget: agent.budget }));
    return;
  }
  if (!existing) throw new Error("Apply Compliance in audit mode first.");
  const config = await loadCompliance(existing.metadata.mode as ComplianceMode, String(existing.metadata.foundry_app));
  if (["run", "deploy"].includes(command) && config.metadata!.config_hash !== existing.metadata.config_hash) throw new Error("Compliance config changed; apply and validate the current version first.");
  if (command === "run" && existing.metadata.mode === "screen") {
    // One manual idea screen of the latest Scout batch, the same task the cycle trigger sends.
    if (flags["--cluster-id"] || flags["--offer-id"]) throw new Error("Screen mode screens the latest batch; it takes no target.");
    const requestId = flags["--request-id"] || randomUUID();
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new Error("Request ID must be 8..100 letters, digits, underscores or hyphens.");
    // loose, as the schedule runs it: an immediate call's pre-flight quote (about $0.22) is above the
    // $0.10 screen budget, so Naïve refuses the session with budget_exceeded.
    const session = await client.sessions.create({ agent_id: existing.id, agent_version: existing.current_version, window: "loose",
      budget_micro_usd: SCREEN_RUN_BUDGET, message: SCREEN_TASK, metadata: { ...COMPLIANCE_OWNER, mode: "screen", request_id: requestId } },
      { idempotencyKey: `compliance-${requestId}` });
    console.log(JSON.stringify({ request_id: requestId, session_id: session.id, status: session.status, budget_micro_usd: session.budget_micro_usd }));
    return;
  }
  if (command === "run") {
    if (flags["--offer-id"] && !flags["--cluster-id"]) throw new Error("--offer-id requires its --cluster-id.");
    const requestId = flags["--request-id"] || randomUUID();
    const request = await prepareComplianceRun(requestId, { id: existing.id, version: existing.current_version, mode: existing.metadata.mode as ComplianceMode }, undefined,
      flags["--cluster-id"] ? { cluster_id: flags["--cluster-id"], ...(flags["--offer-id"] ? { offer_id: flags["--offer-id"] } : {}) } : undefined);
    console.log(`Compliance request ID: ${requestId}; reuse this ID after a lost response.`);
    const session = await client.sessions.create(request, { idempotencyKey: `compliance-${requestId}` });
    console.log(JSON.stringify({ session_id: session.id, status: session.status, budget_micro_usd: session.budget_micro_usd }));
    return;
  }
  async function collect(sessionId: string) {
    const session = await client.sessions.get(sessionId);
    if (session.agent_id !== existing.id) throw new Error("Session does not belong to Compliance.");
    if (["queued", "running"].includes(session.status)) throw new Error(`Session is ${session.status}; collect when it finishes.`);
    const failure = (message: string) => ({ session, report: buildShortlist({ assessments: [], coverage_complete: false, research_needed: [] }, []), receipts: [],
      contextAvailable: false, toolAudit: { counts: {}, violations: [] as string[] }, outcome: "failed" as const, failure: message });
    if (!["idle", "completed"].includes(session.status) || session.stop_reason !== "end_turn") return failure(`Review ended ${session.status}/${session.stop_reason}; no assessment was accepted.`);
    const events = [];
    let seq: number | undefined;
    for (;;) {
      const page = await client.sessions.events(sessionId, { limit: 100, after_seq: seq });
      if (page.skipped) throw new Error("Tool events were skipped; cannot verify the handoff.");
      events.push(...page.data);
      if (!page.has_more) break;
      const next = page.data.at(-1)?.seq;
      if (next === undefined || next === seq) throw new Error("Event pagination did not advance.");
      seq = next;
    }
    const receipts = receiptsFromEvents(events);
    let report;
    try {
      const normalized = normalizeComplianceOutput(session.structured_output);
      if (session.metadata.cluster_id && (normalized.assessments.length !== 1 || normalized.assessments[0].cluster_id !== session.metadata.cluster_id || normalized.assessments[0].id !== (session.metadata.offer_id || session.metadata.cluster_id))) return failure("Output did not match the requested target.");
      report = buildShortlist(normalized, receipts);
    } catch { return failure("Review output failed validation; no assessment was accepted."); }
    const contextAvailable = receipts.some(r => r.lead_ids !== undefined);
    return { session, report, receipts, contextAvailable, toolAudit: auditComplianceTools(events, String(session.metadata.mode)), outcome: "complete" as const, failure: undefined };
  }
  if (command === "status" || command === "collect") {
    const id = flags["--session"];
    if (!/^ses_[a-z0-9]+$/.test(id || "")) throw new Error("Provide --session ses_ID.");
    if (command === "status") {
      const s = await client.sessions.get(id);
      if (s.agent_id !== existing.id) throw new Error("Session does not belong to Compliance.");
      console.log(JSON.stringify({ session_id: s.id, version: s.agent_version, status: s.status, stop_reason: s.stop_reason,
        consumed_micro_usd: s.consumed_micro_usd, has_output: s.structured_output !== null, pending_tools: s.pending_actions.map(a => a.name) }));
      return;
    }
    const { session, report, receipts, contextAvailable, toolAudit, outcome, failure } = await collect(id);
    await mkdir(resolve("var/compliance"), { recursive: true, mode: 0o700 });
    const path = resolve(`var/compliance/${id}.json`);
    const content = JSON.stringify({ session_id: id, agent_id: session.agent_id, agent_version: session.agent_version,
      created_at: session.created_at, mode: session.metadata.mode, consumed_micro_usd: session.consumed_micro_usd, context_available: contextAvailable, tool_audit: toolAudit, receipts, outcome, failure, ...report }, null, 2) + "\n";
    await writeOnce(path, content);
    console.log(JSON.stringify({ saved: path, outcome, shortlisted: report.shortlist.length, shortfall: report.shortfall,
      unconfirmed_reviews: report.unconfirmed_reviews.length, coverage_complete: report.coverage_complete, context_available: contextAvailable, tool_limit_violations: toolAudit.violations }));
    if (outcome === "failed") process.exitCode = 1;
    return;
  }
  if (command === "deploy") {
    if (existing.metadata.mode === "screen") throw new Error("Compliance in screen mode is woken by cards (the cycle's last Scout run, or the sweep); it has no schedule.");
    if (flags["--enabled"] && !["true", "false"].includes(flags["--enabled"])) throw new Error("--enabled must be true or false.");
    const enabled = flags["--enabled"] === "true";
    const screen = existing.metadata.mode === "screen";
    // Screen mode needs no validated review session: the foundry checks every screen result itself.
    if (enabled && !screen) {
      if (existing.metadata.mode !== "enforce" || !flags["--validated-session"]) throw new Error("Enable only after a tested enforce pass; supply --validated-session.");
      const { session, report, contextAvailable, toolAudit } = await collect(flags["--validated-session"]);
      if (session.agent_version !== existing.current_version || !contextAvailable || !report.coverage_complete || report.unconfirmed_reviews.length || toolAudit.violations.length) throw new Error("Validate the current enforce version with complete coverage, working review_context and no tool-limit violations before enabling cron.");
    }
    const deployments = [];
    let cursor: string | undefined;
    do {
      const page = await client.deployments.list({ limit: 100, after: cursor });
      deployments.push(...page.data.filter(d => d.agent_id === existing.id));
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    if (deployments.length > 1) throw new Error("Multiple Compliance deployments exist; no schedules changed.");
    const body = screen
      ? { agent_version: existing.current_version, cron: SCREEN_CRON, timezone: "UTC", window: "loose" as const,
          enabled, budget_micro_usd: SCREEN_RUN_BUDGET, input_template: SCREEN_TASK }
      : { agent_version: existing.current_version, cron: "*/15 * * * *", timezone: "UTC", window: "loose" as const,
          enabled, budget_micro_usd: COMPLIANCE_RUN_BUDGET, input_template: COMPLIANCE_TASK };
    const d = deployments[0] ? await client.deployments.update(deployments[0].id, body) : await client.deployments.create({ ...body, agent_id: existing.id });
    console.log(JSON.stringify({ deployment_id: d.id, agent_version: d.agent_version, cron: d.cron, schedule_status: d.schedule_status, budget_micro_usd: d.budget_micro_usd }));
  }
}

main().catch(async error => {
  const { ApiError } = await import("@usenaive-sdk/managed-agents");
  console.error(error instanceof ApiError ? `Compliance request failed (HTTP ${error.status}, ${error.code}).` : error instanceof Error && error.name === "ZodError" ? "Compliance output failed validation; inspect the saved reply or review before retrying." : error instanceof Error ? error.message : "Compliance failed.");
  process.exitCode = 1;
});
