import { sampleAgents, sampleDetail, sampleMetrics, sampleTargets } from "../dashboard/sample";
import type { AgentsView, CompanyDetail, Dashboard, Metrics } from "../dashboard/types";
import { pickFocus } from "../dashboard/view";
import { createPgDb } from "./db";
import { agentActivity, decisionTargets } from "./foundry/activity";
import { getCompany, getMetrics } from "./foundry/metrics";
import { stateOf } from "./foundry/state";
import type { ToolContext } from "./foundry/tool";
import { createSpendSource } from "./naive";

let context: ToolContext | undefined;

// MCP serializes tool results as JSON, turning database Dates into ISO strings. The
// dashboard calls the tools directly, so give its views the same wire-format data.
function jsonData<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// A read-only context: the dashboard can sync spend but holds no Naïve writer, so nothing it
// calls can spawn, fund or kill. Null outside the deployed foundry app, where there's no database.
function dashboardContext(): ToolContext | null {
  if (context) return context;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  context = {
    db: createPgDb(url),
    spend: createSpendSource(process.env),
    naive: null,
    payments: null,
    appUrl: "",
    now: () => new Date(),
  };
  return context;
}

// The dashboard calls the same get_metrics and get_company the agents call, in process, with
// larger limits than an agent's 8,000-character result allows.
export async function loadDashboard(
  options: { focus?: string | null; sample?: boolean },
  ctx: ToolContext | null = dashboardContext(),
): Promise<Dashboard> {
  if (options.sample || !ctx) {
    // Show the contract's sample, labeled as sample on the page.
    const focus = pickFocus(sampleMetrics.companies, options.focus);
    return {
      source: "sample",
      metrics: sampleMetrics,
      focusId: focus?.id ?? null,
      detail: focus?.id === sampleDetail.company.id ? sampleDetail : null,
      agents: sampleAgents,
      targets: sampleTargets,
      running: null,
    };
  }
  try {
    const metrics = jsonData<Metrics>(await getMetrics.run(ctx, getMetrics.input.parse({ companies_limit: 50, decisions_limit: 50 })));
    const focus = pickFocus(metrics.companies, options.focus);
    const detail = focus
      ? jsonData<CompanyDetail>(await getCompany.run(ctx, getCompany.input.parse({ company_id: focus.id, leads_limit: 6, touches_per_lead: 5 })))
      : null;
    const agents = jsonData<AgentsView>(await agentActivity(ctx.db, ctx.now()));
    const targets = await decisionTargets(ctx.db, metrics.decisions);
    const { running } = await stateOf(ctx.db);
    return { source: "live", metrics, focusId: focus?.id ?? null, detail, agents, targets, running };
  } catch (error) {
    console.error("dashboard load failed", error);
    return { source: "error", message: "The foundry database didn't answer. Details are in the app's logs." };
  }
}
