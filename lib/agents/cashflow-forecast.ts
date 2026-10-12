import { z } from "zod";
import { openItems } from "@/lib/connectors/accounting";
import { stripeSnapshot } from "@/lib/connectors/stripe-data";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, groundingPrompt } from "./types";

/**
 * Cash-flow Forecast: 13 weeks of money in and out, computed in code from
 * unpaid invoices and bills (Xero/QuickBooks), Stripe takings and the owner's
 * regular costs. The model only explains the result.
 */

export const CashflowInput = z.object({
  openingBalance: z.number().min(-10_000_000).max(100_000_000),
  currency: z.string().trim().length(3).toUpperCase().default("GBP"),
  /** One per line: name, amount, weekly|monthly[, day of month]. */
  regularCosts: z.string().trim().max(3000).default(""),
  /** Other money in each week (e.g. card takings not through Stripe). */
  weeklySales: z.number().min(0).max(10_000_000).optional(),
});
export type CashflowInput = z.infer<typeof CashflowInput>;

export interface RegularCost {
  name: string;
  amount: number;
  every: "weekly" | "monthly";
  day: number;
}

/** Parses "Rent, 1200, monthly, 1" lines. Bad lines are reported, not guessed. */
export function parseCosts(text: string): { costs: RegularCost[]; skipped: string[] } {
  const costs: RegularCost[] = [];
  const skipped: string[] = [];
  // Amounts may use thousands commas ("£1,200"), so fields are matched rather than split on commas.
  const LINE = /^(.+?)\s*,\s*[£$€]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:,\s*([a-z]+))?\s*(?:,\s*(\d{1,2}))?\s*$/i;
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(LINE);
    const amount = m ? Number(m[2].replace(/,/g, "")) : NaN;
    const unit = (m?.[3] ?? "monthly").toLowerCase();
    const every = unit.startsWith("w") ? "weekly" : unit.startsWith("m") ? "monthly" : null;
    if (!m || !(amount > 0) || !every) skipped.push(line);
    else costs.push({ name: m[1], amount, every, day: Math.min(28, Math.max(1, Number(m[4]) || 1)) });
  }
  return { costs, skipped };
}

export interface ForecastWeek {
  weekStart: string;
  moneyIn: number;
  moneyOut: number;
  closing: number;
  notes: string[];
}

interface Dated {
  label: string;
  amount: number;
  date: string | null;
}

/**
 * Buckets dated receipts and payments into 13 weeks starting `start` (a Monday).
 * Anything overdue is assumed to land in week 2 (receipts) or week 1 (payments).
 */
export function forecastWeeks(start: Date, opening: number, receipts: Dated[], payments: Dated[], costs: RegularCost[], weeklySales: number): ForecastWeek[] {
  const r = (n: number) => Math.round(n * 100) / 100;
  const weeks: ForecastWeek[] = Array.from({ length: 13 }, (_, i) => ({ weekStart: new Date(start.getTime() + i * 7 * 86_400_000).toISOString().slice(0, 10), moneyIn: weeklySales, moneyOut: 0, closing: 0, notes: [] }));
  const index = (date: string | null, overdueWeek: number) => {
    if (!date) return overdueWeek;
    const w = Math.floor((Date.parse(date) - start.getTime()) / (7 * 86_400_000));
    return w < 0 ? overdueWeek : w;
  };
  for (const x of receipts) {
    const w = index(x.date, 1);
    if (w < 13) weeks[w].moneyIn += x.amount;
  }
  for (const x of payments) {
    const w = index(x.date, 0);
    if (w < 13) weeks[w].moneyOut += x.amount;
  }
  for (const c of costs) {
    for (let w = 0; w < 13; w++) {
      if (c.every === "weekly") weeks[w].moneyOut += c.amount;
      else {
        const from = Date.parse(weeks[w].weekStart);
        for (let d = 0; d < 7; d++) {
          const day = new Date(from + d * 86_400_000);
          if (day.getUTCDate() === c.day) {
            weeks[w].moneyOut += c.amount;
            weeks[w].notes.push(c.name);
          }
        }
      }
    }
  }
  let balance = opening;
  for (const w of weeks) {
    w.moneyIn = r(w.moneyIn);
    w.moneyOut = r(w.moneyOut);
    balance = r(balance + w.moneyIn - w.moneyOut);
    w.closing = balance;
  }
  return weeks;
}

