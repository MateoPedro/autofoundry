import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "../src/lib/server/foundry/company";
import { setup, spawnArgs } from "./helpers/company";
import { run, seedCluster, seedCompany, seedOffer } from "./helpers/fixtures";

test("spawn opens a company from rows only", async () => {
  const { naive, ctx, offerId, leadIds } = await setup(7);
  const out = (await run(spawn, ctx, spawnArgs(offerId))) as Record<string, unknown>;

  assert.equal(out.slug, "co-01");
  assert.equal(out.status, "spawning");
  assert.deepEqual(out.lead_ids, leadIds.slice(0, 5));
  assert.deepEqual(naive.calls, []);
  const leads = await ctx.db.query<{ id: string; status: string }>("select id, status from leads where company_id = $1 order by created_at", [out.company_id]);
  assert.deepEqual(leads.map((l) => [l.id, l.status]), leadIds.slice(0, 5).map((id) => [id, "assigned"]));
  const [d] = await ctx.db.query("select agent, kind, company_id, offer_id, reason from decisions");
  assert.deepEqual(d, { agent: "creator", kind: "spawn", company_id: out.company_id, offer_id: offerId, reason: "3 leads, approved, nobody serving the cluster" });
});

test("a retry of a spawn answers the same company and its leads", async () => {
  const { ctx, offerId } = await setup();
  const first = await run(spawn, ctx, spawnArgs(offerId));
  assert.deepEqual(await run(spawn, ctx, spawnArgs(offerId)), first);
  assert.equal((await ctx.db.query("select 1 from companies")).length, 1);
});

test("spawn still refuses past max_proposed and on a reused request_id", async () => {
  const { ctx, clusterId, offerId } = await setup();
  await run(spawn, ctx, spawnArgs(offerId));
  await assert.rejects(run(spawn, ctx, spawnArgs(await seedOffer(ctx.db, clusterId))), { code: "conflict" });
  for (const status of ["proposed", "spawning"]) await seedCompany(ctx.db, { status });
  await assert.rejects(run(spawn, ctx, spawnArgs(offerId, { request_id: "another" })), { code: "policy", message: /max_proposed: 3/ });
});

test("spawn refuses an unapproved offer, an unknown offer or parent, and an empty cluster", async () => {
  const { ctx, clusterId, offerId } = await setup(1);
  await assert.rejects(run(spawn, ctx, spawnArgs(await seedOffer(ctx.db, clusterId, "pending"))), { code: "not_approved" });
  await assert.rejects(run(spawn, ctx, spawnArgs("of_missing")), { code: "not_found" });
  await assert.rejects(run(spawn, ctx, spawnArgs(offerId, { parent_id: "co_missing" })), { code: "not_found" });
  const emptyCluster = await seedCluster(ctx.db, "empty");
  await assert.rejects(run(spawn, ctx, spawnArgs(await seedOffer(ctx.db, emptyCluster))), { code: "invalid" });
  assert.equal((await ctx.db.query("select 1 from companies")).length, 0);
});
