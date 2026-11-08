import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { fund } from "../src/lib/server/foundry/company";
import { checkoutLink, stripeWebhookResponse } from "../src/lib/server/foundry/payments";
import { createStripePayments, verifyStripeSignature } from "../src/lib/server/stripe";
import { spawned } from "./helpers/company";
import { FakePayments } from "./helpers/fake-payments";
import { NOW, run } from "./helpers/fixtures";

const SECRET = "whsec_test_secret";
const nowSec = NOW.getTime() / 1000;

function sign(payload: string, at = nowSec, secret = SECRET) {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${payload}`).digest("hex")}`;
}

function fakeFetch(answers: { status?: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const answer = answers[calls.length - 1] ?? answers.at(-1)!;
    return Response.json(answer.body, { status: answer.status ?? 200 });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const request = {
  order_ref: "co_1:ld_1",
  lines: [{ name: "One-page site on your domain", unit_cents: 9900, quantity: 1 }],
  countries: ["US"],
  shipping_options: [{ name: "Delivered by email", cents: 0 }],
  automatic_tax: false,
  success_url: "https://co-01.example/ld_1",
  cancel_url: "https://co-01.example/ld_1",
  expires_at: 1794207600,
  email: "front@folsomdental.example",
};

test("Stripe payments need STRIPE_SECRET_KEY", () => {
  assert.equal(createStripePayments({}), null);
  assert.equal(createStripePayments({ STRIPE_SECRET_KEY: "sk_test_1" })!.source, "stripe");
});

test("createCheckout opens a Stripe Checkout session for the lead, outside Managed Payments", async () => {
  const { calls, fetchImpl } = fakeFetch([{ body: { id: "cs_test_a1", url: "https://checkout.stripe.com/c/pay/cs_test_a1" } }]);
  const out = await createStripePayments({ STRIPE_SECRET_KEY: "sk_test_1" }, fetchImpl)!.createCheckout(request);

  assert.deepEqual(out, { checkout_ref: "cs_test_a1", url: "https://checkout.stripe.com/c/pay/cs_test_a1" });
  assert.equal(calls[0].url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(calls[0].init.method, "POST");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer sk_test_1");
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[0].init.body))), {
    mode: "payment",
    "managed_payments[enabled]": "false",
    client_reference_id: "co_1:ld_1",
    "metadata[order_ref]": "co_1:ld_1",
    success_url: "https://co-01.example/ld_1",
    cancel_url: "https://co-01.example/ld_1",
    expires_at: "1794207600",
    customer_email: "front@folsomdental.example",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": "9900",
    "line_items[0][price_data][product_data][name]": "One-page site on your domain",
    "line_items[0][quantity]": "1",
  });
});

test("getCheckout reads paid, the total, the refunded amount and livemode from the session", async () => {
  const paid = { id: "cs_1", payment_status: "paid", amount_total: 9900, livemode: false, payment_intent: { id: "pi_1", latest_charge: { amount_refunded: 2500 } } };
  const open = { id: "cs_2", payment_status: "unpaid", amount_total: 9900, livemode: false, payment_intent: null };
  const { calls, fetchImpl } = fakeFetch([{ body: paid }, { body: open }]);
  const stripe = createStripePayments({ STRIPE_SECRET_KEY: "sk_test_1" }, fetchImpl)!;

  assert.deepEqual(await stripe.getCheckout("cs_1"), { paid: true, amount_cents: 9900, refunded_cents: 2500, livemode: false });
  assert.deepEqual(await stripe.getCheckout("cs_2"), { paid: false, amount_cents: 9900, refunded_cents: 0, livemode: false });
  assert.equal(calls[0].url, "https://api.stripe.com/v1/checkout/sessions/cs_1?expand%5B%5D=payment_intent.latest_charge");
});

test("checkoutForPaymentIntent finds the session a refunded charge belongs to", async () => {
  const { calls, fetchImpl } = fakeFetch([{ body: { data: [{ id: "cs_1" }] } }, { body: { data: [] } }]);
  const stripe = createStripePayments({ STRIPE_SECRET_KEY: "sk_test_1" }, fetchImpl)!;
  assert.equal(await stripe.checkoutForPaymentIntent("pi_1"), "cs_1");
  assert.equal(await stripe.checkoutForPaymentIntent("pi_2"), null);
  assert.equal(calls[0].url, "https://api.stripe.com/v1/checkout/sessions?payment_intent=pi_1&limit=1");
});

