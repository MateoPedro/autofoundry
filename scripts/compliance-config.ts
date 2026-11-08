import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import type { AgentCreate, SessionCreate } from "@usenaive-sdk/managed-agents";
import { complianceReviewSchema } from "./compliance-policy";

export const COMPLIANCE_OWNER = { project: "autofoundry", role: "compliance" };
export const FOUNDRY_APP = "app_f27yeve1gzgmztexhf9d0wbx62";
export const COMPLIANCE_RUN_BUDGET = 300_000;
export const COMPLIANCE_TASK = "Review exactly ONE candidate for legal risk, monetization, evidence and delivery. Missing facts mean needs_evidence with at most three specific gaps. Do not write a portfolio report or conduct open-ended research. Finish with submit_output.";
export type ComplianceMode = "audit" | "enforce" | "screen";
// Screen mode (owner policy): Compliance only runs the quick idea screen after each Scout cycle.
export { SCREEN_TASK, SCREEN_RUN_BUDGET_MICRO_USD as SCREEN_RUN_BUDGET } from "../src/lib/server/screen";
// Polls every 10 minutes through the first two hours of each 3-hour Scout cycle. screen_batch answers
// ready: false until every scheduled Scout run has ended (or 90 minutes in), and already_screened afterwards,
// so the screen starts within about 10 minutes of Scout finishing and runs once per cycle.
export const SCREEN_CRON = "*/10 0-23/3,1-23/3 * * *";

export async function loadCompliance(mode: ComplianceMode = "audit", foundryApp = FOUNDRY_APP, path = resolve("agents/compliance.agent.yaml")): Promise<AgentCreate> {
  if (!["audit", "enforce", "screen"].includes(mode)) throw new Error("Compliance mode must be audit, enforce or screen.");
  if (!/^app_[a-z0-9]+$/.test(foundryApp)) throw new Error("Foundry must be a verified app_ ID.");
  const doc = parse(await readFile(path, "utf8"));
  const cap = doc.budget?.cap_micro_usd;
  const task = doc.budget?.max_task_micro_usd;
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > 3_000_000 || !Number.isSafeInteger(task) || task < COMPLIANCE_RUN_BUDGET || task > 500_000 || task > cap || doc.budget.period !== "day" || "cap_usd" in doc.budget || "max_task_usd" in doc.budget) {
    throw new Error("Compliance budgets require integer micro-USD: day <= 3000000, task 300000..500000.");
  }
  if (doc.name !== "compliance" || doc.harness !== "pi" || !doc.model || doc.tools?.default_config?.permission !== "deny") throw new Error("Compliance requires its own name, pi harness, model and default deny.");
  for (const [name, settings] of Object.entries(doc.tools.configs ?? {}) as [string, { enabled: boolean; permission: string }][]) {
    if (!["web_search", "web_fetch"].includes(name) || settings.enabled !== true || settings.permission !== "allow") throw new Error(`Unexpected Compliance tool: ${name}`);
  }
  if (doc.mcp_servers?.length || doc.skills?.length || doc.multiagent || doc.handoffs || doc.apps || doc.identity) throw new Error("Compliance cannot load extra tools, identities, apps or delegation.");
  if (mode === "screen") {
    // Only the screen tool: no web tools, no review writes, no structured review output.
    const system = `${await readFile(resolve(dirname(path), "prompts/compliance-screen.md"), "utf8")}\n\n${await readFile(resolve(dirname(path), "../rules/idea-screen.md"), "utf8")}`;
    const config: AgentCreate = { name: doc.name, description: "Screens each Scout batch down to 8–12 experiments for Creator; never contacts anyone.", model: doc.model, harness: "pi", window: "loose", system,
      budget: doc.budget, tools: { default_config: { permission: "deny" }, configs: {
        apps: { enabled: true, permission: "deny", config: { allowed_apps: [foundryApp] } },
        "foundry.screen_batch": { enabled: true, permission: "allow" },
        "foundry.submit_screen": { enabled: true, permission: "allow" } } },
      structured_output_required: false, mcp_servers: [], skills: [], multiagent: false, handoffs: false,
      metadata: { ...COMPLIANCE_OWNER, mode, foundry_app: foundryApp } };
    config.metadata!.config_hash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    return config;
  }
  const { system_file, rules_file } = doc;
  const system = `Mode: ${mode.toUpperCase()}.\n\n${await readFile(resolve(dirname(path), system_file), "utf8")}\n\n${await readFile(resolve(dirname(path), rules_file), "utf8")}`;
  const configs: NonNullable<AgentCreate["tools"]>["configs"] = { ...doc.tools.configs,
    apps: { enabled: true, permission: "deny", config: { allowed_apps: [foundryApp] } } };
  for (const name of ["foundry.list_pending", "foundry.review_context"]) configs[name] = { enabled: true, permission: "allow" };
  if (mode === "enforce") configs["foundry.review"] = { enabled: true, permission: "allow" };
  const config: AgentCreate = { name: doc.name, description: doc.description, model: doc.model, harness: "pi", window: "loose", system,
    budget: doc.budget, tools: { default_config: { permission: "deny" }, configs },
    output_schema: z.toJSONSchema(complianceReviewSchema), structured_output_required: true,
    mcp_servers: [], skills: [], multiagent: false, handoffs: false,
    metadata: { ...COMPLIANCE_OWNER, mode, foundry_app: foundryApp } };
  config.metadata!.config_hash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  return config;
}

export type ReviewTarget = { cluster_id: string; offer_id?: string };
export function validateReviewTarget(target?: ReviewTarget) {
  if (target && (!/^cl_[a-z0-9]+$/.test(target.cluster_id) || (target.offer_id !== undefined && !/^of_[a-z0-9]+$/.test(target.offer_id)))) throw new Error("Use actual cl_ and of_ IDs for a single review target.");
  return target;
}

export async function prepareComplianceRun(requestId: string, agent: { id: string; version: number; mode: ComplianceMode }, directory = resolve("var/compliance/requests"), target?: ReviewTarget): Promise<SessionCreate> {
  validateReviewTarget(target);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new Error("Request ID must be 8..100 letters, digits, underscores or hyphens.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${requestId}.json`);
  const request: SessionCreate = { agent_id: agent.id, agent_version: agent.version, window: "immediate", budget_micro_usd: COMPLIANCE_RUN_BUDGET,
    message: `${COMPLIANCE_TASK}\n${target ? `Review only this target: ${JSON.stringify(target)}.` : "Read list_pending with limit 1 and choose the first offer, otherwise the first cluster. If the queue is empty return assessment: null."}\nMode: ${agent.mode}. Current UTC: ${new Date().toISOString()}.`,
    metadata: { ...COMPLIANCE_OWNER, mode: agent.mode, request_id: requestId, ...(target ? { cluster_id: target.cluster_id, offer_id: target.offer_id ?? "" } : {}) } };
  try { await writeFile(path, JSON.stringify(request), { flag: "wx", mode: 0o600 }); return request; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const saved = JSON.parse(await readFile(path, "utf8")) as SessionCreate;
    if (saved.agent_id !== agent.id || saved.agent_version !== agent.version || saved.metadata?.mode !== agent.mode || saved.metadata?.cluster_id !== target?.cluster_id || (saved.metadata?.offer_id ?? "") !== (target?.offer_id ?? "") || saved.budget_micro_usd !== COMPLIANCE_RUN_BUDGET || saved.window !== "immediate") throw new Error("Request ID belongs to a different Compliance run.");
    return saved;
  }
}
