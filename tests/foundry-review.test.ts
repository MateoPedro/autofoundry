import assert from "node:assert/strict";
import test from "node:test";
import { listOffers, listPending, logDecision, proposeOffer, review, reviewContext } from "../src/lib/server/foundry/review";
import { run, seedCluster, seedCompany, seedLead, seedOffer, testContext } from "./helpers/fixtures";

const offer = {
  buyer: "SF dental practices whose site has no mobile layout",
  sample: "a rebuilt one-page site",
  product: "That site on your domain, plus 30 days of edits",
  price_cents: 9900,
  channel: "contact_form",
  outreach_message: "Hi {{lead_name}}, I'm an AI agent. I rebuilt your site: {{sample_url}}",
  follow_up_message: "Following up once on {{sample_url}}.",
  delivery: "We email a link to the live site and connect your domain.",
};

test("list_pending returns pending clusters with up to 3 sample leads, and pending offers", async () => {
  const ctx = await testContext();
  const pending = await seedCluster(ctx.db, "waiting", "pending");
  for (const name of ["a", "b", "c", "d"]) await seedLead(ctx.db, pending, { name });
  await seedCluster(ctx.db, "done", "approved");
  const approved = await seedCluster(ctx.db, "with offer", "approved");
  const offerId = await seedOffer(ctx.db, approved, "pending");

  const out = (await run(listPending, ctx, {})) as {
    clusters: { id: string; sample_leads: unknown[] }[];
    offers: { id: string; price_cents: number; outreach_message: string }[];
  };
  assert.deepEqual(out.clusters.map((c) => c.id), [pending]);
  assert.equal(out.clusters[0].sample_leads.length, 3);
  assert.deepEqual(out.offers.map((o) => o.id), [offerId]);
  assert.equal(out.offers[0].price_cents, 9900);
});

test("review approves a cluster and writes a compliance decision", async () => {
  const ctx = await testContext();
  const id = await seedCluster(ctx.db, "waiting", "pending");
  const out = await run(review, ctx, { target: "cluster", id, decision: "approve", reason: "B2B, deliverable by agents" });
  assert.deepEqual(out, { id, review_status: "approved" });
  const [d] = await ctx.db.query("select agent, kind, cluster_id, offer_id, reason from decisions");
  assert.deepEqual(d, { agent: "compliance", kind: "approve", cluster_id: id, offer_id: null, reason: "B2B, deliverable by agents" });
});

test("review rejects an offer with a reason", async () => {
  const ctx = await testContext();
  const offerId = await seedOffer(ctx.db, await seedCluster(ctx.db), "pending");
  const out = await run(review, ctx, { target: "offer", id: offerId, decision: "reject", reason: "claims 'Google-certified'" });
  assert.deepEqual(out, { id: offerId, review_status: "rejected" });
  const [row] = await ctx.db.query("select review_reason from offers");
  assert.equal(row.review_reason, "claims 'Google-certified'");
  const [d] = await ctx.db.query("select kind, offer_id from decisions");
  assert.deepEqual(d, { kind: "reject", offer_id: offerId });
});

test("review of an already reviewed item returns conflict", async () => {
  const ctx = await testContext();
  const id = await seedCluster(ctx.db, "done", "approved");
  await assert.rejects(run(review, ctx, { target: "cluster", id, decision: "reject", reason: "x" }), { code: "conflict" });
});

test("review of an unknown id returns not_found", async () => {
  const ctx = await testContext();
  await assert.rejects(run(review, ctx, { target: "offer", id: "of_missing", decision: "approve", reason: "x" }), { code: "not_found" });
});

test("review requires a reason", () => {
  assert.throws(() => review.input.parse({ target: "cluster", id: "cl_x", decision: "approve", reason: "" }));
});

