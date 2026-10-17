import "server-only";
import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { putSecret, readSecret } from "@/lib/secrets";
import { COLLECTIONS } from "@/types/firestore";
import { keyFields, type KeyTester } from "./keys";

/**
 * The owner's own Stripe account, through a restricted key. Mostly read-only;
 * the only writes are a refund or a payment link the owner approved, and the
 * webhook that tells AgentGig about failed payments.
 * (Separate from lib/billing.ts, which is AgentGig's account for token sales.)
 */

function client(key: string) {
  if (!/^rk_(live|test)_/.test(key)) {
    throw new GatewayError("INVALID_INPUT", "Use a restricted key (starts with rk_), not your secret key, so AgentGig only gets the access you choose.");
  }
  return new Stripe(key, { maxNetworkRetries: 1, timeout: 20_000 });
}

function stripeError(err: unknown): never {
  const e = err as { type?: string; statusCode?: number; message?: string };
  if (e.type === "StripeAuthenticationError" || e.statusCode === 401) throw new GatewayError("INVALID_INPUT", "Stripe rejected that key. Check it was copied in full.");
  if (e.type === "StripePermissionError" || e.statusCode === 403) throw new GatewayError("INVALID_INPUT", `Stripe: the key is missing a permission. ${e.message ?? ""}`.trim());
  throw new GatewayError("AGENT_FAILED", `Stripe: ${e.message ?? "request failed"}`);
}

export const testStripe: KeyTester = async (f) => {
  const s = client(f.restrictedKey);
  try {
    const balance = await s.balance.retrieve();
    const mode = f.restrictedKey.startsWith("rk_live_") ? "live" : "test";
    return { accountLabel: `Stripe · ${mode} mode`, meta: { mode, currency: balance.available[0]?.currency ?? "usd" } };
  } catch (err) {
    stripeError(err);
  }
};

export interface StripeSnapshot {
  currency: string;
  periodDays: number;
  grossThisPeriod: number;
  grossPrevPeriod: number;
  refunds: number;
  chargeCount: number;
  failedPayments: { customerEmail: string | null; customerName: string | null; amount: number; reason: string | null; at: string }[];
  overdueInvoices: { number: string | null; customerEmail: string | null; customerName: string | null; amountDue: number; dueDate: string | null; hostedUrl: string | null }[];
  activeSubscriptions: number;
  mrr: number;
}

const dollars = (cents: number) => Math.round(cents) / 100;

