import assert from "node:assert/strict";
import test from "node:test";
import { setRunning } from "../src/lib/server/foundry/state";
import { closeCompanyWork, crewMember, wake, WORK } from "../src/lib/server/foundry/work";
import { crewContext } from "./helpers/crew";
import { NOW, seedCompany, testContext } from "./helpers/fixtures";

test("wake creates one card per key, on the role's board, assigned to the role", async () => {
  const ctx = await crewContext();
  const { companyId } = await seedCompany(ctx.db);
  const results = [await wake(ctx, WORK.contact("ld_1", companyId)), await wake(ctx, WORK.contact("ld_1", companyId))];
  assert.deepEqual(results, [{ created: true }, { created: false, reason: "exists" }]);
  assert.equal(ctx.naive.cards.length, 1);
  const [card] = ctx.naive.cards;
  assert.equal(card.title, `Contact ld_1 for ${companyId}`);
  assert.equal(card.assignee, "outreach");
  assert.equal(card.key, "outreach:contact:ld_1");
  assert.equal(card.board_id, (await crewMember(ctx.db, "outreach")).board_id);
  assert.equal(ctx.naive.calls.filter((c) => c === "createCard").length, 1);
});

test("wake does nothing while stopped", async () => {
  const ctx = await crewContext();
  await setRunning(ctx.db, false, NOW);
  assert.deepEqual(await wake(ctx, WORK.design("cl_1")), { created: false, reason: "stopped" });
  assert.ok(!ctx.naive.calls.includes("createCard"));
  assert.deepEqual(await ctx.db.query("select * from work_cards"), []);
});

test("wake turns a Naïve failure into naive_error and records nothing", async () => {
  const ctx = await crewContext();
  ctx.naive.failOn.set("createCard", new Error("boom"));
  await assert.rejects(wake(ctx, WORK.design("cl_1")), { code: "naive_error" });
  assert.deepEqual(await ctx.db.query("select * from work_cards"), []);
});

test("closeCompanyWork closes only that company's open cards", async () => {
  const ctx = await crewContext();
  const one = await seedCompany(ctx.db);
  const two = await seedCompany(ctx.db);
  await wake(ctx, WORK.contact("ld_1", one.companyId));
  await wake(ctx, WORK.deliver("ld_1", one.companyId));
  await wake(ctx, WORK.contact("ld_2", two.companyId));
  assert.equal(await closeCompanyWork(ctx, one.companyId), 2);
  assert.deepEqual(
    ctx.naive.cards.map((c) => [c.key, c.status]),
    [
      ["outreach:contact:ld_1", "done"],
      ["closer:deliver:ld_1", "done"],
      ["outreach:contact:ld_2", "todo"],
    ],
  );
  assert.equal(await closeCompanyWork(ctx, one.companyId), 0);
});

test("crewMember explains a missing crew", async () => {
  const ctx = await testContext();
  await assert.rejects(crewMember(ctx.db, "scout"), (error: { code: string; message: string }) => error.code === "internal" && /pnpm crew setup/.test(error.message));
});

test("wake after an orphaned card records that card instead of making a second", async () => {
  const ctx = await crewContext();
  const { companyId } = await seedCompany(ctx.db);
  const { board_id } = await crewMember(ctx.db, "outreach");
  const orphan = await ctx.naive.createCard(board_id, { title: "x", body: "x", assignee: "outreach", key: "outreach:contact:ld_1" });
  assert.deepEqual(await wake(ctx, WORK.contact("ld_1", companyId)), { created: true });
  assert.equal(ctx.naive.cards.length, 1);
  const [row] = await ctx.db.query<{ card_id: string }>("select card_id from work_cards where key = 'outreach:contact:ld_1'");
  assert.equal(row.card_id, orphan.id);
});
