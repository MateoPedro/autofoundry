import assert from "node:assert/strict";
import test from "node:test";
import { newId } from "../src/lib/server/ids";
import { createTestDb } from "./helpers/test-db";

test("migration creates every contract table", async () => {
  const db = await createTestDb();
  const rows = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ["checkouts", "clusters", "companies", "company_resources", "decisions", "funding_policy", "leads", "monid_reads", "offers", "payments", "samples", "scout_feedback", "screen_triggers", "screens", "spend", "touches"],
  );
});

test("funding_policy is seeded with the placeholder limits", async () => {
  const db = await createTestDb();
  const [p] = await db.query<Record<string, unknown>>("select * from funding_policy");
  assert.equal(Number(p.pool_micro_usd), 10_000_000);
  assert.equal(Number(p.grant_micro_usd), 5_000_000);
  assert.equal(p.max_proposed, 3);
  assert.equal(p.max_active, 2);
  assert.deepEqual(p.budget_split, { builder: 0.5, outreach: 0.3, closer: 0.2 });
});

test("newId uses the prefix and is unique", () => {
  const a = newId("ld");
  const b = newId("ld");
  assert.match(a, /^ld_[a-z2-7]{20}$/);
  assert.notEqual(a, b);
});
