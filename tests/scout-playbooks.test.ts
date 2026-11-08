import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CYCLE_HOURS, planDeployments, PLAYBOOKS, playbookCron, playbookDeployment, playbookOf, playbookPrompt, SCHEDULED_PLAYBOOKS } from "../scripts/scout-playbooks";
import { RUN_BUDGET_MICRO_USD } from "../scripts/scout-config";
import { CYCLE_HOURS as FOUNDRY_CYCLE_HOURS, RUNS_PER_CYCLE } from "../src/lib/server/foundry/cycle";

test("a cycle is two hours, with the four playbooks at :00, :05, :10 and :15, inside the daily cap", () => {
  assert.deepEqual([...SCHEDULED_PLAYBOOKS], ["maps", "reviews", "appstore", "jobs"]);
  assert.deepEqual(SCHEDULED_PLAYBOOKS.map((_, i) => playbookCron(i)), ["0 */2 * * *", "5 */2 * * *", "10 */2 * * *", "15 */2 * * *"]);
  assert.equal(CYCLE_HOURS, 2);
  assert.equal(FOUNDRY_CYCLE_HOURS, 2);
  const runsPerDay = SCHEDULED_PLAYBOOKS.length * (24 / CYCLE_HOURS);
  assert.equal(runsPerDay, 48);
  // Typical passes cost ~191,000 micro-USD (verified Nov 8); the agent's daily cap must hold them.
  assert.ok(runsPerDay * 191_000 <= 15_000_000);
  assert.ok(RUN_BUDGET_MICRO_USD <= 500_000);
});

test("the prompt names the playbook and round-trips; unrelated prompts are not playbooks", () => {
  for (const p of PLAYBOOKS) assert.equal(playbookOf(playbookPrompt(p, "foundry")), p);
  assert.equal(playbookOf("Run one bounded scouting pass in foundry mode."), null);
  assert.equal(playbookOf("Playbook: unknown\nRun"), null);
});

test("deploy updates existing playbook schedules, creates missing ones and turns off the old generic cron", () => {
  const plan = planDeployments([
    { id: "dep_maps", input_template: playbookPrompt("maps", "foundry"), enabled: false },
    { id: "dep_old", input_template: "Run one bounded scouting pass in foundry mode.", enabled: true },
    { id: "dep_off", input_template: "something already off", enabled: false },
  ]);
  assert.deepEqual(plan.upserts.map(u => u.playbook), [...SCHEDULED_PLAYBOOKS]);
  assert.equal(plan.upserts.find(u => u.playbook === "maps")!.id, "dep_maps");
  assert.equal(plan.upserts.filter(u => u.id === null).length, SCHEDULED_PLAYBOOKS.length - 1);
  assert.deepEqual(plan.disable, ["dep_old"]);
  assert.throws(() => planDeployments([
    { id: "a", input_template: playbookPrompt("jobs", "foundry"), enabled: true },
    { id: "b", input_template: playbookPrompt("jobs", "foundry"), enabled: true },
  ]), /Two Scout deployments run the jobs playbook/);
});

test("Scout's prompt documents every scheduled playbook and the Foundry dedup check", async () => {
  const prompt = await readFile("agents/prompts/scout.md", "utf8");
  for (const p of PLAYBOOKS) assert.match(prompt, new RegExp(`- \\*\\*${p}\\*\\* \\(`), `missing playbook ${p}`);
  assert.match(prompt, /foundry\.list_clusters three times, with review_status rejected, approved and pending/);
  // Scheduled playbooks reach Monid only through the foundry's capped monid_read tool.
  assert.match(prompt, /foundry\.monid_read/);
  assert.doesNotMatch(prompt, /monid_run|mcp\.monid\.ai/);
});

test("deploy turns off a schedule still running a paused playbook, and leaves paused ones off", () => {
  const plan = planDeployments([
    { id: "dep_reddit", input_template: playbookPrompt("reddit", "foundry"), enabled: true },
    { id: "dep_posts", input_template: playbookPrompt("consumer_posts", "foundry"), enabled: false },
    { id: "dep_jobs", input_template: playbookPrompt("jobs", "foundry"), enabled: true },
  ]);
  assert.deepEqual(plan.disable, ["dep_reddit"]);
  assert.ok(!plan.upserts.some(u => ["reddit", "consumer_posts", "app_wishes", "agents"].includes(u.playbook)));
  assert.equal(plan.upserts.find(u => u.playbook === "jobs")!.id, "dep_jobs");
});

test("Compliance waits for as many Scout runs as are scheduled each cycle", () => {
  assert.equal(RUNS_PER_CYCLE, SCHEDULED_PLAYBOOKS.length);
  assert.ok(PLAYBOOKS.length > SCHEDULED_PLAYBOOKS.length, "paused playbooks stay available for manual runs");
});

test("deploy bodies are created disabled", () => {
  const body = playbookDeployment({ id: "agt_scout", current_version: 3 }, "maps", playbookCron(0), "foundry", "https://foundry.test/api/scout-idle?token=t");
  assert.equal(body.enabled, false);
  assert.equal(body.cron, "0 */2 * * *");
  assert.equal(body.agent_version, 3);
});
