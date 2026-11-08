import assert from "node:assert/strict";
import test from "node:test";
import { fund, kill } from "../src/lib/server/foundry/company";
import { checkoutLink, handleOrderEvent, orderEventResponse } from "../src/lib/server/foundry/payments";
import { spawned } from "./helpers/company";
import { FakePayments } from "./helpers/fake-payments";
import { NOW, run } from "./helpers/fixtures";

async function funded(leads = 2) {
  const s = await spawned(leads);
  await run(fund, s.ctx, { company_id: s.companyId, reason: "go" });
  const payments = new FakePayments();
  s.ctx.payments = payments;
  return { ...s, payments };
}

const event = (checkoutRef: string, orderRef: string, type = "checkout.session.completed") => ({
  id: `evt_${type}`,
  type,
  checkout_ref: checkoutRef,
  order_ref: orderRef,
  payment_ref: "pi_test_1",
});

async function paymentRows(s: { ctx: { db: { query: <T>(sql: string) => Promise<T[]> } } }) {
  return s.ctx.db.query<{ company_id: string; lead_id: string; amount_cents: number; refunded_cents: number; source: string; external_ref: string; livemode: boolean }>(
    "select company_id, lead_id, amount_cents, refunded_cents, source, external_ref, livemode from payments",
  );
}

test("checkout_link opens a checkout at the offer's price for one lead", async () => {
  const { ctx, payments, naive, companyId, leadIds } = await funded();
  const sampleUrl = `${naive.apps[0].url}/${leadIds[0]}`;
  await ctx.db.query("update leads set sample_url = $2, email = 'front@folsomdental.example' where id = $1", [leadIds[0], sampleUrl]);

  const out = await run(checkoutLink, ctx, { company_id: companyId, lead_id: leadIds[0] });

  assert.deepEqual(out, { url: "https://checkout.stripe.com/c/pay/cs_test_1", amount_cents: 9900, expires_at: "2026-11-09T07:00:00.000Z" });
  const [request] = payments.requests;
  assert.equal(request.order_ref, `${companyId}:${leadIds[0]}`);
  assert.deepEqual(request.lines, [{ name: "One-page site on your domain", unit_cents: 9900, quantity: 1 }]);
  assert.equal(request.expires_at, Date.parse("2026-11-09T07:00:00Z") / 1000);
  assert.equal(request.success_url, sampleUrl);
  assert.equal(request.cancel_url, sampleUrl);
  assert.equal(request.email, "front@folsomdental.example");
});

test("checkout_link falls back to the company's site and leaves out an email the checkout would refuse", async () => {
  const { ctx, payments, naive, companyId, leadIds } = await funded();
  await ctx.db.query("update leads set email = 'not an address' where id = $1", [leadIds[0]]);
  await run(checkoutLink, ctx, { company_id: companyId, lead_id: leadIds[0] });
  assert.equal(payments.requests[0].success_url, naive.apps[0].url);
  assert.equal(payments.requests[0].email, undefined);
});

test("checkout_link returns the open checkout instead of opening another, until it nears expiry", async () => {
  const s = await funded();
  const args = { company_id: s.companyId, lead_id: s.leadIds[0] };
  const first = await run(checkoutLink, s.ctx, args);
  assert.deepEqual(await run(checkoutLink, s.ctx, args), first);
  assert.equal(s.payments.requests.length, 1);

  s.ctx.now = () => new Date(NOW.getTime() + 22.5 * 3_600_000);
  const later = (await run(checkoutLink, s.ctx, args)) as { url: string };
  assert.equal(s.payments.requests.length, 2);
  assert.equal(later.url, "https://checkout.stripe.com/c/pay/cs_test_2");
});

test("checkout_link refuses an unfunded company, a lead from elsewhere, a paid lead and a killed company", async () => {
  const s = await spawned(1);
  s.ctx.payments = new FakePayments();
  const args = { company_id: s.companyId, lead_id: s.leadIds[0] };
  await assert.rejects(run(checkoutLink, s.ctx, args), { code: "conflict", message: /proposed/ });
  await run(fund, s.ctx, { company_id: s.companyId, reason: "go" });
  await assert.rejects(run(checkoutLink, s.ctx, { ...args, lead_id: "ld_other" }), { code: "not_found" });
  await s.ctx.db.query("update leads set status = 'paid' where id = $1", [s.leadIds[0]]);
  await assert.rejects(run(checkoutLink, s.ctx, args), { code: "conflict", message: /already paid/ });
  await run(kill, s.ctx, { company_id: s.companyId, reason: "stop" });
  await assert.rejects(run(checkoutLink, s.ctx, args), { code: "killed" });
});

test("checkout_link reports a checkout Naïve refuses, and refuses without payments set up", async () => {
  const s = await funded(1);
  s.payments.failOn.add("createCheckout");
  await assert.rejects(run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] }), {
    code: "naive_error",
    message: /open the checkout: 409: this app's account can't take payments yet/,
  });
  s.ctx.payments = null;
  await assert.rejects(run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] }), { code: "internal", message: /FOUNDRY_APP_ID/ });
});

