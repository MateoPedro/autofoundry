import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { foundryTools } from "../src/lib/server/foundry";
import { loadParent, PARENTS, type ParentRole } from "../scripts/parent-config";

const roles = Object.keys(PARENTS) as ParentRole[];

test("each parent allows exactly its contract tools, all of which the foundry serves", async () => {
  const served = foundryTools.map((t) => t.name);
  for (const role of roles) {
    const config = await loadParent(role);
    assert.equal(config.name, role);
    assert.equal(config.tools?.default_config.permission, "deny");
    assert.deepEqual(Object.keys(config.tools!.configs).sort(), PARENTS[role].tools.map((t) => `foundry.${t}`).sort());
    for (const tool of PARENTS[role].tools) assert.ok(served.includes(tool), `${role} allows foundry.${tool}, which the foundry doesn't serve`);
    assert.deepEqual(config.mcp_servers, []);
    assert.match(config.system ?? "", new RegExp(`^You are ${role},`));
  }
  assert.ok(!PARENTS.creator.tools.some((t) => ["fund", "kill", "review"].includes(t)), "Creator can't move money or review");
  assert.ok(!PARENTS.vc.tools.some((t) => ["spawn", "propose_offer", "review"].includes(t)), "VC can't create companies or review");
});

test("the foundry app scopes the apps tool without edit rights", async () => {
  const config = await loadParent("vc", "app_fixture");
  assert.deepEqual(config.tools!.configs.apps, { enabled: true, permission: "allow", config: { allowed_apps: ["app_fixture"], edits_apps: false } });
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
      for (const change of [{ cap_usd: 1 }, { cap_micro_usd: PARENTS[role].maxCapMicroUsd + 1 }, { max_task_micro_usd: 1000 }, { period: "month" }]) {
        await writeFile(path, stringify({ ...original, budget: { ...original.budget, ...change } }));
        await assert.rejects(loadParent(role, undefined, path), /micro-USD/);
      }
      await writeFile(path, stringify(withConfigs({ ...original.tools.configs, "email.send": { enabled: true, permission: "allow" } })));
      await assert.rejects(loadParent(role, undefined, path), /Unexpected/);
      const fewer = { ...original.tools.configs };
      delete fewer["foundry.get_metrics"];
      await writeFile(path, stringify(withConfigs(fewer)));
      await assert.rejects(loadParent(role, undefined, path), /exactly/);
      await writeFile(path, stringify(withConfigs({ ...original.tools.configs, "foundry.get_metrics": { enabled: true, permission: "ask" } })));
      await assert.rejects(loadParent(role, undefined, path), /Unexpected/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
