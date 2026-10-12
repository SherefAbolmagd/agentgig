import { z } from "zod";
import { stripeSnapshot, type StripeSnapshot } from "@/lib/connectors/stripe-data";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { deliverDrafts, type DraftEmail } from "./drafts";
import { defineAgent, groundingPrompt } from "./types";

/** Revenue Pulse: weekly Stripe figures (computed in code) and payment-reminder drafts. */

export const RevenueInput = z.object({ periodDays: z.number().int().min(1).max(90).default(7) });
export type RevenueInput = z.infer<typeof RevenueInput>;

const ModelOutput = z.object({
  headline: z.string().describe("One sentence: the week in revenue"),
  observations: z.array(z.string()).max(4).describe("Plain-English points the owner should know, using only the figures given"),
  reminders: z.array(z.object({ ref: z.number().int(), subject: z.string(), body: z.string() })),
});

export type RevenueOutput = { [K in keyof StripeSnapshot]: StripeSnapshot[K] } & {
  changePct: number | null;
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
    const s = await stripeSnapshot(userId, input.periodDays);
    if (!s) throw new GatewayError("INVALID_INPUT", "Connect Stripe so Revenue Pulse can read your figures.");
    const change = changePct(s.grossThisPeriod, s.grossPrevPeriod);
    // People who owe money, for reminder drafts; the model gets names and amounts, not email addresses.
    const owed = [
      ...s.overdueInvoices.map((i) => ({ name: i.customerName, email: i.customerEmail, what: `invoice ${i.number ?? ""} of ${i.amountDue} ${s.currency.toUpperCase()} due ${i.dueDate}`, link: i.hostedUrl })),
      ...s.failedPayments.map((f) => ({ name: f.customerName, email: f.customerEmail, what: `a card payment of ${f.amount} ${s.currency.toUpperCase()} that failed (${f.reason ?? "declined"})`, link: null })),
    ]
      .filter((o) => o.email)
      .slice(0, 10)
      .map((o, ref) => ({ ...o, ref }));
    const figures = [
      `Last ${s.periodDays} days: gross ${s.grossThisPeriod} ${s.currency.toUpperCase()} from ${s.chargeCount} payments (previous period ${s.grossPrevPeriod}${change !== null ? `, ${change > 0 ? "+" : ""}${change}%` : ""}).`,
      `Refunds ${s.refunds}. Failed payments ${s.failedPayments.length}. Overdue invoices ${s.overdueInvoices.length}.`,
      `Active subscriptions ${s.activeSubscriptions}, MRR ${s.mrr}.`,
    ].join("\n");
    const res = await generateJson({
      tier: "flash",
      system:
        "You're a small business's finance assistant. Summarise the figures in plain English without recalculating them, then write a short, friendly payment reminder for each person listed (include the payment link if given). Never threaten or add fees.",
      parts: [textPart(`${groundingPrompt(grounding)}\n\nFigures:\n${figures}\n\nPeople to remind:\n${owed.map((o) => `ref ${o.ref}: ${o.name ?? "customer"} — ${o.what}${o.link ? ` (pay here: ${o.link})` : ""}`).join("\n") || "none"}`)],
      schema: ModelOutput,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    const reminders = res.data.reminders.filter((r) => owed[r.ref]).map((r) => ({ to: owed[r.ref].email, subject: r.subject, body: r.body, label: owed[r.ref].name ?? owed[r.ref].email! }));
    return { ...res, output: { ...s, changePct: change, headline: res.data.headline, observations: res.data.observations, reminders } };
  },

  approval(o) {
    return {
      title: o.reminders.length ? `${o.headline} · ${o.reminders.length} reminders drafted` : o.headline,
      preview: o.observations[0] ?? "",
      severity: o.overdueInvoices.length || o.failedPayments.length ? "check" : "info",
      actions: [
        { id: "approve", label: o.reminders.length ? "Save reminders as Gmail drafts" : "OK", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  deliver: (o, { userId }) => deliverDrafts(userId, o.reminders, "payment reminders"),
});
