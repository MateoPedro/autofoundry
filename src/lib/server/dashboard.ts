import { sampleDetail, sampleMetrics } from "../dashboard/sample";
import type { CompanyDetail, Dashboard, Metrics } from "../dashboard/types";
import { pickFocus } from "../dashboard/view";
import { createPgDb } from "./db";
import { getCompany, getMetrics } from "./foundry/metrics";
import type { ToolContext } from "./foundry/tool";
import { createSpendSource } from "./naive";

let context: ToolContext | undefined;

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
    childTemplate: () => Promise.reject(new Error("the dashboard doesn't spawn")),
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
    return { source: "sample", metrics: sampleMetrics, focusId: focus?.id ?? null, detail: focus?.id === sampleDetail.company.id ? sampleDetail : null };
  }
  try {
    const metrics = (await getMetrics.run(ctx, getMetrics.input.parse({ companies_limit: 50, decisions_limit: 50 }))) as Metrics;
    const focus = pickFocus(metrics.companies, options.focus);
    const detail = focus
      ? ((await getCompany.run(ctx, getCompany.input.parse({ company_id: focus.id, leads_limit: 6, touches_per_lead: 5 }))) as CompanyDetail)
      : null;
    return { source: "live", metrics, focusId: focus?.id ?? null, detail };
  } catch (error) {
    console.error("dashboard load failed", error);
    return { source: "error", message: "The foundry database didn't answer. Details are in the app's logs." };
  }
}
