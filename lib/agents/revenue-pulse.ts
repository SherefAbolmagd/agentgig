import { z } from "zod";
import { paypalSales } from "@/lib/connectors/paypal";
import { squareSales, type SalesSummary } from "@/lib/connectors/square";
import { stripeSnapshot, type StripeSnapshot } from "@/lib/connectors/stripe-data";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { deliverDrafts, type DraftEmail } from "./drafts";
import { defineAgent, groundingPrompt } from "./types";

/**
 * Revenue Pulse: takings from Stripe, Square and PayPal for the period
 * (computed in code), plus payment-reminder drafts for Stripe's overdue
 * invoices and failed payments.
 */

export const RevenueInput = z.object({ periodDays: z.number().int().min(1).max(90).default(7) });
export type RevenueInput = z.infer<typeof RevenueInput>;

const ModelOutput = z.object({
  headline: z.string().describe("One sentence: the period in revenue"),
  observations: z.array(z.string()).max(4).describe("Plain-English points the owner should know, using only the figures given"),
  reminders: z.array(z.object({ ref: z.number().int(), subject: z.string(), body: z.string() })),
});

export type Channel = SalesSummary & { changePct: number | null };

export type RevenueOutput = {
  periodDays: number;
  channels: Channel[];
  stripe: Pick<StripeSnapshot, "failedPayments" | "overdueInvoices" | "activeSubscriptions" | "mrr" | "currency"> | null;
  headline: string;
  observations: string[];
  reminders: DraftEmail[];
};

export function changePct(now: number, before: number): number | null {
  return before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null;
}

export const revenuePulse = defineAgent<RevenueInput, RevenueOutput>({
  slug: "revenue-pulse",
  skillId: "revenue.weekly",
  tier: "flash",
  inputSchema: RevenueInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    const days = input.periodDays;
    const [s, sq, pp] = await Promise.all([stripeSnapshot(userId, days), squareSales(userId, days), paypalSales(userId, days)]);
    if (!s && !sq && !pp) throw new GatewayError("INVALID_INPUT", "Connect Stripe, Square or PayPal so Revenue Pulse can read your takings.");
    const channels: Channel[] = [
      ...(s ? [{ source: "Stripe", currency: s.currency.toUpperCase(), gross: s.grossThisPeriod, prevGross: s.grossPrevPeriod, refunds: s.refunds, count: s.chargeCount, disputes: 0 }] : []),
      ...(sq ? [sq] : []),
      ...(pp ? [pp] : []),
    ].map((c) => ({ ...c, changePct: changePct(c.gross, c.prevGross) }));

    // People who owe money (Stripe), for reminder drafts; the model gets names and amounts, not email addresses.
    const cur = s?.currency.toUpperCase() ?? "";
    const owed = s
      ? [
          ...s.overdueInvoices.map((i) => ({ name: i.customerName, email: i.customerEmail, what: `invoice ${i.number ?? ""} of ${i.amountDue} ${cur} due ${i.dueDate}`, link: i.hostedUrl })),
          ...s.failedPayments.map((f) => ({ name: f.customerName, email: f.customerEmail, what: `a card payment of ${f.amount} ${cur} that failed (${f.reason ?? "declined"})`, link: null })),
        ]
          .filter((o) => o.email)
          .slice(0, 10)
          .map((o, ref) => ({ ...o, ref }))
      : [];
    const figures = [
      ...channels.map((c) => `${c.source}, last ${days} days: ${c.gross} ${c.currency} from ${c.count} payments (period before ${c.prevGross}${c.changePct !== null ? `, ${c.changePct > 0 ? "+" : ""}${c.changePct}%` : ""}). Refunds ${c.refunds}.${c.disputes ? ` Open disputes ${c.disputes}.` : ""}`),
      ...(s ? [`Stripe: failed payments ${s.failedPayments.length}, overdue invoices ${s.overdueInvoices.length}, active subscriptions ${s.activeSubscriptions}, MRR ${s.mrr}.`] : []),
    ].join("\n");
    const res = await generateJson({
      tier: "flash",
      system:
        "You're a small business's finance assistant. Summarise the figures in plain English without recalculating or adding them across currencies, then write a short, friendly payment reminder for each person listed (include the payment link if given). Never threaten or add fees.",
      parts: [textPart(`${groundingPrompt(grounding)}\n\nFigures:\n${figures}\n\nPeople to remind:\n${owed.map((o) => `ref ${o.ref}: ${o.name ?? "customer"} — ${o.what}${o.link ? ` (pay here: ${o.link})` : ""}`).join("\n") || "none"}`)],
      schema: ModelOutput,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    const reminders = res.data.reminders.filter((r) => owed[r.ref]).map((r) => ({ to: owed[r.ref].email, subject: r.subject, body: r.body, label: owed[r.ref].name ?? owed[r.ref].email! }));
    return {
      ...res,
      output: {
        periodDays: days,
        channels,
        stripe: s ? { currency: s.currency, failedPayments: s.failedPayments, overdueInvoices: s.overdueInvoices, activeSubscriptions: s.activeSubscriptions, mrr: s.mrr } : null,
        headline: res.data.headline,
        observations: res.data.observations,
        reminders,
      },
      notes: [`Read ${channels.map((c) => c.source).join(", ")}`],
    };
  },

  approval(o) {
    const chase = o.stripe ? o.stripe.overdueInvoices.length + o.stripe.failedPayments.length : 0;
    const disputes = o.channels.reduce((n, c) => n + c.disputes, 0);
    return {
      title: o.reminders.length ? `${o.headline} · ${o.reminders.length} reminders drafted` : o.headline,
      preview: o.observations[0] ?? "",
      severity: chase || disputes ? "check" : "info",
      actions: [
        { id: "approve", label: o.reminders.length ? "Save reminders as email drafts" : "OK", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  deliver: (o, { userId }) => deliverDrafts(userId, o.reminders, "payment reminders"),
});
