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

const FOUNDRY_APP = "app_f27yeve1gzgmztexhf9d0wbx62";
const VALUES = {
  company_id: "co_test",
  slug: "co-01",
  inbox: "co-01@auto-foundry-03s9ve.usenaive.ai",
  app_id: "app_child",
  app_url: "https://co-01.example",
  buyer: "SF dental practices",
  sample: "a rebuilt one-page site",
  product: "that site on your domain",
  price: "$99",
  channel: "contact_form",
  delivery: "a link by email",
  outreach_message: "Hi {{lead_name}}, I'm an AI agent. I rebuilt your site: {{sample_url}}",
  follow_up_message: "Following up once on {{sample_url}}.",
};

type Configs = Record<string, { permission: string; config?: Record<string, unknown> }>;

test("the real child templates load, fill every placeholder, and keep the apps tool's own actions denied", async () => {
  const template = await loadChildTemplate();
  for (const role of ["builder", "outreach", "closer"] as const) {
    const filled = fillAgent(template[role], VALUES);
    const text = JSON.stringify(filled);
    assert.deepEqual([...new Set(text.match(/\{\{\w+\}\}/g))].sort(), role === "outreach" ? ["{{lead_name}}", "{{sample_url}}"] : [], role);
    const configs = (filled.tools as { configs: Configs }).configs;
    assert.equal(configs.apps.permission, "deny", role);
    assert.deepEqual(configs.apps.config?.allowed_apps, [FOUNDRY_APP], role);
    for (const tool of ["foundry.log_touch", "foundry.find_lead", "foundry.get_company", "foundry.get_metrics"]) assert.equal(configs[tool]?.permission, "allow", `${role} ${tool}`);
    assert.ok(!Object.values(configs).some((c) => c.permission === "ask"), role);
  }
  const outreach = (fillAgent(template.outreach, VALUES).tools as { configs: Configs }).configs;
  assert.equal(outreach["email.send"].permission, "allow");
  assert.equal(outreach.browser.config?.allow_writes, true);
  assert.equal(outreach["foundry.follow_ups_due"].permission, "allow");
  const closer = fillAgent(template.closer, VALUES);
  assert.equal(closer.window, "immediate");
  assert.equal((closer.tools as { configs: Configs }).configs["foundry.checkout_link"].permission, "allow");
  assert.match(String(fillAgent(template.outreach, VALUES).system), /Hi \{\{lead_name\}\}, I'm an AI agent\. I rebuilt your site: \{\{sample_url\}\}/);
});
