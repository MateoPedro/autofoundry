import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import type { AgentCreate } from "@usenaive-sdk/managed-agents";

// Each parent agent allows only its own tools from docs/foundry-contract.md, section 5.
export const PARENTS = {
  creator: {
    tools: ["list_clusters", "list_offers", "review_context", "propose_offer", "spawn", "log_decision", "get_metrics", "get_company"],
    maxCapMicroUsd: 2_000_000,
    runBudgetMicroUsd: 200_000,
    cron: "0 * * * *",
    task: "Run one Creator pass: spawn approved offers, then propose offers for approved clusters nobody serves.",
  },
  funder: {
    tools: ["list_clusters", "fund", "kill", "log_decision", "get_metrics", "get_company"],
    maxCapMicroUsd: 1_000_000,
    runBudgetMicroUsd: 100_000,
    cron: "30 * * * *",
    task: "Run one Funder pass: kill companies that can't convert, grant more to ones that do, then make first grants.",
  },
} as const;

export type ParentRole = keyof typeof PARENTS;

export function isParentRole(role: string): role is ParentRole {
  return Object.hasOwn(PARENTS, role);
}

export async function loadParent(role: ParentRole, foundryApp?: string, path = resolve(`agents/${role}.agent.yaml`)): Promise<AgentCreate> {
  const spec = PARENTS[role];
  const doc = parse(await readFile(path, "utf8"));
  const budget = doc.budget ?? {};
  if ("cap_usd" in budget || "max_task_usd" in budget) throw new Error(`Use API micro-USD fields in ${role}'s config.`);
  const cap = budget.cap_micro_usd;
  const task = budget.max_task_micro_usd;
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > spec.maxCapMicroUsd || !Number.isSafeInteger(task) || task < spec.runBudgetMicroUsd || task > cap || budget.period !== "day") {
    throw new Error(`${role} budgets must be integer micro-USD: daily cap <= ${spec.maxCapMicroUsd}, task cap ${spec.runBudgetMicroUsd}..cap.`);
  }
  if (doc.name !== role || doc.harness !== "pi" || !doc.model || doc.tools?.default_config?.permission !== "deny") {
    throw new Error(`${role} must use name ${role}, harness pi, a model, and default deny.`);
  }
  const expected = spec.tools.map((t) => `foundry.${t}`);
  const configs = Object.entries(doc.tools.configs ?? {}) as [string, { enabled: boolean; permission: string }][];
  for (const [name, settings] of configs) {
    if (!expected.includes(name) || settings.enabled !== true || settings.permission !== "allow") throw new Error(`Unexpected ${role} tool: ${name}`);
  }
  if (configs.length !== expected.length) throw new Error(`${role} must allow exactly ${expected.join(", ")}.`);
  if (doc.mcp_servers?.length || doc.skills?.length || doc.multiagent || doc.handoffs) throw new Error(`${role} cannot delegate or load extra tools.`);
  if (doc.metadata?.project !== "autofoundry" || doc.metadata?.role !== role) throw new Error(`${role} needs metadata { project: autofoundry, role: ${role} }.`);

  const { system_file, ...config } = doc;
  const system = await readFile(resolve(dirname(path), system_file), "utf8");
  if (foundryApp) {
    if (!/^app_[a-z0-9]+$/.test(foundryApp)) throw new Error("--foundry-app must be the verified app_ ID.");
    config.tools.configs.apps = { enabled: true, permission: "allow", config: { allowed_apps: [foundryApp], edits_apps: false } };
  }
  return { ...config, system, mcp_servers: [], skills: [], multiagent: false, handoffs: false };
}