test("a refused Stripe call carries Stripe's status and message", async () => {
  const { fetchImpl } = fakeFetch([{ status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key provided" } } }]);
  await assert.rejects(createStripePayments({ STRIPE_SECRET_KEY: "sk_test_1" }, fetchImpl)!.getCheckout("cs_1"), { status: 401, message: "Invalid API Key provided" });
});

test("verifyStripeSignature accepts only Stripe's signature over this payload, recently", () => {
  const payload = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature(payload, sign(payload), SECRET, NOW), true);
  assert.equal(verifyStripeSignature(payload, `${sign(payload, nowSec, "whsec_other")},v1=${sign(payload).split("v1=")[1]}`, SECRET, NOW), true);
  assert.equal(verifyStripeSignature(payload, sign(payload, nowSec, "whsec_other"), SECRET, NOW), false);
  assert.equal(verifyStripeSignature('{"id":"evt_2"}', sign(payload), SECRET, NOW), false);
  assert.equal(verifyStripeSignature(payload, sign(payload, nowSec - 301), SECRET, NOW), false);
  assert.equal(verifyStripeSignature(payload, `t=${nowSec},v1=abc`, SECRET, NOW), false);
  assert.equal(verifyStripeSignature(payload, null, SECRET, NOW), false);
});

async function stripeCompany() {
  const s = await spawned(1);
  await run(fund, s.ctx, { company_id: s.companyId, reason: "go" });
  const stripe = new FakePayments("stripe");
  s.ctx.payments = stripe;
  await run(checkoutLink, s.ctx, { company_id: s.companyId, lead_id: s.leadIds[0] });
  const post = (event: unknown, signature?: string) => {
    const payload = JSON.stringify(event);
    const req = new Request("https://foundry.example/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signature ?? sign(payload) }, body: payload });
    return stripeWebhookResponse(req, s.ctx, stripe, SECRET, NOW);
  };
  return { ...s, stripe, post };
}

const completed = (ref: string) => ({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: ref, object: "checkout.session" } } });

test("a signed checkout.session.completed records a Stripe payment and wakes the Closer", async () => {
  const s = await stripeCompany();
  s.stripe.pay("cs_test_1");

  const res = await s.post(completed("cs_test_1"));

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { outcome: string }).outcome, "recorded");
  const [row] = await s.ctx.db.query<{ source: string; external_ref: string; amount_cents: number }>("select source, external_ref, amount_cents from payments");
  assert.deepEqual(row, { source: "stripe", external_ref: "cs_test_1", amount_cents: 9900 });
  assert.equal(s.naive.cards.filter((c) => c.assignee === "co-01-closer").length, 1);
});

test("the Stripe webhook refuses a bad signature and changes nothing", async () => {
  const s = await stripeCompany();
  s.stripe.pay("cs_test_1");
  const res = await s.post(completed("cs_test_1"), sign("{}"));
  assert.equal(res.status, 400);
  assert.deepEqual(await s.ctx.db.query("select 1 from payments"), []);
});

test("charge.refunded finds the checkout through its payment intent and updates the refund", async () => {
  const s = await stripeCompany();
  s.stripe.pay("cs_test_1");
  await s.post(completed("cs_test_1"));
  s.stripe.refund("cs_test_1", 9900);

  const res = await s.post({ id: "evt_2", type: "charge.refunded", data: { object: { id: "ch_1", object: "charge", payment_intent: "pi_cs_test_1" } } });

  assert.equal(((await res.json()) as { outcome: string }).outcome, "updated");
  const [row] = await s.ctx.db.query<{ refunded_cents: number }>("select refunded_cents from payments");
  assert.equal(row.refunded_cents, 9900);
});

test("the Stripe webhook ignores events that name no checkout, and answers 503 until it's set up", async () => {
  const s = await stripeCompany();
  const res = await s.post({ id: "evt_3", type: "customer.created", data: { object: { id: "cus_1", object: "customer" } } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { outcome: "ignored", reason: "customer.created names no checkout" });

  const req = new Request("https://foundry.example/api/stripe/webhook", { method: "POST", body: "{}" });
  assert.equal((await stripeWebhookResponse(req, s.ctx, null, SECRET, NOW)).status, 503);
  assert.equal((await stripeWebhookResponse(req, s.ctx, s.stripe, undefined, NOW)).status, 503);
});