const ModelOutput = z.object({
  headline: z.string().describe("One sentence on the cash position over the next 13 weeks"),
  explanation: z.string().describe("Two or three sentences on what drives the low point, using only the figures given"),
  suggestions: z.array(z.string()).max(4).describe("Practical steps a small business could take, tied to the figures"),
});

export type CashflowOutput = {
  currency: string;
  openingBalance: number;
  weeks: ForecastWeek[];
  lowest: { weekStart: string; closing: number };
  firstNegativeWeek: string | null;
  sources: string[];
  skippedCostLines: string[];
} & z.infer<typeof ModelOutput>;

function thisMonday(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

export const cashflowForecast = defineAgent<CashflowInput, CashflowOutput>({
  slug: "cashflow-forecast",
  skillId: "cash.forecast",
  tier: "flash",
  inputSchema: CashflowInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    const [books, stripe] = await Promise.all([openItems(userId), stripeSnapshot(userId, 28).catch(() => null)]);
    const { costs, skipped } = parseCosts(input.regularCosts);
    if (!books && !stripe && !costs.length && input.weeklySales === undefined) {
      throw new GatewayError("INVALID_INPUT", "Connect Xero, QuickBooks or Stripe, or enter your regular costs and weekly sales, so there's something to forecast.");
    }
    const sources: string[] = [];
    const receipts: Dated[] = [];
    const payments: Dated[] = [];
    if (books) {
      const sys = books.system === "xero" ? "Xero" : "QuickBooks";
      receipts.push(...books.receivable.map((i) => ({ label: i.contact, amount: i.amountDue, date: i.dueDate })));
      payments.push(...books.payable.map((i) => ({ label: i.contact, amount: i.amountDue, date: i.dueDate })));
      sources.push(`${sys}: ${books.receivable.length} unpaid invoices, ${books.payable.length} unpaid bills`);
    }
    let weekly = input.weeklySales ?? 0;
    if (stripe && input.weeklySales === undefined) {
      weekly = Math.round(((stripe.grossThisPeriod - stripe.refunds) / 4) * 100) / 100;
      sources.push(`Stripe: average ${weekly.toFixed(2)} a week over the last 4 weeks`);
    }
    if (costs.length) sources.push(`${costs.length} regular costs you entered`);
    const weeks = forecastWeeks(thisMonday(), input.openingBalance, receipts, payments, costs, weekly);
    const lowest = weeks.reduce((lo, w) => (w.closing < lo.closing ? w : lo), weeks[0]);
    const negative = weeks.find((w) => w.closing < 0)?.weekStart ?? null;
    const table = weeks.map((w) => `${w.weekStart}: in ${w.moneyIn}, out ${w.moneyOut}, closing ${w.closing}${w.notes.length ? ` (${w.notes.join(", ")})` : ""}`).join("\n");
    const res = await generateJson({
      tier: "flash",
      system: "You explain a small business's 13-week cash-flow forecast in plain English. The numbers are already calculated; never recalculate or invent figures. Be calm and practical.",
      parts: [textPart(`${groundingPrompt(grounding)}\n\nCurrency ${input.currency}. Opening balance ${input.openingBalance}.\nSources: ${sources.join("; ")}\nLowest week: ${lowest.weekStart} at ${lowest.closing}. ${negative ? `First negative week: ${negative}.` : "Never negative."}\n\n${table}`)],
      schema: ModelOutput,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    return {
      ...res,
      output: { currency: input.currency, openingBalance: input.openingBalance, weeks, lowest: { weekStart: lowest.weekStart, closing: lowest.closing }, firstNegativeWeek: negative, sources, skippedCostLines: skipped, ...res.data },
    };
  },

  approval(o) {
    return {
      title: o.firstNegativeWeek ? `Cash runs short in the week of ${o.firstNegativeWeek}` : `Cash stays positive for 13 weeks (lowest ${o.currency} ${o.lowest.closing.toFixed(2)})`,
      preview: o.headline,
      severity: o.firstNegativeWeek ? "check" : "info",
      actions: [{ id: "approve", label: "Got it", kind: "approve" }],
    };
  },

  async deliver() {
    return { delivered: true, summary: "Forecast ready in AgentGig" };
  },
});