/** Revenue, refunds, failed payments, overdue invoices and MRR over the last `days` days. */
export async function stripeSnapshot(userId: string, days = 7): Promise<StripeSnapshot | null> {
  const k = await keyFields(userId, "stripe");
  if (!k) return null;
  const s = client(k.fields.restrictedKey);
  const now = Math.floor(Date.now() / 1000);
  const start = now - days * 86_400;
  const prevStart = start - days * 86_400;
  try {
    const charges = await s.charges.list({ created: { gte: prevStart }, limit: 100, expand: ["data.customer"] }).autoPagingToArray({ limit: 2000 });
    const current = charges.filter((c) => c.created >= start);
    const previous = charges.filter((c) => c.created < start);
    const ok = (c: Stripe.Charge) => c.paid && c.status === "succeeded";
    const failed = current.filter((c) => c.status === "failed");
    const invoices = await s.invoices.list({ status: "open", limit: 100, expand: ["data.customer"] }).autoPagingToArray({ limit: 500 });
    const overdue = invoices.filter((i) => i.due_date && i.due_date < now);
    const subs = await s.subscriptions.list({ status: "active", limit: 100 }).autoPagingToArray({ limit: 1000 });
    const mrr = subs.reduce((sum, sub) => {
      for (const item of sub.items.data) {
        const p = item.price;
        const unit = (p.unit_amount ?? 0) * (item.quantity ?? 1);
        const perMonth = p.recurring?.interval === "year" ? unit / 12 : p.recurring?.interval === "week" ? unit * 52 / 12 : p.recurring?.interval === "day" ? unit * 365 / 12 : unit;
        sum += perMonth / (p.recurring?.interval_count ?? 1);
      }
      return sum;
    }, 0);
    const cust = (c: string | Stripe.Customer | Stripe.DeletedCustomer | null) => (c && typeof c === "object" && !("deleted" in c && c.deleted) ? (c as Stripe.Customer) : null);
    return {
      currency: (current[0]?.currency ?? k.conn.meta?.currency ?? "usd") as string,
      periodDays: days,
      grossThisPeriod: dollars(current.filter(ok).reduce((t, c) => t + c.amount, 0)),
      grossPrevPeriod: dollars(previous.filter(ok).reduce((t, c) => t + c.amount, 0)),
      refunds: dollars(current.reduce((t, c) => t + c.amount_refunded, 0)),
      chargeCount: current.filter(ok).length,
      failedPayments: failed.slice(0, 20).map((c) => ({
        customerEmail: cust(c.customer)?.email ?? c.billing_details.email ?? null,
        customerName: cust(c.customer)?.name ?? c.billing_details.name ?? null,
        amount: dollars(c.amount),
        reason: c.outcome?.seller_message ?? c.failure_message ?? null,
        at: new Date(c.created * 1000).toISOString(),
      })),
      overdueInvoices: overdue.slice(0, 20).map((i) => ({
        number: i.number,
        customerEmail: i.customer_email ?? cust(i.customer)?.email ?? null,
        customerName: i.customer_name ?? cust(i.customer)?.name ?? null,
        amountDue: dollars(i.amount_due),
        dueDate: i.due_date ? new Date(i.due_date * 1000).toISOString().slice(0, 10) : null,
        hostedUrl: i.hosted_invoice_url ?? null,
      })),
      activeSubscriptions: subs.length,
      mrr: dollars(mrr),
    };
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    stripeError(err);
  }
}

/* ---------- Events, refunds and payment links ---------- */

async function stripeFor(userId: string) {
  const k = await keyFields(userId, "stripe");
  return k ? { s: client(k.fields.restrictedKey), conn: k.conn } : null;
}

export const STRIPE_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = ["payment_intent.payment_failed"];

/**
 * Makes sure Stripe calls AgentGig about failed payments: one webhook endpoint
 * per account at /api/webhooks/stripe/{hookId}, its signing secret kept in
 * Secret Manager. Needs Write access to Webhook endpoints on the key.
 */
export async function stripeEnsureWebhook(userId: string, baseUrl: string): Promise<"created" | "exists" | null> {
  const c = await stripeFor(userId);
  if (!c) return null;
  const hook = c.conn.meta?.stripeHook as { endpointId: string; hookId: string; secretRef: string } | undefined;
  try {
    if (hook) {
      const ep = await c.s.webhookEndpoints.retrieve(hook.endpointId).catch(() => null);
      if (ep && ep.status === "enabled" && ep.url === `${baseUrl}/api/webhooks/stripe/${hook.hookId}`) return "exists";
      if (ep) await c.s.webhookEndpoints.del(hook.endpointId).catch(() => undefined);
    }
    const hookId = randomBytes(18).toString("base64url");
    const ep = await c.s.webhookEndpoints.create({ url: `${baseUrl}/api/webhooks/stripe/${hookId}`, enabled_events: STRIPE_EVENTS, description: "AgentGig" });
    const secretRef = await putSecret(`stripe-hook-${userId}`.replace(/[^A-Za-z0-9_-]/g, "-"), ep.secret!);
    await db().collection(COLLECTIONS.connections).doc(`${userId}_stripe`).update({ "meta.stripeHook": { endpointId: ep.id, hookId, secretRef } });
    return "created";
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    stripeError(err);
  }
}

/** Checks a Stripe webhook's signature with the account's own signing secret. */
export async function stripeVerifyEvent(userId: string, body: string, signature: string, secretRef: string): Promise<Stripe.Event> {
  const c = await stripeFor(userId);
  if (!c) throw new GatewayError("UNAUTHENTICATED", "Stripe isn't connected.");
  try {
    return c.s.webhooks.constructEvent(body, signature, await readSecret(secretRef));
  } catch {
    throw new GatewayError("UNAUTHENTICATED", "Invalid Stripe signature.");
  }
}

