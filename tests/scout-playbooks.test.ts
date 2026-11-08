import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { planDeployments, PLAYBOOKS, playbookCron, playbookOf, playbookPrompt } from "../scripts/scout-playbooks";
import { RUN_BUDGET_MICRO_USD } from "../scripts/scout-config";

test("every cycle runs all 8 playbooks, 5 minutes apart, every 3 hours, inside the daily cap", () => {
  const minutes = PLAYBOOKS.map((_, i) => {
    const [minute, hour, ...rest] = playbookCron(i).split(" ");
    assert.equal(hour, "*/3");
    assert.deepEqual(rest, ["*", "*", "*"]);
    return Number(minute);
  });
  assert.deepEqual(minutes, [0, 5, 10, 15, 20, 25, 30, 35]);
  assert.ok(minutes.at(-1)! < 60, "a whole cycle starts within its first hour");
  const runsPerDay = PLAYBOOKS.length * (24 / 3);
  assert.equal(runsPerDay, 64);
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
  assert.equal(plan.upserts.length, PLAYBOOKS.length);
  assert.equal(plan.upserts.find(u => u.playbook === "maps")!.id, "dep_maps");
  assert.equal(plan.upserts.filter(u => u.id === null).length, PLAYBOOKS.length - 1);
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
