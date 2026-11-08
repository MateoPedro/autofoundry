import { z } from "zod";
import { newId } from "../ids";
import { isAuthorized } from "../mcp/protocol";
import { verifyStripeSignature, type StripePayments } from "../stripe";
import { naiveStep, requireNaive } from "./company";
import { defineTool, ToolError, type Checkout, type PaymentsApi, type ToolContext } from "./tool";

// Stripe closes a checkout at most 24 hours after it opens.
const CHECKOUT_LIFETIME_MS = 23 * 3_600_000;
// An open checkout is sent again unless it closes within the hour.
const REUSE_MARGIN_MS = 3_600_000;
// Naïve requires a shipping option and a country even for a service. Nothing ships.
const SHIPPING = [{ name: "Delivered by email", cents: 0 }];
const COUNTRIES = ["US"];
const checkoutEmail = z.email().max(254);

function requirePayments(ctx: ToolContext): PaymentsApi {
  if (!ctx.payments) throw new ToolError("internal", "the foundry has no STRIPE_SECRET_KEY, or NAIVE_API_KEY and FOUNDRY_APP_ID, so it can't open checkouts");
  return ctx.payments;
}

export const checkoutLink = defineTool({
  name: "checkout_link",
  writes: true,
  description:
    'Closer only. A payment link for one lead at the offer\'s price; send it to them as is. When they pay, the foundry marks the lead paid and wakes you with a "Deliver" card. Asking again for the same lead returns the same link while it is open.',
  input: z.object({ company_id: z.string().min(1), lead_id: z.string().min(1) }),
  async run(ctx, input) {
    const payments = requirePayments(ctx);
    const [company] = await ctx.db.query<{ status: string; product: string; price_cents: number }>(
      "select c.status, o.product, o.price_cents from companies c join offers o on o.id = c.offer_id where c.id = $1",
      [input.company_id],
    );
    if (!company) throw new ToolError("not_found", `no company ${input.company_id}`);
    if (company.status === "killed") throw new ToolError("killed", `company ${input.company_id} is killed and takes no more work`);
    if (company.status !== "active") throw new ToolError("conflict", `company ${input.company_id} is ${company.status}, not active`);
    const [lead] = await ctx.db.query<{ id: string; email: string | null; status: string; sample_url: string | null }>(
      "select id, email, status, sample_url from leads where id = $1 and company_id = $2",
      [input.lead_id, input.company_id],
    );
    if (!lead) throw new ToolError("not_found", `no lead ${input.lead_id} in company ${input.company_id}`);
    if (lead.status === "paid") throw new ToolError("conflict", `lead ${lead.id} has already paid`);

    const now = ctx.now();
    const [open] = await ctx.db.query<{ url: string; amount_cents: number; expires_at: Date }>(
      "select url, amount_cents, expires_at from checkouts where lead_id = $1 and expires_at > $2 order by expires_at desc limit 1",
      [lead.id, new Date(now.getTime() + REUSE_MARGIN_MS)],
    );
    if (open) return { url: open.url, amount_cents: open.amount_cents, expires_at: new Date(open.expires_at).toISOString() };

    const [app] = await ctx.db.query<{ name: string | null }>("select name from company_resources where company_id = $1 and kind = 'app'", [input.company_id]);
    const returnUrl = lead.sample_url ?? app?.name;
    if (!returnUrl) throw new ToolError("conflict", `company ${input.company_id} has no site to send the buyer back to`);
    const expiresAt = new Date(now.getTime() + CHECKOUT_LIFETIME_MS);
    const checkout = await naiveStep("open the checkout", () =>
      payments.createCheckout({
        order_ref: `${input.company_id}:${lead.id}`,
        lines: [{ name: company.product.slice(0, 250), unit_cents: company.price_cents, quantity: 1 }],
        countries: COUNTRIES,
        shipping_options: SHIPPING,
        automatic_tax: false,
        success_url: returnUrl,
        cancel_url: returnUrl,
        expires_at: Math.floor(expiresAt.getTime() / 1000),
        ...(checkoutEmail.safeParse(lead.email).success ? { email: lead.email! } : {}),
      }),
    );
    await ctx.db.query("insert into checkouts (ref, company_id, lead_id, amount_cents, url, expires_at) values ($1, $2, $3, $4, $5, $6)", [
      checkout.checkout_ref,
      input.company_id,
      lead.id,
      company.price_cents,
      checkout.url,
      expiresAt,
    ]);
    return { url: checkout.url, amount_cents: company.price_cents, expires_at: expiresAt.toISOString() };
  },
});

const OrderEvent = z.object({ checkout_ref: z.string().min(1) });