export interface FailedPayment {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  reason: string | null;
  customerName: string | null;
  customerEmail: string | null;
}

export async function stripeFailedPayment(userId: string, paymentIntentId: string): Promise<FailedPayment | null> {
  const c = await stripeFor(userId);
  if (!c) return null;
  try {
    const pi = await c.s.paymentIntents.retrieve(paymentIntentId, { expand: ["customer", "latest_charge"] });
    const cust = pi.customer && typeof pi.customer === "object" && !("deleted" in pi.customer && pi.customer.deleted) ? (pi.customer as Stripe.Customer) : null;
    const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    return {
      id: pi.id,
      amount: dollars(pi.amount),
      currency: pi.currency,
      description: pi.description,
      reason: pi.last_payment_error?.message ?? charge?.outcome?.seller_message ?? null,
      customerName: cust?.name ?? charge?.billing_details.name ?? null,
      customerEmail: cust?.email ?? pi.receipt_email ?? charge?.billing_details.email ?? null,
    };
  } catch (err) {
    stripeError(err);
  }
}

export interface RefundablePayment {
  chargeId: string;
  paymentIntentId: string | null;
  amount: number;
  refundable: number;
  currency: string;
  createdAt: string;
}

/** The customer's most recent payment that can still be refunded, preferring one tagged with the order number. */
export async function stripeFindPayment(userId: string, q: { email: string; orderNumber?: string | null }): Promise<RefundablePayment | null> {
  const c = await stripeFor(userId);
  if (!c) return null;
  try {
    const customers = await c.s.customers.list({ email: q.email, limit: 5 });
    const charges = (await Promise.all(customers.data.map((cu) => c.s.charges.list({ customer: cu.id, limit: 20 })))).flatMap((l) => l.data);
    const open = charges.filter((ch) => ch.paid && ch.status === "succeeded" && ch.amount_refunded < ch.amount).sort((a, b) => b.created - a.created);
    const order = q.orderNumber?.replace(/^#/, "");
    const best = (order && open.find((ch) => String(ch.metadata?.order ?? "").replace(/^#/, "") === order)) || open[0];
    if (!best) return null;
    return {
      chargeId: best.id,
      paymentIntentId: typeof best.payment_intent === "string" ? best.payment_intent : (best.payment_intent?.id ?? null),
      amount: dollars(best.amount),
      refundable: dollars(best.amount - best.amount_refunded),
      currency: best.currency,
      createdAt: new Date(best.created * 1000).toISOString(),
    };
  } catch (err) {
    stripeError(err);
  }
}

/** Refunds part or all of a charge. Keyed by task, so a retry can't refund twice. Needs Write access to Refunds. */
export async function stripeRefund(userId: string, chargeId: string, amount: number, idempotencyKey: string): Promise<{ id: string; status: string | null; amount: number } | null> {
  const c = await stripeFor(userId);
  if (!c) return null;
  try {
    const r = await c.s.refunds.create({ charge: chargeId, amount: Math.round(amount * 100), reason: "requested_by_customer" }, { idempotencyKey });
    return { id: r.id, status: r.status, amount: dollars(r.amount) };
  } catch (err) {
    stripeError(err);
  }
}

/** A Stripe Checkout page to pay the same amount again (valid 24 hours). Needs Write access to Checkout Sessions. */
export async function stripePaymentLink(
  userId: string,
  p: { amount: number; currency: string; description: string; email: string | null; returnUrl: string },
  idempotencyKey: string,
): Promise<string | null> {
  const c = await stripeFor(userId);
  if (!c) return null;
  try {
    const session = await c.s.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: p.currency, unit_amount: Math.round(p.amount * 100), product_data: { name: p.description } } }],
        ...(p.email && { customer_email: p.email }),
        success_url: p.returnUrl,
      },
      { idempotencyKey },
    );
    return session.url;
  } catch (err) {
    stripeError(err);
  }
}
