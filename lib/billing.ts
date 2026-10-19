import "server-only";
import Stripe from "stripe";
import { GatewayError } from "./errors";
import { log } from "./log";
import { topUp } from "./ledger";

/**
 * Token bundles paid with Stripe Checkout. Tokens are credited only by the
 * signed webhook (never by the browser's return), once per Checkout Session.
 * Card payments are the only way to add tokens; without STRIPE_SECRET_KEY nobody can buy any.
 */

export const BUNDLES = {
  starter: { tokens: 500, amountCents: 4900, label: "500 tokens" },
  growth: { tokens: 1500, amountCents: 12900, label: "1,500 tokens" },
} as const;
export type BundleId = keyof typeof BUNDLES;

let client: Stripe | undefined;
function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new GatewayError("AGENT_UNAVAILABLE", "Payments aren't set up on this server.");
  client ??= new Stripe(key);
  return client;
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export async function createCheckout(userId: string, email: string | undefined, bundle: BundleId, origin: string): Promise<string> {
  const b = BUNDLES[bundle];
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    client_reference_id: userId,
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: b.amountCents,
          product_data: { name: `AgentGig · ${b.label}`, description: "Task tokens for your AI employees. Tokens don't expire." },
        },
      },
    ],
    metadata: { userId, tokens: String(b.tokens), bundle },
    payment_intent_data: { metadata: { userId, bundle } },
    success_url: `${origin}/workforce?topup=success`,
    cancel_url: `${origin}/workforce?topup=cancelled`,
  });
  if (!session.url) throw new GatewayError("AGENT_FAILED", "Stripe didn't return a checkout page.");
  return session.url;
}

/** Verifies and applies a Stripe webhook. Safe to receive the same event many times. */
export async function handleStripeWebhook(rawBody: string, signature: string | null): Promise<{ received: true; credited?: number }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signature) throw new GatewayError("UNAUTHENTICATED", "Missing webhook signature.");
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new GatewayError("UNAUTHENTICATED", "Invalid webhook signature.");
  }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return { received: true };

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") return { received: true };
  const userId = session.metadata?.userId ?? session.client_reference_id;
  const tokens = Number(session.metadata?.tokens);
  if (!userId || !Number.isInteger(tokens) || tokens <= 0) {
    log("ERROR", "stripe.session_without_metadata", { component: "billing", session: session.id });
    return { received: true };
  }
  const paid = ((session.amount_total ?? 0) / 100).toFixed(2);
  await topUp(userId, tokens, `Top-up · ${tokens} tokens ($${paid}, card)`, `stripe_${session.id}`);
  log("INFO", "stripe.credited", { component: "billing", session: session.id, tokens });
  return { received: true, credited: tokens };
}
