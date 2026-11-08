import assert from "node:assert/strict";
import test from "node:test";
import { createNaivePayments } from "../src/lib/server/naive";

const ENV = { NAIVE_API_KEY: "app-key", FOUNDRY_APP_ID: "app_foundry", NAIVE_API_URL: "https://api.vetta.sh" };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Response.json(body, { status });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const request = {
  order_ref: "co_1:ld_1",
  lines: [{ name: "One-page site", unit_cents: 9900, quantity: 1 }],
  countries: ["US"],
  shipping_options: [{ name: "Delivered by email", cents: 0 }],
  automatic_tax: false,
  success_url: "https://co-01.example/ld_1",
  cancel_url: "https://co-01.example/ld_1",
  expires_at: 1794207600,
};

test("payments need both the app's own key and its id", () => {
  assert.equal(createNaivePayments({ FOUNDRY_APP_ID: "app_foundry" }), null);
  assert.equal(createNaivePayments({ NAIVE_API_KEY: "app-key" }), null);
});

test("createCheckout posts to the foundry app's checkouts with the app's own key", async () => {
  const { calls, fetchImpl } = fakeFetch(200, { checkout_ref: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
  const out = await createNaivePayments(ENV, fetchImpl)!.createCheckout(request);
  assert.deepEqual(out, { checkout_ref: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
  assert.equal(calls[0].url, "https://api.vetta.sh/v1/apps/app_foundry/payments/checkouts");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer app-key");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), request);
});

test("getCheckout reads whether it is paid from paid or status", async () => {
  const fields = { amount_cents: 9900, tax_cents: 0, shipping_cents: 0, refunded_cents: 0, livemode: false };
  for (const [answer, paid] of [
    [{ paid: true }, true],
    [{ status: "paid" }, true],
    [{ payment_status: "unpaid" }, false],
    [{ status: "complete", payment_status: "paid" }, true],
  ] as const) {
    const { calls, fetchImpl } = fakeFetch(200, { ...fields, ...answer });
    assert.deepEqual(await createNaivePayments(ENV, fetchImpl)!.getCheckout("cs_1"), { paid, amount_cents: 9900, refunded_cents: 0, livemode: false });
    assert.equal(calls[0].url, "https://api.vetta.sh/v1/apps/app_foundry/payments/checkouts/cs_1");
  }
});

test("getCheckout fails loudly on an answer with no paid state, naming the fields it got", async () => {
  const { fetchImpl } = fakeFetch(200, { amount_cents: 9900, refunded_cents: 0, livemode: false, state: "complete" });
  await assert.rejects(createNaivePayments(ENV, fetchImpl)!.getCheckout("cs_1"), /no paid state.*amount_cents, refunded_cents, livemode, state/);
});

test("a refused call carries Naïve's status and message", async () => {
  const { fetchImpl } = fakeFetch(409, { error: { code: "conflict", message: "this app's account can't take payments yet" } });
  await assert.rejects(createNaivePayments(ENV, fetchImpl)!.createCheckout(request), { status: 409, message: "this app's account can't take payments yet" });
});