test("review_context exposes saved evidence and contact routes with independent lead pagination", async () => {
  const ctx = await testContext();
  const cluster = await seedCluster(ctx.db, "evidence", "pending");
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await seedLead(ctx.db, cluster));
  ids.sort();
  await ctx.db.query("update leads set contact_url = $2, data = $3 where id = $1", [ids[0], "https://example.org/inquiry", { evidence: [{ url: "https://example.org/request", observation: "An explicit request" }] }]);
  const other = await seedCluster(ctx.db, "other");
  const offer = await seedOffer(ctx.db, cluster, "pending");
  const out = await run(reviewContext, ctx, { cluster_id: cluster, offer_id: offer, leads_limit: 2 }) as {
    cluster: { review_status: string }; offer: { id: string }; leads: { id: string; contact_url: string; data: unknown }[]; next_lead_id: string;
  };
  assert.equal(out.cluster.review_status, "pending");
  assert.equal(out.offer.id, offer);
  assert.deepEqual(out.leads.map(l => l.id), ids.slice(0, 2));
  assert.equal(out.leads[0].contact_url, "https://example.org/inquiry");
  assert.deepEqual(out.leads[0].data, { evidence: [{ url: "https://example.org/request", observation: "An explicit request" }] });
  const page = await run(reviewContext, ctx, { cluster_id: cluster, leads_limit: 2, after_lead_id: out.next_lead_id }) as { leads: { id: string }[]; next_lead_id: null };
  assert.deepEqual(page.leads.map(l => l.id), ids.slice(2));
  assert.equal(page.next_lead_id, null);
  await assert.rejects(run(reviewContext, ctx, { cluster_id: other, offer_id: offer }), { code: "not_found" });
  await assert.rejects(run(reviewContext, ctx, { cluster_id: "cl_missing" }), { code: "not_found" });
});

test("pending cursors pass incomplete items and remain valid after earlier targets are reviewed", async () => {
  const ctx = await testContext();
  const clusters = [];
  const offers = [];
  for (let i = 0; i < 5; i++) {
    const id = await seedCluster(ctx.db, `page ${i}`, "pending"); clusters.push(id);
    offers.push(await seedOffer(ctx.db, id, "pending"));
    await ctx.db.query("update clusters set created_at = $2 where id = $1", [id, new Date(1700000000000 + i * 1000)]);
    await ctx.db.query("update offers set created_at = $2 where id = $1", [offers[i], new Date(1700000000000 + i * 1000)]);
  }
  type Page = { clusters: { id: string }[]; offers: { id: string }[]; next_cluster_id: string | null; next_offer_id: string | null };
  const first = await run(listPending, ctx, { limit: 2 }) as Page;
  assert.deepEqual(first.clusters.map(c => c.id), clusters.slice(0, 2));
  await run(review, ctx, { target: "cluster", id: clusters[1], decision: "approve", reason: "test cursor after mutation" });
  const second = await run(listPending, ctx, { limit: 2, after_cluster_id: first.next_cluster_id, after_offer_id: first.next_offer_id }) as Page;
  assert.deepEqual(second.clusters.map(c => c.id), clusters.slice(2, 4));
  assert.deepEqual(second.offers.map(o => o.id), offers.slice(2, 4));
  const last = await run(listPending, ctx, { limit: 2, after_cluster_id: second.next_cluster_id, after_offer_id: second.next_offer_id }) as Page;
  assert.deepEqual(last.clusters.map(c => c.id), clusters.slice(4));
  assert.equal(last.next_cluster_id, null);
  assert.equal(last.next_offer_id, null);
  // The first incomplete candidate was not rejected to clear the queue.
  const [waiting] = await ctx.db.query<{ review_status: string }>("select review_status from clusters where id = $1", [clusters[0]]);
  assert.equal(waiting.review_status, "pending");
});

test("propose_offer on a pending or rejected cluster returns not_approved", async () => {
  const ctx = await testContext();
  for (const status of ["pending", "rejected"]) {
    const clusterId = await seedCluster(ctx.db, `c ${status}`, status);
    await assert.rejects(run(proposeOffer, ctx, { cluster_id: clusterId, ...offer }), { code: "not_approved" });
  }
});

