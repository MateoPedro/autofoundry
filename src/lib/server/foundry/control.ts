import { cookieFrom, gateSecret, isOperator, type GateEnv } from "../gate";
import { reconcile } from "./reconcile";
import { CREW_ROLES, ROLE_BUDGETS, type CrewRole } from "./roles";
import { setRunning } from "./state";
import { describe } from "./metrics";
import type { NaiveWriter, ToolContext } from "./tool";

// Only Scout (every 2 hours) and VC (every 5 minutes) run on schedules.
const SCHEDULED: CrewRole[] = ["scout", "vc"];
const ATTEMPTS = 3;

export type ControlReport = {
  running: boolean;
  budgets: { role: CrewRole; cap_micro_usd: number; ok: boolean }[];
  schedules: { id: string; enabled: boolean; ok: boolean }[];
  swept: Awaited<ReturnType<typeof reconcile>> | null;
  errors: string[];
};

type Crew = { role: CrewRole; agent_id: string }[];

async function crewOf(ctx: ToolContext): Promise<Crew> {
  return ctx.db.query<{ role: CrewRole; agent_id: string }>("select role, agent_id from crew order by role");
}

// Naïve answers 429 under load, so each call gets three tries.
async function attempt(ctx: ToolContext, report: ControlReport, what: string, call: () => Promise<unknown>): Promise<boolean> {
  for (let i = 1; ; i++) {
    try {
      await call();
      return true;
    } catch (error) {
      if ((error as { status?: number }).status === 429 && i < ATTEMPTS) {
        await (ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(1000 * i);
        continue;
      }
      report.errors.push(`${what}: ${describe(error)}`);
      return false;
    }
  }
}

async function setSchedules(ctx: ToolContext, naive: NaiveWriter, crew: Crew, enabled: boolean, report: ControlReport) {
  for (const member of crew.filter((m) => SCHEDULED.includes(m.role))) {
    let deployments: { id: string }[] = [];
    if (!(await attempt(ctx, report, `list ${member.role}'s schedules`, async () => (deployments = await naive.deploymentsOfAgent(member.agent_id))))) continue;
    for (const d of deployments) {
      const ok = await attempt(ctx, report, `${enabled ? "enable" : "disable"} ${member.role}'s schedule ${d.id}`, () => naive.setDeploymentEnabled(d.id, enabled));
      report.schedules.push({ id: d.id, enabled, ok });
    }
  }
}

function blank(running: boolean): ControlReport {
  return { running, budgets: [], schedules: [], swept: null, errors: [] };
}

// End: the company is marked stopped first, so no tool writes and no card is woken while the
// schedules and budgets wind down. A Naïve refusal is reported and End carries on.
export async function stop(ctx: ToolContext): Promise<ControlReport> {
  await setRunning(ctx.db, false, ctx.now());
  const report = blank(false);
  if (!ctx.naive) return { ...report, errors: ["the foundry has no NAIVE_WRITE_KEY, so budgets and schedules weren't touched"] };
  const naive = ctx.naive;
  const crew = await crewOf(ctx);
  await setSchedules(ctx, naive, crew, false, report);
  for (const member of crew) {
    const ok = await attempt(ctx, report, `zero ${member.role}'s budget`, () =>
      naive.setBudget(member.agent_id, { cap_micro_usd: 0, max_task_micro_usd: 0, period: "day" }),
    );
    report.budgets.push({ role: member.role, cap_micro_usd: 0, ok });
  }
  return report;
}

// Launch: budgets back, schedules on, parked cards resumed, then running and one sweep. If any of
// that fails, it stops again so nothing runs half set up.
export async function launch(ctx: ToolContext): Promise<ControlReport> {
  const report = blank(false);
  if (!ctx.naive) return { ...report, errors: ["the foundry has no NAIVE_WRITE_KEY; run pnpm foundry:key and redeploy"] };
  const naive = ctx.naive;
  const crew = await crewOf(ctx);
  const missing = CREW_ROLES.filter((role) => !crew.some((m) => m.role === role));
  if (missing.length) return { ...report, errors: [`the crew isn't set up (missing ${missing.join(", ")}); run pnpm crew setup`] };

  for (const member of crew) {
    const budget = { ...ROLE_BUDGETS[member.role], period: "day" as const };
    const ok = await attempt(ctx, report, `restore ${member.role}'s budget`, () => naive.setBudget(member.agent_id, budget));
    report.budgets.push({ role: member.role, cap_micro_usd: budget.cap_micro_usd, ok });
  }
  await setSchedules(ctx, naive, crew, true, report);
  // Naïve parks a card assigned to a zero-budget agent as blocked with nothing blocking it.
  for (const member of crew) {
    let cards: { id: string; board_id: string; status: string; blocked_by: string[] }[] = [];
    await attempt(ctx, report, `list ${member.role}'s cards`, async () => (cards = await naive.cardsOf(member.agent_id)));
    for (const card of cards.filter((c) => c.status === "blocked" && c.blocked_by.length === 0)) {
      await attempt(ctx, report, `resume card ${card.id}`, () => naive.setCardStatus(card.board_id, card.id, "todo"));
    }
  }
  if (report.errors.length) {
    const undone = await stop(ctx);
    return { ...report, running: false, errors: [...report.errors, ...undone.errors] };
  }

  await setRunning(ctx.db, true, ctx.now());
  try {
    report.swept = await reconcile(ctx);
  } catch (error) {
    report.errors.push(`the first sweep: ${describe(error)}; VC's next pass runs it again`);
  }
  return { ...report, running: true };
}

export async function controlResponse(request: Request, action: string, ctx: ToolContext, env: GateEnv) {
  if (action !== "launch" && action !== "stop") return Response.json({ error: "unknown action" }, { status: 404 });
  if (!isOperator(cookieFrom(request), gateSecret(env))) return Response.json({ error: "sign in as the operator first" }, { status: 401 });
  const report = action === "launch" ? await launch(ctx) : await stop(ctx);
  // The dashboard's buttons are plain forms, so they come back to the page.
  if ((request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    const query = new URLSearchParams({ control: action, ok: report.errors.length ? "0" : "1" });
    return new Response(null, { status: 303, headers: { location: `/?${query}` } });
  }
  return Response.json(report);
}
