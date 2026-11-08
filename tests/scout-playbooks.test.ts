import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { planDeployments, PLAYBOOKS, playbookCron, playbookOf, playbookPrompt } from "../scripts/scout-playbooks";
import { RUN_BUDGET_MICRO_USD } from "../scripts/scout-config";

test("one Scout run every 3 hours, each playbook once a day, inside the daily cap", () => {
  const starts = PLAYBOOKS.map((_, i) => {
    const [minute, hour, ...rest] = playbookCron(i).split(" ");
    assert.deepEqual(rest, ["*", "*", "*"]);
    return Number(hour) * 60 + Number(minute);
  });
  assert.equal(new Set(starts).size, PLAYBOOKS.length);
  assert.ok(starts.every(m => m >= 0 && m < 24 * 60));
  assert.ok(starts.slice(1).every((m, i) => m - starts[i] === 180));
  assert.ok(24 * 60 - starts.at(-1)! + starts[0] === 180, "the gap across midnight is 3 hours too");
  assert.ok(starts.length * RUN_BUDGET_MICRO_USD <= 3_000_000, "even worst-case runs fit the daily cap");
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
