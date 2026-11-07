import assert from "node:assert/strict";
import test from "node:test";
import { addLeads, findLead, listClusters, logTouch } from "../src/lib/server/foundry/leads";
import { run, seedCluster, seedCompany, seedLead, testContext } from "./helpers/fixtures";

const cluster = { label: "SF dentists with outdated sites", source: "google_maps", unserved_score: 0.8 };
const lead = (name: string, extra: Record<string, unknown> = {}) => ({ name, url: `https://${name}.example`, external_id: name, ...extra });

test("add_leads creates a pending cluster and counts added leads", async () => {
  const ctx = await testContext();
  const out = await run(addLeads, ctx, { cluster, leads: [lead("a"), lead("b")] });
  assert.deepEqual({ ...(out as object), cluster_id: undefined }, {
    cluster_id: undefined,
    added: 2,
    skipped: 0,
    signal_count: 2,
    review_status: "pending",
  });
  assert.match((out as { cluster_id: string }).cluster_id, /^cl_/);
});

test("add_leads skips a lead it has already seen, by external_id or by url", async () => {
  const ctx = await testContext();
  await run(addLeads, ctx, { cluster, leads: [lead("a"), lead("b")] });
  const out = await run(addLeads, ctx, {
    cluster,
    leads: [lead("a"), { name: "b again", url: "https://b.example" }, { name: "nothing to match on" }],
  });
  assert.deepEqual({ added: 0, skipped: 3, signal_count: 2 }, pick(out, ["added", "skipped", "signal_count"]));
});

test("add_leads with an existing label updates the cluster instead of making a new one", async () => {
  const ctx = await testContext();
  const first = (await run(addLeads, ctx, { cluster, leads: [lead("a")] })) as { cluster_id: string };
  const second = (await run(addLeads, ctx, { cluster: { ...cluster, unserved_score: 0.3 }, leads: [lead("b")] })) as {
    cluster_id: string;
    signal_count: number;
  };
  assert.equal(second.cluster_id, first.cluster_id);
  assert.equal(second.signal_count, 2);
  const [row] = await ctx.db.query<{ unserved_score: number }>("select unserved_score from clusters");
  assert.ok(Math.abs(row.unserved_score - 0.3) < 1e-6);
});

test("list_clusters filters by review_status and unserved_only", async () => {
  const ctx = await testContext();
  const served = await seedCluster(ctx.db, "served", "approved");
  await seedCluster(ctx.db, "open", "approved");
  await seedCluster(ctx.db, "waiting", "pending");
  const { companyId } = await seedCompany(ctx.db, { clusterId: served, status: "active" });

  const all = (await run(listClusters, ctx, { review_status: "approved" })) as { clusters: { label: string; company_ids: string[] }[] };
  assert.deepEqual(all.clusters.map((c) => c.label).sort(), ["open", "served"]);
  assert.deepEqual(all.clusters.find((c) => c.label === "served")?.company_ids, [companyId]);

  const open = (await run(listClusters, ctx, { review_status: "approved", unserved_only: true })) as { clusters: { label: string }[] };
  assert.deepEqual(open.clusters.map((c) => c.label), ["open"]);
});

test("list_clusters caps limit at 50", async () => {
  assert.throws(() => listClusters.input.parse({ limit: 51 }));
  assert.equal((listClusters.input.parse({}) as { limit: number }).limit, 20);
});

test("find_lead matches by email, url or name within one company only", async () => {
  const ctx = await testContext();
  const a = await seedCompany(ctx.db);
  const b = await seedCompany(ctx.db, { clusterId: a.clusterId });
  const mine = await seedLead(ctx.db, a.clusterId, { companyId: a.companyId, email: "dr@example.com", url: "https://dr.example", name: "Dr Ruiz" });
  await seedLead(ctx.db, a.clusterId, { companyId: b.companyId, email: "dr@example.com", name: "Dr Ruiz" });

  for (const by of [{ email: "DR@example.com" }, { url: "https://dr.example" }, { name: "dr ruiz" }]) {
    const out = (await run(findLead, ctx, { company_id: a.companyId, ...by })) as { leads: { id: string }[] };
    assert.deepEqual(out.leads.map((l) => l.id), [mine], JSON.stringify(by));
  }
});

test("log_touch moves the lead forward and never backwards", async () => {
  const ctx = await testContext();
  const { clusterId, companyId } = await seedCompany(ctx.db);
  const leadId = await seedLead(ctx.db, clusterId, { companyId, status: "assigned" });
  const touch = { company_id: companyId, lead_id: leadId, agent_name: "co-01-outreach", channel: "contact_form" };

  const replied = (await run(logTouch, ctx, { ...touch, kind: "reply_received" })) as { lead_status: string; touch_id: string };
  assert.equal(replied.lead_status, "replied");
  assert.match(replied.touch_id, /^tc_/);
  const after = (await run(logTouch, ctx, { ...touch, kind: "sent" })) as { lead_status: string };
  assert.equal(after.lead_status, "replied");
});

test("log_touch with sample_delivered sets sample_url", async () => {
  const ctx = await testContext();
  const { clusterId, companyId } = await seedCompany(ctx.db);
  const leadId = await seedLead(ctx.db, clusterId, { companyId });
  await run(logTouch, ctx, {
    company_id: companyId,
    lead_id: leadId,
    agent_name: "co-01-builder",
    channel: "contact_form",
    kind: "sample_delivered",
    detail: `https://co-01.example/${leadId}`,
  });
  const [row] = await ctx.db.query<{ sample_url: string; status: string }>("select sample_url, status from leads where id = $1", [leadId]);
  assert.deepEqual(row, { sample_url: `https://co-01.example/${leadId}`, status: "assigned" });
});

test("log_touch on a killed company returns killed and writes nothing", async () => {
  const ctx = await testContext();
  const { clusterId, companyId } = await seedCompany(ctx.db, { status: "killed" });
  const leadId = await seedLead(ctx.db, clusterId, { companyId });
  await assert.rejects(
    run(logTouch, ctx, { company_id: companyId, lead_id: leadId, agent_name: "x", channel: "email", kind: "sent" }),
    { code: "killed" },
  );
  assert.equal((await ctx.db.query("select 1 from touches")).length, 0);
});

test("log_touch with an unknown company or lead returns not_found", async () => {
  const ctx = await testContext();
  const { companyId } = await seedCompany(ctx.db);
  const base = { agent_name: "x", channel: "email", kind: "sent" };
  await assert.rejects(run(logTouch, ctx, { ...base, company_id: "co_missing", lead_id: null }), { code: "not_found" });
  await assert.rejects(run(logTouch, ctx, { ...base, company_id: companyId, lead_id: "ld_missing" }), { code: "not_found" });
});

function pick(value: unknown, keys: string[]) {
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, record[k]]));
}
