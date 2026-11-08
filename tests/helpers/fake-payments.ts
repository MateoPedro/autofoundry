import type { Checkout, CheckoutRequest, PaymentsApi } from "../../src/lib/server/foundry/tool";

// Stands in for Naïve's store checkouts or Stripe's. pay() and refund() play the buyer and the owner.
// A paid checkout's payment intent is pi_<ref>.
export class FakePayments implements PaymentsApi {
  constructor(readonly source: PaymentsApi["source"] = "naive_checkout") {}
  requests: CheckoutRequest[] = [];
  private states = new Map<string, Checkout>();
  failOn = new Set<"createCheckout" | "getCheckout">();
  private n = 0;

  async createCheckout(body: CheckoutRequest) {
    if (this.failOn.has("createCheckout")) throw Object.assign(new Error("this app's account can't take payments yet"), { status: 409 });
    this.requests.push(body);
    const ref = `cs_test_${++this.n}`;
    const amount = body.lines.reduce((sum, line) => sum + line.unit_cents * line.quantity, 0);
    this.states.set(ref, { paid: false, amount_cents: amount, refunded_cents: 0, livemode: false });
    return { checkout_ref: ref, url: `https://checkout.stripe.com/c/pay/${ref}` };
  }

  async getCheckout(ref: string) {
    if (this.failOn.has("getCheckout")) throw Object.assign(new Error("request timed out"), { status: 504 });
    const state = this.states.get(ref);
    if (!state) throw Object.assign(new Error(`no checkout ${ref}`), { status: 404 });
    return { ...state };
  }

  async checkoutForPaymentIntent(paymentIntent: string) {
    const ref = paymentIntent.replace(/^pi_/, "");
    return this.states.get(ref)?.paid ? ref : null;
  }

  pay(ref: string) {
    this.states.get(ref)!.paid = true;
  }

  refund(ref: string, cents: number) {
    this.states.get(ref)!.refunded_cents += cents;
  }
}
