import { handleStripeWebhook } from "@/lib/billing";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/billing/webhook — Stripe events, verified by signature. Credits tokens for paid Checkout Sessions. */
export const POST = handle(async (req) => handleStripeWebhook(await req.text(), req.headers.get("stripe-signature")));
