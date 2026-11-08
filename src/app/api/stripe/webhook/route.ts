import { appContext } from "@/lib/server/context";
import { stripeWebhookResponse } from "@/lib/server/foundry/payments";
import { createStripePayments } from "@/lib/server/stripe";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return stripeWebhookResponse(request, appContext(), createStripePayments(process.env), process.env.STRIPE_WEBHOOK_SECRET);
}
