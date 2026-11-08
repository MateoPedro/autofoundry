import assert from "node:assert/strict";
import test from "node:test";
import { addLeads, dismissInbound, findLead, listClusters, logTouch } from "../src/lib/server/foundry/leads";
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

test("add_leads stores lead data as a JSON object", async () => {
  const ctx = await testContext();
  await run(addLeads, ctx, { cluster, leads: [lead("a", { data: { rating: 4.6, issues: ["no mobile layout"] } })] });
  const [row] = await ctx.db.query("select jsonb_typeof(data) as t, data->>'rating' as rating from leads");
  assert.deepEqual(row, { t: "object", rating: "4.6" });
});

test("add_leads treats urls that differ only by case, www, a trailing slash or a fragment as the same business", async () => {
  const ctx = await testContext();
  await run(addLeads, ctx, { cluster, leads: [{ name: "Biz", url: "https://www.Biz.example/" }] });
  const out = await run(addLeads, ctx, {
    cluster,
    leads: [
      { name: "Biz again", url: "https://biz.example#contact" },
      { name: "Biz by place id", external_id: "place-1", url: "https://biz.example" },
    ],
  });
  assert.deepEqual(pick(out, ["added", "skipped", "signal_count"]), { added: 0, skipped: 2, signal_count: 1 });
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

test("find_lead takes the lead id from a card title and returns its contact route", async () => {
  const ctx = await testContext();
  const a = await seedCompany(ctx.db);
  const b = await seedCompany(ctx.db, { clusterId: a.clusterId });
  const mine = await seedLead(ctx.db, a.clusterId, { companyId: a.companyId, name: "Dr Ruiz" });
  const theirs = await seedLead(ctx.db, a.clusterId, { companyId: b.companyId, name: "Dr Ruiz" });
  await ctx.db.query("update leads set contact_url = 'https://dr.example/contact' where id = $1", [mine]);

  const out = (await run(findLead, ctx, { company_id: a.companyId, lead_id: mine })) as { leads: { id: string; contact_url: string }[] };
  assert.deepEqual(out.leads.map((l) => [l.id, l.contact_url]), [[mine, "https://dr.example/contact"]]);
  const other = (await run(findLead, ctx, { company_id: a.companyId, lead_id: theirs })) as { leads: unknown[] };
  assert.deepEqual(other.leads, []);
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

test("concurrent touches never move a lead backwards", async () => {
  const ctx = await testContext();
  const { clusterId, companyId } = await seedCompany(ctx.db);
  const touch = { company_id: companyId, agent_name: "co-01-closer", channel: "email" };
  for (let i = 0; i < 10; i++) {
    const leadId = await seedLead(ctx.db, clusterId, { companyId, status: "assigned" });
    await Promise.all([
      run(logTouch, ctx, { ...touch, lead_id: leadId, kind: "reply_received" }),
      run(logTouch, ctx, { ...touch, lead_id: leadId, kind: "sent" }),
    ]);
    const [row] = await ctx.db.query<{ status: string }>("select status from leads where id = $1", [leadId]);
    assert.equal(row.status, "replied", `run ${i}`);
  }
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

test("add_leads refuses a url or contact_url that isn't an http(s) URL", () => {
  const args = (lead: Record<string, unknown>) => ({ cluster: { label: "SF dentists", source: "google_maps" }, leads: [{ name: "Folsom Street Dental", ...lead }] });
  for (const field of ["url", "contact_url"]) {
    for (const bad of ["javascript:alert(1)", "folsomdental.example"]) {
      const parsed = addLeads.input.safeParse(args({ [field]: bad }));
      assert.equal(parsed.success, false, `${field}: ${bad}`);
      assert.match(parsed.error!.issues[0].message, /http\(s\) URL/);
    }
  }
  assert.equal(addLeads.input.safeParse(args({ url: "https://folsomdental.example", contact_url: null })).success, true);
});

test("log_touch refuses a sample_delivered touch whose detail isn't an http(s) URL", () => {
  const touch = (kind: string, detail?: string) => ({ company_id: "co_1", lead_id: "ld_1", agent_name: "co-01-builder", channel: "contact_form", kind, detail });
  const bad = logTouch.input.safeParse(touch("sample_delivered", "javascript:alert(1)"));
  assert.equal(bad.success, false);
  assert.match(bad.error!.issues[0].message, /http\(s\) URL/);
  assert.equal(logTouch.input.safeParse(touch("sample_delivered", "https://co-01.example/ld_1")).success, true);
  assert.equal(logTouch.input.safeParse(touch("failed", "the form has a captcha")).success, true);
});

test("find_lead without company_id finds a lead in any live company and says which", async () => {
  const ctx = await testContext();
  const live = await seedCompany(ctx.db);
  const dead = await seedCompany(ctx.db, { status: "killed", clusterId: live.clusterId });
  const mine = await seedLead(ctx.db, live.clusterId, { companyId: live.companyId, email: "dr@example.com" });
  await seedLead(ctx.db, live.clusterId, { companyId: dead.companyId, email: "dr@example.com" });
  await seedLead(ctx.db, live.clusterId, { email: "dr@example.com" });

  const out = (await run(findLead, ctx, { email: "dr@example.com" })) as { leads: { id: string; company_id: string }[] };
  assert.deepEqual(out.leads.map((l) => [l.id, l.company_id]), [[mine, live.companyId]]);
  const byId = (await run(findLead, ctx, { lead_id: mine })) as { leads: { company_id: string }[] };
  assert.equal(byId.leads[0].company_id, live.companyId);
});

test("log_touch keeps the inbound message id", async () => {
  const ctx = await testContext();
  const { clusterId, companyId } = await seedCompany(ctx.db);
  const leadId = await seedLead(ctx.db, clusterId, { companyId, status: "contacted" });
  await run(logTouch, ctx, { company_id: companyId, lead_id: leadId, agent_name: "closer", channel: "email", kind: "reply_received", message_id: "inb_abc123" });
  assert.deepEqual(await ctx.db.query("select kind, message_id from touches"), [{ kind: "reply_received", message_id: "inb_abc123" }]);
});

test("dismiss_inbound marks a message handled once", async () => {
  const ctx = await testContext();
  await run(dismissInbound, ctx, { message_id: "inb_spam", reason: "auto-reply" });
  await run(dismissInbound, ctx, { message_id: "inb_spam", reason: "again" });
  assert.deepEqual(await ctx.db.query("select message_id, outcome from inbound_seen"), [{ message_id: "inb_spam", outcome: "auto-reply" }]);
});

test("a killed company's buyer can still be answered and delivered", async () => {
  const ctx = await testContext();
  const { clusterId, companyId } = await seedCompany(ctx.db, { status: "killed" });
  const leadId = await seedLead(ctx.db, clusterId, { companyId, status: "paid" });
  const touch = { company_id: companyId, lead_id: leadId, agent_name: "closer", channel: "email" };
  for (const kind of ["reply_received", "reply_sent", "delivered"]) await run(logTouch, ctx, { ...touch, kind });
  await assert.rejects(run(logTouch, ctx, { ...touch, kind: "sent" }), { code: "killed" });
});
