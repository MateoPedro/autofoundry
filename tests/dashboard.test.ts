import assert from "node:assert/strict";
import test from "node:test";
import { sampleDetail, sampleMetrics } from "../src/lib/dashboard/sample";
import { buildLineage, percent, pickFocus, usdFromCents, usdFromMicro } from "../src/lib/dashboard/view";

test("money formats convert each unit explicitly", () => {
  assert.equal(usdFromMicro(4_540_000), "$4.54");
  assert.equal(usdFromMicro(0), "$0.00");
  assert.equal(usdFromCents(19_800), "$198");
  assert.equal(usdFromCents(7_950), "$79.50");
  assert.equal(percent(9, 10), 90);
  assert.equal(percent(1, 0), 0);
  assert.equal(percent(12, 10), 100);
});

test("lineage nests children under their parent with their decisions in order", () => {
  const roots = buildLineage(sampleMetrics.companies, sampleMetrics.decisions);
  assert.deepEqual(
    roots.map((r) => r.company.slug),
    ["co-01", "co-02"],
  );
  const co01 = roots[0];
  assert.deepEqual(
    co01.children.map((c) => c.company.slug),
    ["co-03"],
  );
  assert.deepEqual(
    co01.decisions.map((d) => d.kind),
    ["spawn", "fund"],
  );
  assert.deepEqual(
    co01.children[0].decisions.map((d) => d.kind),
    ["spawn", "hold"],
  );
  assert.equal(roots[1].decisions.at(-1)?.kind, "kill");
});

test("a company whose parent is missing from the page becomes a root", () => {
  const orphan = { ...sampleMetrics.companies[2], parent_id: "co_99" };
  const roots = buildLineage([orphan], []);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].company.slug, "co-03");
});

test("focus picks the requested company, else the best earner, else the newest", () => {
  const companies = sampleMetrics.companies;
  assert.equal(pickFocus(companies, "co-02")?.id, "co_02");
  assert.equal(pickFocus(companies, "co_03")?.id, "co_03");
  assert.equal(pickFocus(companies, "nope")?.id, "co_01");
  assert.equal(pickFocus(companies)?.id, "co_01");
  const noRevenue = companies.map((c) => ({ ...c, revenue_cents: 0 }));
  assert.equal(pickFocus(noRevenue)?.id, "co_01");
  const noneActive = noRevenue.map((c) => ({ ...c, status: "killed" as const }));
  assert.equal(pickFocus(noneActive)?.id, "co_03");
  assert.equal(pickFocus([]), null);
});

test("the sample detail belongs to the sample's co-01", () => {
  assert.equal(sampleDetail.company.id, "co_01");
  assert.equal(sampleDetail.offer.id, sampleDetail.company.offer_id);
});

test("loadDashboard shows the labeled sample when there is no database", async () => {
  const { loadDashboard } = await import("../src/lib/server/dashboard");
  const d = await loadDashboard({}, null);
  assert.equal(d.source, "sample");
  assert.equal(d.source === "sample" && d.detail?.company.id, "co_01");
  const other = await loadDashboard({ focus: "co-02" }, null);
  assert.equal(other.source === "sample" && other.detail, null);
});

test("loadDashboard reads live metrics and the focused company from the database", async () => {
  const { loadDashboard } = await import("../src/lib/server/dashboard");
  const { seedCompany, seedLead, testContext } = await import("./helpers/fixtures");
  const ctx = await testContext();
  const empty = await loadDashboard({}, ctx);
  assert.equal(empty.source, "live");
  assert.equal(empty.source === "live" && empty.detail, null);

  const a = await seedCompany(ctx.db, { slug: "co-01" });
  const b = await seedCompany(ctx.db, { slug: "co-02", status: "killed" });
  await seedLead(ctx.db, a.clusterId, { companyId: a.companyId, status: "contacted", sampleUrl: "https://s/1" });
  await ctx.db.query("insert into decisions (id, agent, kind, company_id, reason) values ('dc_1', 'vc', 'kill', $1, 'no replies')", [b.companyId]);

  const live = await loadDashboard({ focus: "co-02" }, ctx);
  assert.equal(live.source, "live");
  if (live.source !== "live") return;
  assert.equal(live.metrics.companies.length, 2);
  assert.equal(live.metrics.decisions[0].reason, "no replies");
  assert.equal(live.detail?.company.slug, "co-02");
  const focusA = await loadDashboard({}, ctx);
  assert.equal(focusA.source === "live" && focusA.detail?.leads[0].sample_url, "https://s/1");
});

test("loadDashboard reports an unreachable database instead of falling back to sample", async () => {
  const { loadDashboard } = await import("../src/lib/server/dashboard");
  const { testContext } = await import("./helpers/fixtures");
  const ctx = await testContext();
  const broken = { ...ctx, db: { ...ctx.db, query: async () => Promise.reject(new Error("down")) } };
  const original = console.error;
  console.error = () => {};
  try {
    const d = await loadDashboard({}, broken);
    assert.equal(d.source, "error");
  } finally {
    console.error = original;
  }
});
