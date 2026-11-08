import assert from "node:assert/strict";
import test from "node:test";
import { controlResponse, launch, stop } from "../src/lib/server/foundry/control";
import { playbookPrompt } from "../src/lib/server/foundry/playbooks";
import { ROLE_BUDGETS } from "../src/lib/server/foundry/roles";
import { isRunning, setRunning } from "../src/lib/server/foundry/state";
import { operatorCookieValue } from "../src/lib/server/gate";
import { crewContext } from "./helpers/crew";
import { NOW, seedCluster, seedLead } from "./helpers/fixtures";

async function stopped() {
  const ctx = { ...(await crewContext()), sleep: async () => {} };
  for (const agent of ctx.naive.agents) agent.budget = { cap_micro_usd: 0, max_task_micro_usd: 0, period: "day" };
  ctx.naive.addDeployment("scout", false, playbookPrompt("maps", "foundry"));
  ctx.naive.addDeployment("vc", false);
  await setRunning(ctx.db, false, NOW);
  return ctx;
}

test("launch restores the crew's budgets, enables the two schedules, runs the sweep and marks the company running", async () => {
  const ctx = await stopped();
  await seedLead(ctx.db, await seedCluster(ctx.db, "queued"), { name: "free" });
  ctx.naive.cards.push({ id: "crd_parked", board_id: ctx.naive.agent("closer").board_id, status: "blocked", blocked_by: [], title: "Deliver x", body: "", assignee: "closer", key: "k" });

  const report = await launch(ctx);

  assert.equal(report.running, true);
  assert.deepEqual(report.errors, []);
  assert.equal(await isRunning(ctx.db), true);
  for (const agent of ctx.naive.agents) assert.deepEqual(agent.budget, { ...ROLE_BUDGETS[agent.name as keyof typeof ROLE_BUDGETS], period: "day" }, agent.name);
  assert.ok(ctx.naive.deployments.every((d) => d.enabled));
  assert.equal(ctx.naive.cards.find((c) => c.id === "crd_parked")!.status, "todo");
  assert.equal(report.swept?.created.design, 1);
});

test("stop marks the company stopped before anything else, disables schedules and zeroes every cap", async () => {
  const ctx = await stopped();
  await launch(ctx);
  ctx.naive.calls = [];
  let runningAtFirstCall: boolean | null = null;
  const setBudget = ctx.naive.setBudget.bind(ctx.naive);
  ctx.naive.setBudget = async (id, budget) => {
    runningAtFirstCall ??= await isRunning(ctx.db);
    return setBudget(id, budget);
  };

  const report = await stop(ctx);

  assert.equal(report.running, false);
  assert.equal(runningAtFirstCall, false);
  assert.ok(ctx.naive.deployments.every((d) => !d.enabled));
  assert.ok(ctx.naive.agents.every((a) => a.budget.cap_micro_usd === 0 && a.budget.max_task_micro_usd === 0));
  assert.equal(report.budgets.length, 7);
});

test("stop reports what Naïve refused but still leaves the company stopped", async () => {
  const ctx = await stopped();
  await launch(ctx);
  ctx.naive.failBudgetFor.add("closer");
  const report = await stop(ctx);
  assert.equal(await isRunning(ctx.db), false);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /closer/);
  assert.equal(report.budgets.find((b) => b.role === "closer")!.ok, false);
  assert.ok(ctx.naive.agents.filter((a) => a.name !== "closer").every((a) => a.budget.cap_micro_usd === 0));
});

test("a Naïve call answering 429 is retried", async () => {
  const ctx = await stopped();
  ctx.naive.rateLimitOnce.add("vc");
  const report = await launch(ctx);
  assert.deepEqual(report.errors, []);
  assert.equal(ctx.naive.agent("vc").budget.cap_micro_usd, ROLE_BUDGETS.vc.cap_micro_usd);
});

test("a launch that can't restore every budget stops again and says why", async () => {
  const ctx = await stopped();
  ctx.naive.failBudgetFor.add("scout");
  const report = await launch(ctx);
  assert.equal(report.running, false);
  assert.equal(await isRunning(ctx.db), false);
  assert.match(report.errors.join("\n"), /scout/);
  assert.ok(ctx.naive.deployments.every((d) => !d.enabled));
  assert.ok(ctx.naive.agents.every((a) => a.budget.cap_micro_usd === 0));
});

test("the control routes refuse a request without the operator cookie", async () => {
  const ctx = await stopped();
  const env = { DASHBOARD_PASSWORD: "correct horse" };
  const post = (cookie?: string) =>
    controlResponse(new Request("https://foundry.test/api/control/launch", { method: "POST", headers: cookie ? { cookie } : {} }), "launch", ctx, env);
  assert.equal((await post()).status, 401);
  assert.equal((await post("foundry_operator=guess")).status, 401);
  assert.equal(await isRunning(ctx.db), false);

  const ok = await post(`foundry_operator=${operatorCookieValue("correct horse")}`);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { running: boolean }).running, true);
  const unknown = await controlResponse(new Request("https://foundry.test/api/control/x", { method: "POST" }), "x", ctx, env);
  assert.equal(unknown.status, 404);
});

test("launch turns on only the scheduled Scout playbooks", async () => {
  const ctx = await stopped();
  ctx.naive.addDeployment("scout", false, playbookPrompt("reddit", "foundry"));
  ctx.naive.addDeployment("scout", false, "Run one bounded scouting pass in foundry mode.");
  await launch(ctx);
  assert.deepEqual(ctx.naive.deployments.map((d) => d.enabled), [true, true, false, false]);
});

test("launch marks the company running before it resumes parked cards", async () => {
  const ctx = await stopped();
  ctx.naive.cards.push({ id: "crd_p", board_id: ctx.naive.agent("outreach").board_id, status: "blocked", blocked_by: [], title: "Contact x", body: "", assignee: "outreach", key: "k" });
  let runningWhenResumed: boolean | null = null;
  const set = ctx.naive.setCardStatus.bind(ctx.naive);
  ctx.naive.setCardStatus = async (...args) => {
    runningWhenResumed = await isRunning(ctx.db);
    return set(...args);
  };
  await launch(ctx);
  assert.equal(runningWhenResumed, true);
});
