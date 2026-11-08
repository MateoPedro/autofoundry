import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanyPanel, CompanyView, DecisionLog } from "../src/app/dashboard";
import { sampleDetail, sampleMetrics } from "../src/lib/dashboard/sample";
import { buildLineage, percent, pickFocus, usdFromCents, usdFromMicro } from "../src/lib/dashboard/view";
import { loadDashboard } from "../src/lib/server/dashboard";
import { seedCompany, seedLead, testContext } from "./helpers/fixtures";

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
  const d = await loadDashboard({}, null);
  assert.equal(d.source, "sample");
  assert.equal(d.source === "sample" && d.detail?.company.id, "co_01");
  const other = await loadDashboard({ focus: "co-02" }, null);
  assert.equal(other.source === "sample" && other.detail, null);
});

test("loadDashboard reads live metrics and the focused company from the database", async () => {
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

test("database timestamps support live focus, lineage sorting and company rendering", async () => {
  const ctx = await testContext();
  const a = await seedCompany(ctx.db, { slug: "co-01" });
  const b = await seedCompany(ctx.db, { slug: "co-02" });
  const older = "2026-11-08T01:00:00.000Z";
  const newer = "2026-11-08T02:00:00.000Z";
  for (const [company, at] of [[a, older], [b, newer]] as const) {
    await ctx.db.query("update companies set spawned_at = $2, funded_at = $2 where id = $1", [company.companyId, at]);
  }
  const [raw] = await ctx.db.query<{ spawned_at: Date }>("select spawned_at from companies where id = $1", [a.companyId]);
  assert.ok(raw.spawned_at instanceof Date, "exercise the database driver's Date values rather than JSON fixtures");

  const initial = await loadDashboard({}, ctx);
  assert.equal(initial.source, "live");
  assert.equal(initial.source === "live" && initial.focusId, b.companyId);

  const leadId = await seedLead(ctx.db, a.clusterId, { companyId: a.companyId, status: "paid" });
  await ctx.db.query(
    "insert into decisions (id, agent, kind, company_id, reason, at) values ('dc_fund', 'vc', 'fund', $1, 'funded', $3), ('dc_spawn', 'creator', 'spawn', $1, 'spawned', $2)",
    [a.companyId, older, newer],
  );
  await ctx.db.query("insert into touches (id, company_id, lead_id, agent_name, channel, kind, at) values ('tc_date', $1, $2, 'closer', 'email', 'delivered', $3)", [a.companyId, leadId, newer]);
  await ctx.db.query("insert into payments (id, company_id, lead_id, amount_cents, source, external_ref, livemode, at) values ('py_date', $1, $2, 9900, 'stripe', 'date-test', true, $3)", [a.companyId, leadId, newer]);
  await ctx.db.query("insert into session_spend (session_id, agent_name, company_id, micro_usd, started_at, synced_at) values ('ses_date', 'closer', $1, 1000, $2, $2)", [a.companyId, newer]);

  const live = await loadDashboard({}, ctx);
  assert.equal(live.source, "live");
  if (live.source !== "live") return;
  assert.equal(live.focusId, a.companyId, "a paying company takes focus");
  const roots = buildLineage(live.metrics.companies, live.metrics.decisions);
  assert.deepEqual(roots.map((r) => r.company.slug), ["co-01", "co-02"]);
  assert.deepEqual(roots[0].decisions.map((d) => d.kind), ["spawn", "fund"]);
  const inactive = live.metrics.companies.map((c) => ({ ...c, status: "killed" as const, revenue_cents: 0 }));
  assert.equal(pickFocus(inactive)?.id, b.companyId, "the newest company is the final focus fallback");
  assert.equal(live.detail?.company.spawned_at, older);
  assert.equal(live.detail?.company.funded_at, older);
  assert.equal(live.detail?.company.killed_at, null);
  assert.equal(live.detail?.leads[0].touches[0].at, newer);
  assert.equal(live.detail?.leads[0].payments[0].at, newer);
  assert.equal(live.detail?.spend[0].synced_at, newer);
  assert.equal(live.detail?.company.revenue_cents, 9900);
  assert.equal(live.detail?.spend[0].micro_usd, 1000);

  const href = (slug: string) => `/?company=${slug}`;
  const html = renderToStaticMarkup(createElement("main", null,
    createElement(DecisionLog, { metrics: live.metrics, href }),
    createElement(CompanyPanel, { detail: live.detail!, metrics: live.metrics, href, closeHref: "/" }),
  ));
  assert.match(html, /<aside class="panel"/);
  assert.match(html, /<b>Creator spawned<\/b>/, "the panel lists the company's own decisions");
  assert.match(html, /datetime="2026-11-08T02:00:00.000Z"/i);
  assert.match(html, /Paid \$99/);
});

test("the company view links a lead's site and sample only when they are http(s)", () => {
  const [lead, ...rest] = sampleDetail.leads;
  const detail = { ...sampleDetail, leads: [{ ...lead, url: "javascript:alert(document.cookie)", sample_url: "data:text/html,<script>alert(1)</script>" }, ...rest] };
  const html = renderToStaticMarkup(createElement(CompanyView, { detail, sample: true }));
  assert.doesNotMatch(html, /href="\s*(javascript|data):/i);
  assert.match(html, /<span>javascript:alert\(document.cookie\)<\/span>/);
  assert.match(html, new RegExp(`href="${rest[0].sample_url}"`));
});

test("the company view marks a test-mode payment as test mode", () => {
  const [lead, ...rest] = sampleDetail.leads;
  const detail = { ...sampleDetail, leads: [{ ...lead, payments: [{ ...lead.payments[0], amount_cents: 100, livemode: false }] }, ...rest] };
  const html = renderToStaticMarkup(createElement(CompanyView, { detail, sample: true }));
  assert.match(html, /Paid \$1 \(test mode\)/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(CompanyView, { detail: sampleDetail, sample: true })), /test mode/);
});
