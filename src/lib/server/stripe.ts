import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PaymentsApi } from "./foundry/tool";

const STRIPE_API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 15_000;
// Stripe's own libraries refuse a signature more than five minutes old.
const SIGNATURE_TOLERANCE_SEC = 300;

export type StripePayments = PaymentsApi & { checkoutForPaymentIntent(paymentIntent: string): Promise<string | null> };

const CreatedSession = z.object({ id: z.string().min(1), url: z.url() });
const Session = z.object({
  payment_status: z.string(),
  amount_total: z.number().int(),
  livemode: z.boolean(),
  payment_intent: z.object({ latest_charge: z.object({ amount_refunded: z.number().int() }).nullable() }).nullable(),
});
const SessionList = z.object({ data: z.array(z.object({ id: z.string() })) });

export function createStripePayments(env: Partial<Record<string, string>>, fetchImpl: typeof fetch = fetch): StripePayments | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;

  async function call(path: string, form?: URLSearchParams): Promise<unknown> {
    const response = await fetchImpl(`${STRIPE_API}${path}`, {
      method: form ? "POST" : "GET",
      headers: { authorization: `Bearer ${key}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? `HTTP ${response.status}`), { status: response.status });
    return body;
  }

  return {
    source: "stripe",
    async createCheckout(request) {
      // Without this, our account refused a session for a missing Managed Payments tax code (Nov 8).
      // Stripe excludes design and development services like our offers from Managed Payments.
      const form = new URLSearchParams({
        mode: "payment",
        "managed_payments[enabled]": "false",
        client_reference_id: request.order_ref,
        "metadata[order_ref]": request.order_ref,
        success_url: request.success_url,
        cancel_url: request.cancel_url,
        expires_at: String(request.expires_at),
      });
      if (request.email) form.set("customer_email", request.email);
      request.lines.forEach((line, i) => {
        form.set(`line_items[${i}][price_data][currency]`, "usd");
        form.set(`line_items[${i}][price_data][unit_amount]`, String(line.unit_cents));
        form.set(`line_items[${i}][price_data][product_data][name]`, line.name);
        form.set(`line_items[${i}][quantity]`, String(line.quantity));
      });
      const session = CreatedSession.parse(await call("/checkout/sessions", form));
      return { checkout_ref: session.id, url: session.url };
    },
    async getCheckout(ref) {
      const query = new URLSearchParams({ "expand[]": "payment_intent.latest_charge" });
      const session = Session.parse(await call(`/checkout/sessions/${encodeURIComponent(ref)}?${query}`));
      return {
        paid: session.payment_status === "paid",
        amount_cents: session.amount_total,
        refunded_cents: session.payment_intent?.latest_charge?.amount_refunded ?? 0,
        livemode: session.livemode,
      };
    },
    async checkoutForPaymentIntent(paymentIntent) {
      const list = SessionList.parse(await call(`/checkout/sessions?${new URLSearchParams({ payment_intent: paymentIntent, limit: "1" })}`));
      return list.data[0]?.id ?? null;
    },
  };
}

// Stripe signs `<t>.<payload>` with the endpoint's signing secret and sends `t=<t>,v1=<hex>`, with one
// v1 per active secret while a secret is being rolled.
export function verifyStripeSignature(payload: string, header: string | null, secret: string, now: Date): boolean {
  if (!header) return false;
  const pairs = header.split(",").map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)] as const);
  const at = Number(pairs.find(([k]) => k === "t")?.[1]);
  if (!Number.isInteger(at) || Math.abs(now.getTime() / 1000 - at) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = createHmac("sha256", secret).update(`${at}.${payload}`).digest();
  return pairs.some(([k, v]) => {
    const given = Buffer.from(v, "hex");
    return k === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
