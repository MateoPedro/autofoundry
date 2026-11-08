import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { loadScout, monidSourceContext, prepareRun, READ_TOOLS, saveSession, validateOutput } from "../scripts/scout-config";

const output = () => ({ batches: [{ cluster: { label: "SF businesses with a documented digital gap", source: "google_maps", unserved_score: 0.7 },
  leads: [{ name: "Example business (test fixture)", url: "https://example.com", contact_url: "https://example.com/contact", email: null,
    external_id: "fixture-place-id", data: { observed_at: "2026-11-07T23:00:00Z", discovery_query: "SF businesses",
      issues: ["Test fixture only"], evidence: [{ url: "https://example.com", observation: "Test evidence, not a real lead." }],
      buyer_type: "business", channel: "contact_form",
      revenue: { payer: "the business", offer: "rebuilt site", model: "one_time", price_usd: 99, channel: "contact_form, then email", channel_ready: true } } }] }], notes: [] });

test("Monid source ingestion rejects provider failures and strips bulky media while preserving provenance", () => {
  const source = { runId: "fixture-run", provider: "twitterdata.io", endpoint: "/tweets/search", status: "COMPLETED", providerResponse: { httpStatus: 200 },
    output: { data: [{ tweet_id: "123", url: "https://x.com/example/status/123", text: "a".repeat(3000), media: ["x".repeat(30000)] }] } };
  const context = JSON.parse(monidSourceContext(source));
  assert.equal(context.run_id, "fixture-run");
  assert.equal(context.posts[0].text.length, 2000);
  assert.equal(context.posts[0].text_truncated, true);
  assert.equal("media" in context.posts[0], false);
  assert.throws(() => monidSourceContext({ ...source, providerResponse: { httpStatus: 429 } }), /successful/);
  assert.throws(() => monidSourceContext({ ...source, providerResponse: {} }), /successful/);
  assert.throws(() => monidSourceContext({ ...source, status: "RUNNING" }), /successful/);
});

test("local Scout is read-only; Foundry mode grants exactly the contract's Scout tools", async () => {
  const local = await loadScout();
  assert.equal(local.tools?.default_config.permission, "deny");
  assert.deepEqual(Object.keys(local.tools!.configs).sort(), [...READ_TOOLS].sort());
  assert.deepEqual(local.budget, { cap_micro_usd: 3_000_000, max_task_micro_usd: 500_000, period: "day" });
  const foundry = await loadScout("app_fixture");
  assert.deepEqual(Object.keys(foundry.tools!.configs).sort(), [...READ_TOOLS, "apps", "foundry.add_leads", "foundry.list_clusters"].sort());
  assert.deepEqual(foundry.tools!.configs.apps.config, { allowed_apps: ["app_fixture"], edits_apps: false });
  assert.deepEqual(foundry.mcp_servers, []);
});

