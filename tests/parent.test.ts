import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { foundryTools } from "../src/lib/server/foundry";
import { loadParent, parentDeployment, PARENTS, type ParentRole } from "../scripts/parent-config";
import { CREW_ROLES, ROLE_BUDGETS } from "../src/lib/server/foundry/roles";

const roles = Object.keys(PARENTS) as ParentRole[];

test("each parent allows exactly its contract tools, all of which the foundry serves", async () => {
  const served = foundryTools.map((t) => t.name);
  for (const role of roles) {
    const config = await loadParent(role);
    assert.equal(config.name, role);
    assert.equal(config.tools?.default_config.permission, "deny");
    const expected = [...PARENTS[role].foundryTools.map((t) => `foundry.${t}`), ...Object.keys(PARENTS[role].extraTools)];
    assert.deepEqual(Object.keys(config.tools!.configs).sort(), expected.sort());
    for (const tool of PARENTS[role].foundryTools) assert.ok(served.includes(tool), `${role} allows foundry.${tool}, which the foundry doesn't serve`);
    assert.deepEqual(config.mcp_servers, []);
    assert.match(config.system ?? "", new RegExp(`^You are ${role},`));
  }
  assert.ok(!PARENTS.creator.foundryTools.some((t) => ["fund", "kill", "review"].includes(t)), "Creator can't move money or review");
  assert.ok(!PARENTS.vc.foundryTools.some((t) => ["spawn", "propose_offer", "review"].includes(t)), "VC can't create companies or review");
  assert.ok(!PARENTS.feedback.foundryTools.some((t) => ["fund", "kill", "spawn", "add_leads", "review"].includes(t)), "Feedback only reads and writes Scout's memory");
});

// Naïve ignores edits_apps (contract section 4), so the apps tool is denied; allowed_apps alone exposes foundry.* tools.
test("the foundry app is reachable only through its foundry tools", async () => {
  const config = await loadParent("vc", "app_fixture");
  assert.deepEqual(config.tools!.configs.apps, { enabled: true, permission: "deny", config: { allowed_apps: ["app_fixture"] } });
  await assert.rejects(loadParent("vc", "foundry"), /app_ ID/);
});

test("config validation rejects USD fields, oversized caps, extra tools, missing tools and ask permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "parent-config-"));
  try {
    for (const role of roles) {
      const original = parse(await readFile(`agents/${role}.agent.yaml`, "utf8"));
      original.system_file = resolve(`agents/prompts/${role}.md`);
      const path = join(dir, `${role}.yaml`);
      const withConfigs = (configs: Record<string, unknown>) => ({ ...original, tools: { ...original.tools, configs } });
      for (const change of [{ cap_usd: 1 }, { cap_micro_usd: ROLE_BUDGETS[role].cap_micro_usd + 1 }, { max_task_micro_usd: 1000 }, { period: "month" }]) {
        await writeFile(path, stringify({ ...original, budget: { ...original.budget, ...change } }));
        await assert.rejects(loadParent(role, undefined, path), /micro-USD/);
      }
      await writeFile(path, stringify(withConfigs({ ...original.tools.configs, "email.read": { enabled: true, permission: "allow" } })));
      await assert.rejects(loadParent(role, undefined, path), /Unexpected/);
      const first = `foundry.${PARENTS[role].foundryTools[0]}`;
      const fewer = { ...original.tools.configs };
      delete fewer[first];
      await writeFile(path, stringify(withConfigs(fewer)));
      await assert.rejects(loadParent(role, undefined, path), /exactly/);
      await writeFile(path, stringify(withConfigs({ ...original.tools.configs, [first]: { enabled: true, permission: "ask" } })));
      await assert.rejects(loadParent(role, undefined, path), /Unexpected/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every role's yaml budget matches ROLE_BUDGETS", async () => {
  for (const role of CREW_ROLES) {
    const doc = parse(await readFile(`agents/${role}.agent.yaml`, "utf8"));
    assert.deepEqual(doc.budget, { ...ROLE_BUDGETS[role], period: "day" }, role);
  }
});

test("outreach and closer load with exactly their tools", async () => {
  const closer = await loadParent("closer", "app_x");
  const tools = Object.keys(closer.tools!.configs).sort();
  assert.deepEqual(tools, [...PARENTS.closer.foundryTools.map((t) => `foundry.${t}`), "email.inboxes", "email.send", "apps"].sort());
  assert.ok(!tools.includes("email.read"));
  assert.equal(closer.window, "immediate");
  const outreach = await loadParent("outreach", "app_x");
  assert.deepEqual(outreach.tools!.configs.browser, { enabled: true, permission: "allow", config: { allow_writes: true } });
  assert.equal(outreach.window, "loose");
});

test("only vc has a schedule", () => {
  const scheduled = Object.entries(PARENTS).filter(([, spec]) => spec.cron).map(([role, spec]) => [role, spec.cron]);
  assert.deepEqual(scheduled, [["vc", "*/5 * * * *"]]);
});

test("crew prompts carry no template placeholders", async () => {
  // {{lead_name}} and {{sample_url}} are the offer's own tokens, which Outreach fills per lead.
  for (const role of ["outreach", "closer"]) {
    const prompt = (await readFile(`agents/prompts/${role}.md`, "utf8")).replaceAll("{{lead_name}}", "").replaceAll("{{sample_url}}", "");
    assert.doesNotMatch(prompt, /\{\{\w+\}\}/, role);
  }
});

test("vc's schedule is created disabled, every five minutes", () => {
  const body = parentDeployment({ id: "agt_vc", current_version: 2 }, "vc");
  assert.deepEqual({ cron: body.cron, enabled: body.enabled, window: body.window }, { cron: "*/5 * * * *", enabled: false, window: "loose" });
  assert.throws(() => parentDeployment({ id: "agt_f", current_version: 1 }, "feedback"), /no schedule/);
});
