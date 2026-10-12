import "server-only";
import Stripe from "stripe";
import { GatewayError } from "@/lib/errors";
import { keyFields, type KeyTester } from "./keys";

/**
 * The owner's own Stripe account, read through a restricted read-only key.
 * (Separate from lib/billing.ts, which is AgentGig's account for token sales.)
 */

function client(key: string) {
  if (!/^rk_(live|test)_/.test(key)) {
    throw new GatewayError("INVALID_INPUT", "Use a restricted key (starts with rk_), not your secret key. It keeps AgentGig read-only.");
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