test("a paid checkout records one payment, marks the lead paid, and wakes the Closer once", async () => {
  const s = await funded();
  await run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] });
  s.payments.pay("cs_test_1");
  const paid = event("cs_test_1", `${s.companyId}:${s.leadIds[0]}`);

  const first = await handleOrderEvent(s.ctx, paid);
  const replay = await handleOrderEvent(s.ctx, paid);

  assert.equal(first.outcome, "recorded");
  assert.equal(first.delivered_to, "co-01-closer");
  assert.equal(replay.outcome, "unchanged");
  assert.deepEqual(await paymentRows(s), [
    { company_id: s.companyId, lead_id: s.leadIds[0], amount_cents: 9900, refunded_cents: 0, source: "naive_checkout", external_ref: "cs_test_1", livemode: false },
  ]);
  const [lead] = await s.ctx.db.query<{ status: string }>("select status from leads where id = $1", [s.leadIds[0]]);
  assert.equal(lead.status, "paid");
  const deliver = s.naive.cards.filter((c) => c.assignee === "co-01-closer");
  assert.equal(deliver.length, 1);
  assert.equal(deliver[0].title, "Deliver: Lead 0");
  assert.equal(deliver[0].status, "todo");
  const body = JSON.parse(deliver[0].body);
  assert.equal(body.lead_id, s.leadIds[0]);
  assert.deepEqual(body.payment, { amount_cents: 9900, livemode: false });
});

test("the stored checkout decides which lead paid, not the event's order_ref", async () => {
  const s = await funded();
  await run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] });
  s.payments.pay("cs_test_1");
  await handleOrderEvent(s.ctx, event("cs_test_1", `${s.companyId}:${s.leadIds[1]}`));
  const [row] = await paymentRows(s);
  assert.equal(row.lead_id, s.leadIds[0]);
});

test("a refund updates the payment's refunded amount and wakes nobody", async () => {
  const s = await funded();
  await run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] });
  s.payments.pay("cs_test_1");
  await handleOrderEvent(s.ctx, event("cs_test_1", ""));
  s.payments.refund("cs_test_1", 9900);

  const out = await handleOrderEvent(s.ctx, event("cs_test_1", "", "charge.refunded"));

  assert.equal(out.outcome, "updated");
  assert.equal((await paymentRows(s))[0].refunded_cents, 9900);
  assert.equal(s.naive.cards.filter((c) => c.assignee === "co-01-closer").length, 1);
});

test("events for an unknown or unpaid checkout change nothing", async () => {
  const s = await funded();
  assert.deepEqual(await handleOrderEvent(s.ctx, event("cs_live_elsewhere", "")), { outcome: "ignored", reason: "no checkout cs_live_elsewhere from checkout_link" });
  await run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] });
  assert.deepEqual(await handleOrderEvent(s.ctx, event("cs_test_1", "", "checkout.session.expired")), { outcome: "ignored", reason: "checkout cs_test_1 is not paid" });
  assert.deepEqual(await paymentRows(s), []);
  const [lead] = await s.ctx.db.query<{ status: string }>("select status from leads where id = $1", [s.leadIds[0]]);
  assert.equal(lead.status, "assigned");
});

test("a payment is kept when the Deliver card fails, and the next delivery of the event wakes the Closer", async () => {
  const s = await funded();
  await run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] });
  s.payments.pay("cs_test_1");
  s.naive.failOn.set("createCard", new Error("board unavailable"));

  await assert.rejects(handleOrderEvent(s.ctx, event("cs_test_1", "")), { code: "naive_error", message: /wake the Closer/ });
  assert.equal((await paymentRows(s)).length, 1);

  s.naive.failOn.delete("createCard");
  const retry = await handleOrderEvent(s.ctx, event("cs_test_1", ""));
  assert.equal(retry.outcome, "unchanged");
  assert.equal(retry.delivered_to, "co-01-closer");
  assert.equal(s.naive.cards.filter((c) => c.assignee === "co-01-closer").length, 1);
});

test("a payment that lands after a kill is still recorded, and its Deliver card waits", async () => {
  const s = await funded();
  await run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] });
  await run(kill, s.ctx, { company_id: s.companyId, reason: "stop" });
  s.payments.pay("cs_test_1");

  const out = await handleOrderEvent(s.ctx, event("cs_test_1", ""));

  assert.equal(out.outcome, "recorded");
  assert.equal((await paymentRows(s)).length, 1);
  assert.equal(s.naive.cards.find((c) => c.assignee === "co-01-closer")!.status, "blocked");
});

test("the order events endpoint takes only the app's MCP bearer and a checkout_ref", async () => {
  const s = await funded();
  await run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] });
  s.payments.pay("cs_test_1");
  const post = (body: unknown, auth = "Bearer mcp-token") =>
    orderEventResponse(new Request("https://foundry.example/api/orders/events", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) }), s.ctx, "mcp-token");

  assert.equal((await post(event("cs_test_1", ""), "Bearer wrong")).status, 401);
  assert.equal((await post({ type: "checkout.session.completed" })).status, 400);
  const ok = await post(event("cs_test_1", ""));
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { outcome: string }).outcome, "recorded");

  s.payments.failOn.add("getCheckout");
  const failed = await post(event("cs_test_1", ""));
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: { code: "naive_error", message: "read the checkout back: 504: request timed out" } });
});
