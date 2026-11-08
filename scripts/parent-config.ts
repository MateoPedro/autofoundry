import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import type { AgentCreate } from "@usenaive-sdk/managed-agents";
import { ROLE_BUDGETS, type CrewRole } from "../src/lib/server/foundry/roles";

// Each crew agent allows only its own tools from docs/foundry-contract.md, section 5. Budgets come from ROLE_BUDGETS.
type Spec = {
  foundryTools: readonly string[];
  extraTools: Record<string, { enabled: true; permission: "allow"; config?: Record<string, unknown> }>;
  window: "loose" | "immediate";
  cron: string | null;
  runBudgetMicroUsd: number;
  task: string;
};

const allow = { enabled: true, permission: "allow" } as const;

export const PARENTS = {
  creator: {
    foundryTools: ["list_clusters", "list_offers", "review_context", "propose_offer", "spawn", "find_lead", "publish_sample", "log_touch", "log_decision", "get_metrics", "get_company"],
    extraTools: { web_fetch: allow },
    window: "loose",
    cron: null,
    runBudgetMicroUsd: 300_000,
    task: "Run one Creator pass: spawn approved offers, then propose offers for approved clusters nobody serves.",
  },
  // The five-minute sweep: reconcile hands out missed work, then VC funds and kills.
  vc: {
    foundryTools: ["reconcile", "list_clusters", "fund", "kill", "log_decision", "get_metrics", "get_company"],
    extraTools: {},
    window: "loose",
    cron: "*/5 * * * *",
    runBudgetMicroUsd: 300_000,
    task: "Run one VC pass: hand out waiting work with foundry.reconcile, kill companies that can't convert, grant more to ones that do, then make first grants.",
  },
  feedback: {
    foundryTools: ["feedback_context", "scout_memory", "write_feedback", "compact_feedback", "get_metrics"],
    extraTools: {},
    window: "loose",
    cron: null,
    runBudgetMicroUsd: 300_000,
    task: "Run one Feedback pass: turn VC's new fund and kill decisions into a short note for Scout's memory, and compact it at 10 notes.",
  },
  outreach: {
    foundryTools: ["find_lead", "get_company", "log_touch"],
    extraTools: { "email.inboxes": allow, "email.send": allow, browser: { ...allow, config: { allow_writes: true } } },
    window: "loose",
    cron: null,
    runBudgetMicroUsd: 300_000,
    task: "Contact the lead named in your card.",
  },
  // Replies wake the Closer the moment they arrive; immediate keeps the answer from queueing.
  closer: {
    foundryTools: ["find_lead", "get_company", "log_touch", "checkout_link", "publish_sample", "dismiss_inbound", "read_inbound"],
    extraTools: { "email.inboxes": allow, "email.send": allow },
    window: "immediate",
    cron: null,
    runBudgetMicroUsd: 300_000,
    task: "Answer the email or deliver the order named in your card.",
  },
} as const satisfies Record<Exclude<CrewRole, "scout" | "compliance">, Spec>;

export type ParentRole = keyof typeof PARENTS;

export function isParentRole(role: string): role is ParentRole {
  return Object.hasOwn(PARENTS, role);
}

export async function loadParent(role: ParentRole, foundryApp?: string, path = resolve(`agents/${role}.agent.yaml`)): Promise<AgentCreate> {
  const spec = PARENTS[role];
  const doc = parse(await readFile(path, "utf8"));
  const budget = doc.budget ?? {};
  if ("cap_usd" in budget || "max_task_usd" in budget) throw new Error(`Use API micro-USD fields in ${role}'s config.`);
  const want = ROLE_BUDGETS[role];
  if (budget.cap_micro_usd !== want.cap_micro_usd || budget.max_task_micro_usd !== want.max_task_micro_usd || budget.period !== "day") {
    throw new Error(`${role} budget must be micro-USD { cap_micro_usd: ${want.cap_micro_usd}, max_task_micro_usd: ${want.max_task_micro_usd}, period: day }.`);
  }
  if (doc.name !== role || doc.harness !== "pi" || !doc.model || doc.window !== spec.window || doc.tools?.default_config?.permission !== "deny") {
    throw new Error(`${role} must use name ${role}, harness pi, a model, window ${spec.window}, and default deny.`);
  }
  const expected: Record<string, unknown> = { ...Object.fromEntries(spec.foundryTools.map((t) => [`foundry.${t}`, allow])), ...spec.extraTools };
  const configs = Object.entries(doc.tools.configs ?? {});
  for (const [name, settings] of configs) {
    if (!(name in expected) || !isDeepStrictEqual(settings, expected[name])) throw new Error(`Unexpected ${role} tool: ${name}`);
  }
  if (configs.length !== Object.keys(expected).length) throw new Error(`${role} must allow exactly ${Object.keys(expected).join(", ")}.`);
  if (doc.mcp_servers?.length || doc.skills?.length || doc.multiagent || doc.handoffs) throw new Error(`${role} cannot delegate or load extra tools.`);
  if (doc.metadata?.project !== "autofoundry" || doc.metadata?.role !== role) throw new Error(`${role} needs metadata { project: autofoundry, role: ${role} }.`);

  const { system_file, ...config } = doc;
  const system = await readFile(resolve(dirname(path), system_file), "utf8");
  if (foundryApp) {
    if (!/^app_[a-z0-9]+$/.test(foundryApp)) throw new Error("--foundry-app must be the verified app_ ID.");
    // Naïve ignores edits_apps (contract section 4), so the apps tool is denied; allowed_apps alone exposes the foundry.* tools.
    config.tools.configs.apps = { enabled: true, permission: "deny", config: { allowed_apps: [foundryApp] } };
  }
  return { ...config, system, mcp_servers: [], skills: [], multiagent: false, handoffs: false };
}