// POST /api/orders/events. Naïve authenticates with the app's MCP bearer. A non-2xx answer
// leaves the event unhandled, in case Naïve delivers it again; a replay is harmless.
export async function orderEventResponse(request: Request, ctx: ToolContext, token: string | undefined): Promise<Response> {
  if (!isAuthorized(request.headers.get("authorization"), token)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const event = OrderEvent.safeParse(await request.json().catch(() => null));
  if (!event.success) return Response.json({ error: { code: "invalid", message: "the event has no checkout_ref" } }, { status: 400 });
  return answer(() => handleOrderEvent(ctx, event.data));
}

type StripeEvent = { type: string; data: { object: { id: string; payment_intent?: string | null } } };

// POST /api/stripe/webhook. Stripe signs each event with the endpoint's secret.
export async function stripeWebhookResponse(
  request: Request,
  ctx: ToolContext,
  stripe: StripePayments | null,
  secret: string | undefined,
  now = new Date(),
): Promise<Response> {
  if (!stripe || !secret) {
    return Response.json({ error: { code: "internal", message: "the foundry has no STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET" } }, { status: 503 });
  }
  const payload = await request.text();
  if (!verifyStripeSignature(payload, request.headers.get("stripe-signature"), secret, now)) {
    return Response.json({ error: { code: "invalid", message: "the Stripe signature doesn't match" } }, { status: 400 });
  }
  const event = JSON.parse(payload) as StripeEvent;
  return answer(async () => {
    const ref = await stripeCheckoutRef(event, stripe);
    if (!ref) return { outcome: "ignored", reason: `${event.type} names no checkout` };
    return handleOrderEvent({ ...ctx, payments: stripe }, { checkout_ref: ref });
  });
}

// A refund event names a charge, so its checkout is found by the charge's payment intent.
async function stripeCheckoutRef(event: StripeEvent, stripe: StripePayments): Promise<string | null> {
  if (event.type.startsWith("checkout.session.")) return event.data.object.id;
  const paymentIntent = event.data.object.payment_intent;
  if (event.type !== "charge.refunded" || !paymentIntent) return null;
  return naiveStep("find the refunded checkout", () => stripe.checkoutForPaymentIntent(paymentIntent));
}

async function answer(handle: () => Promise<OrderOutcome>): Promise<Response> {
  try {
    return Response.json(await handle());
  } catch (error) {
    if (error instanceof ToolError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "naive_error" ? 502 : 500 });
    console.error("order event failed", error);
    return Response.json({ error: { code: "internal", message: "the foundry logged the details" } }, { status: 500 });
  }
}

export type OrderOutcome =
  | { outcome: "ignored"; reason: string }
  | { outcome: "recorded" | "updated" | "unchanged"; payment_id: string; lead_id: string; delivered_to: string };

// Only the checkout's ref is trusted from an event. The checkout read back from Naïve or Stripe
// says whether it's paid, and the checkouts row says which lead it was for.
export async function handleOrderEvent(ctx: ToolContext, event: { checkout_ref: string }): Promise<OrderOutcome> {
  const payments = requirePayments(ctx);
  const ref = event.checkout_ref;
  const [checkout] = await ctx.db.query<{ company_id: string; lead_id: string }>("select company_id, lead_id from checkouts where ref = $1", [ref]);
  if (!checkout) return { outcome: "ignored", reason: `no checkout ${ref} from checkout_link` };
  const state = await naiveStep("read the checkout back", () => payments.getCheckout(ref));
  if (!state.paid) return { outcome: "ignored", reason: `checkout ${ref} is not paid` };

  // The payment is committed before the Closer is woken, so a failed card can't lose it, and
  // the next delivery of the event creates the card.
  const { id, outcome } = await ctx.db.tx(async (db) => {
    const [inserted] = await db.query<{ id: string }>(
      `insert into payments (id, company_id, lead_id, amount_cents, refunded_cents, source, external_ref, livemode)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (external_ref) do nothing returning id`,
      [newId("py"), checkout.company_id, checkout.lead_id, state.amount_cents, state.refunded_cents, payments.source, ref, state.livemode],
    );
    if (inserted) {
      await db.query("update leads set status = 'paid' where id = $1", [checkout.lead_id]);
      return { id: inserted.id, outcome: "recorded" as const };
    }
    const [existing] = await db.query<{ id: string; refunded_cents: number }>("select id, refunded_cents from payments where external_ref = $1 for update", [ref]);
    if (existing.refunded_cents === state.refunded_cents) return { id: existing.id, outcome: "unchanged" as const };
    await db.query("update payments set refunded_cents = $2 where id = $1", [existing.id, state.refunded_cents]);
    return { id: existing.id, outcome: "updated" as const };
  });

  const deliveredTo = await wakeCloser(ctx, checkout.company_id, checkout.lead_id, state);
  return { outcome, payment_id: id, lead_id: checkout.lead_id, delivered_to: deliveredTo };
}

// One "Deliver" card per lead, on the Builder's board like Outreach's cards. The key keeps a
// second payment from the same lead from waking the Closer twice.
async function wakeCloser(ctx: ToolContext, companyId: string, leadId: string, state: Checkout): Promise<string> {
  const naive = requireNaive(ctx);
  const cardName = `${leadId}:deliver`;
  const resources = await ctx.db.query<{ kind: string; role: string | null; naive_id: string; name: string | null }>(
    "select kind, role, naive_id, name from company_resources where company_id = $1 and (kind = 'agent' or (kind = 'card' and name = $2))",
    [companyId, cardName],
  );
  const builder = resources.find((r) => r.role === "builder");
  const closer = resources.find((r) => r.role === "closer");
  if (!builder || !closer?.name) throw new ToolError("conflict", `company ${companyId} has no Builder or Closer`);
  if (resources.some((r) => r.kind === "card")) return closer.name;

  const [lead] = await ctx.db.query<{ id: string; name: string; url: string | null; email: string | null; sample_url: string | null }>(
    "select id, name, url, email, sample_url from leads where id = $1",
    [leadId],
  );
  const body = JSON.stringify({
    lead_id: lead.id,
    name: lead.name,
    url: lead.url,
    email: lead.email,
    sample_url: lead.sample_url,
    payment: { amount_cents: state.amount_cents, livemode: state.livemode },
  });
  const board = await naiveStep("open the Builder's board", () => naive.ensureBoard(builder.naive_id));
  const card = await naiveStep("wake the Closer", () =>
    naive.createCard(board.id, { title: `Deliver: ${lead.name}`, body, assignee: closer.name!, key: `${companyId}:${cardName}` }),
  );
  await ctx.db.query("insert into company_resources (company_id, kind, naive_id, name) values ($1, 'card', $2, $3) on conflict do nothing", [
    companyId,
    card.id,
    cardName,
  ]);
  return closer.name;
}
