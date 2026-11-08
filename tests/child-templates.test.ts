import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fillAgent, loadChildTemplate } from "../src/lib/server/foundry/templates";
import { CHILD_TEMPLATE_DIR } from "./helpers/fixtures";

async function copyFixture() {
  const dir = await mkdtemp(join(tmpdir(), "child-template-"));
  await cp(CHILD_TEMPLATE_DIR, dir, { recursive: true });
  return dir;
}

test("fillAgent fills in one pass, so offer text keeps its own placeholders", async () => {
  const template = await loadChildTemplate(CHILD_TEMPLATE_DIR);
  const values = Object.fromEntries(
    ["company_id", "slug", "inbox", "app_id", "app_url", "buyer", "sample", "product", "price", "channel", "delivery", "follow_up_message"].map((k) => [k, k.toUpperCase()]),
  ) as Record<string, string>;
  const filled = fillAgent(template.outreach, { ...values, outreach_message: "Hi {{lead_name}}: {{sample_url}} ({{slug}})" } as never);
  assert.equal(filled.system, "Send exactly this through CHANNEL: Hi {{lead_name}}: {{sample_url}} ({{slug}})\nFollow up once: FOLLOW_UP_MESSAGE\n");
  assert.equal(filled.name, "SLUG-outreach");
});

test("a template with a placeholder outside the contract's list is refused", async () => {
  const dir = await copyFixture();
  await writeFile(join(dir, "prompts/closer.md"), "Answer on {{inbox}} as {{persona}}.");
  await assert.rejects(loadChildTemplate(dir), /unknown placeholder \{\{persona\}\}/);
});

test("a template without default deny is refused", async () => {
  const dir = await copyFixture();
  await writeFile(join(dir, "agents/builder.agent.yaml"), "model: m\nsystem: hi\ntools: { default_config: { permission: allow } }\n");
  await assert.rejects(loadChildTemplate(dir), /permission must be deny/);
});
