import { randomUUID } from "node:crypto";
import { naiveClient } from "./naive-client";
import { isParentRole, loadParent, PARENTS } from "./parent-config";

const USAGE = "pnpm parent <creator|vc|feedback> check | apply --foundry-app app_ID | run [--request-id ID] | status [--session ses_ID] | deploy";

async function main() {
  const [role = "", command = "check", ...args] = process.argv.slice(2);
  if (role === "--help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  const allowed: Record<string, string[]> = { check: [], apply: ["--foundry-app"], run: ["--request-id"], status: ["--session"], deploy: [] };
  if (!isParentRole(role) || !(command in allowed) || args.length % 2 || args.some((a, i) => i % 2 === 0 && !allowed[command].includes(a))) {
    throw new Error(`Unknown role, command or flag. ${USAGE}`);
  }
  const flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i], args[2 * i + 1]]));
  const spec = PARENTS[role];
  if (command === "apply" && !flags["--foundry-app"]) throw new Error(`${role} only works through the foundry tools; pass --foundry-app app_ID.`);
  const config = await loadParent(role, flags["--foundry-app"]);
  if (command === "check") {
    console.log(`${role} config valid: ${config.model}; cap ${config.budget.cap_micro_usd} micro-USD/day; run ${spec.runBudgetMicroUsd} micro-USD; tools ${spec.tools.join(", ")}.`);
    return;
  }

  const client = await naiveClient();
  // Paginate before matching names so apply cannot create a duplicate past page one.
  const matches = [];
  let after: string | undefined;
  do {
    const page = await client.agents.list({ limit: 100, after });
    matches.push(...page.data.filter((a) => a.name === role));
    after = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (after);
  if (matches.length > 1) throw new Error(`Multiple ${role} agents exist; resolve ownership before changing them.`);
  const existing = matches[0];
  if (existing && (existing.metadata.project !== "autofoundry" || existing.metadata.role !== role)) {
    throw new Error(`An existing ${role} is owned by another config; it was not changed.`);
  }

  if (command === "apply") {
    await client.models.retrieve(config.model);
    const app = await client.apps.get(flags["--foundry-app"]);
    if (app.name !== "foundry") throw new Error("The allowed app must be named foundry so tool names match the contract.");
    const agent = existing ? await client.agents.update(existing.id, { ...config, expected_version: existing.current_version }) : await client.agents.create(config);
    console.log(JSON.stringify({ agent_id: agent.id, name: agent.name, version: agent.current_version, model: agent.model, budget: agent.budget }));
    return;
  }
  if (!existing) throw new Error(`Run pnpm parent ${role} apply --foundry-app app_ID first.`);

  if (command === "run") {
    // The message holds no timestamp, so a retry with the same request ID sends an identical request.
    const requestId = flags["--request-id"] || randomUUID();
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new Error("Request ID must be 8..100 letters, digits, underscores or hyphens.");
    console.log(`${role} request ID: ${requestId}. Reuse it to retry a lost response.`);
    const session = await client.sessions.create(
      { agent_id: existing.id, agent_version: existing.current_version, window: "immediate", budget_micro_usd: spec.runBudgetMicroUsd,
        message: spec.task, metadata: { project: "autofoundry", role, request_id: requestId } },
      { idempotencyKey: `${role}-${requestId}` },
    );
    console.log(JSON.stringify({ request_id: requestId, session_id: session.id, status: session.status, budget_micro_usd: session.budget_micro_usd }));
    return;
  }

  if (command === "status") {
    const sessions = flags["--session"] ? [await client.sessions.get(flags["--session"])] : (await client.sessions.list({ agent_id: existing.id, limit: 10 })).data;
    for (const session of sessions) {
      if (session.agent_id !== existing.id) throw new Error(`Session does not belong to ${role}.`);
      console.log(JSON.stringify({ session_id: session.id, agent_version: session.agent_version, status: session.status, stop_reason: session.stop_reason,
        consumed_micro_usd: session.consumed_micro_usd, pending_tools: session.pending_actions.map((a) => a.name) }));
    }
    return;
  }

  const deployments = [];
  let cursor: string | undefined;
  do {
    const page = await client.deployments.list({ limit: 100, after: cursor });
    deployments.push(...page.data.filter((d) => d.agent_id === existing.id));
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  if (deployments.length > 1) throw new Error(`Multiple ${role} deployments exist; no schedules changed.`);
  const body = { agent_id: existing.id, agent_version: existing.current_version, cron: spec.cron, timezone: "UTC",
    window: "loose" as const, budget_micro_usd: spec.runBudgetMicroUsd, input_template: spec.task };
  const deployment = deployments[0] ? await client.deployments.update(deployments[0].id, body) : await client.deployments.create(body);
  console.log(JSON.stringify({ deployment_id: deployment.id, agent_id: deployment.agent_id, agent_version: deployment.agent_version,
    cron: deployment.cron, budget_micro_usd: deployment.budget_micro_usd, schedule_status: deployment.schedule_status, next_run_at: deployment.next_run_at }));
}

main().catch(async (error) => {
  const { ApiError } = await import("@usenaive-sdk/managed-agents");
  // Never expose raw provider errors or local credential contents.
  console.error(error instanceof ApiError ? `Request failed (HTTP ${error.status}, ${error.code}).` : error instanceof Error ? error.message : "Failed.");
  process.exitCode = 1;
});
