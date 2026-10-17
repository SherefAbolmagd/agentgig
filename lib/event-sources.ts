import "server-only";
import { env } from "./env";
import { db } from "./firebase-admin";
import { log as writeLog } from "./log";
import { enqueue } from "./triggers";
import { ensureGmailWatch, EMAIL_EVENT } from "./email-trigger";
import { shopifyEnsureOrderWebhook, shopifyOrder } from "./connectors/shopify";
import { stripeEnsureWebhook, stripeVerifyEvent } from "./connectors/stripe-data";
import { COLLECTIONS, type ConnectionDoc, type HireDoc } from "@/types/firestore";

/**
 * Agents that start when something happens in the owner's tools. Each event
 * source is switched on for an account when an agent is hired with that
 * trigger, or when the tool is (re)connected:
 *   gmail.message          Gmail push via Pub/Sub (lib/email-trigger)
 *   shopify.order_created  Shopify webhook → /api/webhooks/shopify
 *   stripe.payment_failed  Stripe webhook → /api/webhooks/stripe/{hookId}
 */

export const SHOPIFY_ORDER_EVENT = "shopify.order_created";
export const STRIPE_FAILED_EVENT = "stripe.payment_failed";

function log(message: string, fields: Record<string, unknown>, severity: "INFO" | "WARNING" | "ERROR" = "INFO") {
  void writeLog(severity, message, { component: "events", ...fields });
}

/** Where Shopify and Stripe should call: the public address of this service. */
const baseUrl = () => env().PUBLIC_URL ?? env().APP_URL ?? null;

async function eventHires(userId: string): Promise<HireDoc[]> {
  const snap = await db().collection(COLLECTIONS.hires).where("userId", "==", userId).where("active", "==", true).get();
  return snap.docs.map((d) => d.data() as HireDoc).filter((h) => h.trigger.type === "event");
}

async function activeHire(userId: string, agentId: string, event: string): Promise<boolean> {
  const hire = (await db().collection(COLLECTIONS.hires).doc(`${userId}_${agentId}`).get()).data() as HireDoc | undefined;
  return !!hire?.active && hire.trigger.event === event;
}

/** Switches on every event source the account's hired agents need. Never throws; returns what happened per source. */
export async function ensureEventSources(userId: string): Promise<Record<string, string>> {
  const events = new Set((await eventHires(userId)).map((h) => h.trigger.event));
  const out: Record<string, string> = {};
  const attempt = async (name: string, fn: () => Promise<string | null>) => {
    try {
      out[name] = (await fn()) ?? "not connected";
    } catch (err) {
      out[name] = `failed: ${err instanceof Error ? err.message : String(err)}`;
      log("events.ensure_failed", { userId, source: name, error: out[name] }, "WARNING");
    }
  };
  const base = baseUrl();
  if (events.has(EMAIL_EVENT)) await attempt("gmail", () => ensureGmailWatch(userId));
  if (events.has(SHOPIFY_ORDER_EVENT)) await attempt("shopify", async () => (base ? shopifyEnsureOrderWebhook(userId, `${base}/api/webhooks/shopify`) : "no public address"));
  if (events.has(STRIPE_FAILED_EVENT)) await attempt("stripe", async () => (base ? stripeEnsureWebhook(userId, base) : "no public address"));
  if (Object.keys(out).length) log("events.ensured", { userId, ...out });
  return out;
}

/**
 * A Shopify "order created" webhook. Rather than trusting the payload, the
 * order is read back from the shop with the owner's own token, so a forged
 * call can only make us look at a real order, once.
 */
export async function onShopifyOrder(shopDomain: string, orderGid: string): Promise<string> {
  const snap = await db().collection(COLLECTIONS.connections).where("provider", "==", "shopify").where("meta.shopDomain", "==", shopDomain.toLowerCase()).limit(5).get();
  let queued = 0;
  for (const doc of snap.docs) {
    const conn = doc.data() as ConnectionDoc;
    if (conn.status !== "active" || !(await activeHire(conn.userId, "inventory-guardian", SHOPIFY_ORDER_EVENT))) continue;
    const order = await shopifyOrder(conn.userId, orderGid).catch(() => null);
    if (!order) continue;
    const id = orderGid.split("/").pop();
    const res = await enqueue({ key: `shopify-order-${conn.userId}-${id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100), userId: conn.userId, agentId: "inventory-guardian", input: { orderId: orderGid }, origin: "event" });
    if (res !== "duplicate") queued++;
  }
  log("events.shopify_order", { shopDomain, orderGid, queued });
  return queued ? `queued ${queued}` : "ignored";
}

/** A Stripe webhook for one account's endpoint, verified with that endpoint's signing secret. */
export async function onStripeWebhook(hookId: string, body: string, signature: string): Promise<string> {
  const snap = await db().collection(COLLECTIONS.connections).where("meta.stripeHook.hookId", "==", hookId).limit(1).get();
  const conn = snap.docs[0]?.data() as ConnectionDoc | undefined;
  if (!conn || conn.status !== "active") return "unknown endpoint";
  const hook = conn.meta!.stripeHook as { secretRef: string };
  const event = await stripeVerifyEvent(conn.userId, body, signature, hook.secretRef);
  if (event.type !== "payment_intent.payment_failed") return "ignored";
  if (!(await activeHire(conn.userId, "payment-rescue", STRIPE_FAILED_EVENT))) return "no payment-rescue hire";
  const pi = event.data.object as { id: string };
  await enqueue({ key: `stripe-${conn.userId}-${event.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100), userId: conn.userId, agentId: "payment-rescue", input: { paymentIntentId: pi.id }, origin: "event" });
  log("events.stripe_failed", { userId: conn.userId, event: event.id });
  return "queued";
}