test("propose_offer with an unrunnable channel returns invalid", async () => {
  const ctx = await testContext();
  const clusterId = await seedCluster(ctx.db);
  for (const channel of ["x_reply", "phone"]) {
    await assert.rejects(run(proposeOffer, ctx, { cluster_id: clusterId, ...offer, channel }), { code: "invalid" });
  }
});

test("propose_offer without {{sample_url}} in the message returns invalid", async () => {
  const ctx = await testContext();
  const clusterId = await seedCluster(ctx.db);
  await assert.rejects(run(proposeOffer, ctx, { cluster_id: clusterId, ...offer, outreach_message: "Hi {{lead_name}}" }), { code: "invalid" });
});

test("propose_offer below 50 cents is refused", () => {
  assert.throws(() => proposeOffer.input.parse({ cluster_id: "cl_x", ...offer, price_cents: 49 }));
});

test("propose_offer stores a pending offer", async () => {
  const ctx = await testContext();
  const clusterId = await seedCluster(ctx.db);
  const out = (await run(proposeOffer, ctx, { cluster_id: clusterId, ...offer })) as { offer_id: string; review_status: string };
  assert.match(out.offer_id, /^of_/);
  assert.equal(out.review_status, "pending");
  const [row] = await ctx.db.query("select cluster_id, price_cents, channel from offers where id = $1", [out.offer_id]);
  assert.deepEqual(row, { cluster_id: clusterId, price_cents: 9900, channel: "contact_form" });
});

test("propose_offer with an unknown cluster returns not_found", async () => {
  const ctx = await testContext();
  await assert.rejects(run(proposeOffer, ctx, { cluster_id: "cl_missing", ...offer }), { code: "not_found" });
});

test("log_decision records a hold", async () => {
  const ctx = await testContext();
  const out = (await run(logDecision, ctx, { agent: "vc", kind: "hold", reason: "pool has $2 left" })) as { decision_id: string };
  assert.match(out.decision_id, /^dc_/);
  const [d] = await ctx.db.query("select agent, kind, reason from decisions");
  assert.deepEqual(d, { agent: "vc", kind: "hold", reason: "pool has $2 left" });
});

test("list_offers shows each offer's review and companies, newest first, and filters", async () => {
  const ctx = await testContext();
  const { clusterId, offerId: spawned, companyId } = await seedCompany(ctx.db, { status: "killed", slug: "co-01" });
  const approved = await seedOffer(ctx.db, clusterId, "approved");
  const rejected = await seedOffer(ctx.db, clusterId, "rejected");
  await ctx.db.query("update offers set review_reason = 'claims we cannot back up' where id = $1", [rejected]);
  const other = await seedCluster(ctx.db, "Oakland bakeries", "approved");
  const pending = await seedOffer(ctx.db, other, "pending");
  for (const [i, id] of [spawned, approved, rejected, pending].entries()) {
    await ctx.db.query("update offers set created_at = $2 where id = $1", [id, new Date(Date.UTC(2026, 10, 8, i))]);
  }

  type Out = { offers: { id: string; review_status: string; review_reason: string | null; companies: { id: string; status: string }[] }[] };
  const all = (await run(listOffers, ctx, { limit: 10 })) as Out;
  assert.deepEqual(all.offers.map((o) => o.id), [pending, rejected, approved, spawned]);
  assert.deepEqual(all.offers[3].companies, [{ id: companyId, slug: "co-01", status: "killed" }]);
  assert.equal(all.offers[1].review_reason, "claims we cannot back up");

  const ready = (await run(listOffers, ctx, { review_status: "approved", unspawned_only: true })) as Out;
  assert.deepEqual(ready.offers.map((o) => o.id), [approved]);
  assert.deepEqual(ready.offers[0].companies, []);

  const forCluster = (await run(listOffers, ctx, { cluster_id: other })) as Out;
  assert.deepEqual(forCluster.offers.map((o) => o.id), [pending]);
});