test("budget validation rejects USD confusion, oversized caps, fractions and invalid periods", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-config-"));
  try {
    const original = parse(await readFile("agents/scout.agent.yaml", "utf8"));
    original.system_file = resolve("agents/prompts/scout.md");
    original.output_schema_file = resolve("agents/scout-output.schema.json");
    for (const change of [ { cap_usd: 3 }, { cap_micro_usd: 3_000_001 }, { max_task_micro_usd: 300_000.5 }, { max_task_micro_usd: 600_000 }, { period: "month" } ]) {
      const path = join(dir, "scout.yaml");
      await writeFile(path, stringify({ ...original, budget: { ...original.budget, ...change } }));
      await assert.rejects(loadScout(undefined, path), /micro-USD|micro-USD fields/);
    }
    const path = join(dir, "scout.yaml");
    original.tools.configs["email.send"] = { enabled: true, permission: "allow" };
    await writeFile(path, stringify(original));
    await assert.rejects(loadScout(undefined, path), /Unexpected Scout tool/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("collector rejects duplicate identities, invalid contact URLs, invalid scores and missing evidence", () => {
  validateOutput(output());
  const utcOffset = output();
  utcOffset.batches[0].leads[0].data.observed_at = "2026-11-07T23:00:00+00:00";
  validateOutput(utcOffset);
  const mutations = [
    (o: ReturnType<typeof output>) => { o.batches[0].leads.push(o.batches[0].leads[0]); },
    (o: ReturnType<typeof output>) => { o.batches[0].cluster.unserved_score = NaN; },
    (o: ReturnType<typeof output>) => { o.batches[0].cluster.unserved_score = 1.01; },
    (o: ReturnType<typeof output>) => { o.batches[0].leads[0].contact_url = "javascript:submit()"; },
    (o: ReturnType<typeof output>) => { o.batches[0].leads[0].data.evidence = []; },
    (o: ReturnType<typeof output>) => { o.batches[0].leads[0].data.observed_at = "yesterday"; },
    (o: ReturnType<typeof output>) => { o.batches[0].leads[0].data.buyer_type = "person" as "business"; },
    (o: ReturnType<typeof output>) => { (o.batches[0].leads[0].data as Record<string, unknown>).revenue = { payer: "x" }; },
    (o: ReturnType<typeof output>) => { Object.assign(o.batches[0].leads[0].data, { buyer_type: "consumer" }); (o.batches[0].leads[0] as { email: string | null }).email = "someone@example.com"; },
    (o: ReturnType<typeof output>) => { o.batches[0].leads.push({ ...o.batches[0].leads[0], external_id: "x:1", data: { ...o.batches[0].leads[0].data, buyer_type: "consumer" } }); },
    (o: ReturnType<typeof output>) => { o.batches = Array.from({ length: 6 }, (_, i) => ({ ...o.batches[0], cluster: { ...o.batches[0].cluster, label: `c${i}` } })); },
  ];
  for (const mutate of mutations) { const o = output(); mutate(o); assert.throws(() => validateOutput(o), /invalid/); }
  const unreachable = output();
  Object.assign(unreachable.batches[0].leads[0], { contact_url: null, email: null });
  assert.throws(() => validateOutput(unreachable), /invalid/);
  validateOutput({ batches: [], notes: ["No source available; no leads fabricated."] });
});

test("only clean completed outputs are saved; replay is harmless and changed results cannot overwrite evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-output-"));
  try {
    const session = { id: "ses_fixture", agent_id: "agt_fixture", agent_version: 1, status: "idle" as const,
      stop_reason: "end_turn" as const, consumed_micro_usd: 24000, structured_output: output(), created_at: "2026-11-07T23:00:00Z" };
    const path = await saveSession(session, dir);
    assert.equal(await saveSession(session, dir), path);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.consumed_micro_usd, 24000);
    assert.deepEqual(saved.batches, output().batches);
    await assert.rejects(saveSession({ ...session, consumed_micro_usd: 25000 }, dir), /EEXIST/);
    await assert.rejects(saveSession({ ...session, stop_reason: "budget_paused" }, dir), /clean end_turn/);
    await assert.rejects(saveSession({ ...session, status: "running" }, dir), /clean end_turn/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("lost-response retries reuse the entire request, timestamp, version and micro-USD cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-request-"));
  try {
    const agent = { id: "agt_fixture", version: 1, mode: "local" };
    const request = await prepareRun("test-request-1", agent, "SF dentists", dir);
    const retry = await prepareRun("test-request-1", agent, "SF dentists", dir);
    assert.deepEqual(retry, request);
    assert.equal(retry.budget_micro_usd, 300000);
    await assert.rejects(prepareRun("test-request-1", agent, "Oakland bakeries", dir), /different Scout run/);
    await assert.rejects(prepareRun("test-request-1", { ...agent, version: 2 }, "SF dentists", dir), /different Scout run/);
    await assert.rejects(prepareRun("../../escape", agent, "SF dentists", dir), /Request ID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
