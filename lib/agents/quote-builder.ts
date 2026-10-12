import { z } from "zod";
import { gmailCreateDraft, notDelivered, type Delivery } from "@/lib/connectors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, documentParts, groundingPrompt } from "./types";

/**
 * Quote Builder: turns an enquiry into a priced quote. The model picks items
 * and quantities from the owner's price list; code does all the sums.
 */

export const QuoteInput = z.object({
  enquiry: z.string().trim().min(10).max(4000),
  customerName: z.string().trim().max(80).optional(),
  /** Used only as the draft's recipient; never sent to the model. */
  customerEmail: z.email().optional(),
  vatRate: z.number().min(0).max(30).default(20),
  currency: z.string().trim().length(3).toUpperCase().default("GBP"),
  validDays: z.number().int().min(1).max(120).default(30),
});
export type QuoteInput = z.infer<typeof QuoteInput>;

const ModelOutput = z.object({
  lines: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.number().positive(),
        unitPrice: z.number().min(0).describe("Price per unit excluding VAT"),
        fromPriceList: z.boolean().describe("True only if this exact price is in the price list or profile"),
      }),
    )
    .min(1),
  intro: z.string().describe("Two or three sentences thanking them and summarising the job"),
  assumptions: z.array(z.string()).max(6),
  questions: z.array(z.string()).max(4).describe("Anything you'd need to confirm before the price is firm"),
});

export interface QuoteLine {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  fromPriceList: boolean;
}

/** Line amounts, subtotal, VAT and total, rounded to pennies. */
export function quoteTotals(lines: { quantity: number; unitPrice: number }[], vatRate: number) {
  const r = (n: number) => Math.round(n * 100) / 100;
  const amounts = lines.map((l) => r(l.quantity * l.unitPrice));
  const subtotal = r(amounts.reduce((s, a) => s + a, 0));
  const vat = r((subtotal * vatRate) / 100);
  return { amounts, subtotal, vat, total: r(subtotal + vat) };
}

export type QuoteOutput = {
  reference: string;
  customerName: string | null;
  customerEmail: string | null;
  currency: string;
  vatRate: number;
  validUntil: string;
  lines: QuoteLine[];
  subtotal: number;
  vat: number;
  total: number;
  intro: string;
  assumptions: string[];
  questions: string[];
  estimatedLines: number;
};

export function quoteText(q: QuoteOutput, businessName: string): string {
  const m = (n: number) => `${q.currency} ${n.toFixed(2)}`;
  return [
    `Dear ${q.customerName ?? "there"},`,
    "",
    q.intro,
    "",
    `Quote ${q.reference} (valid until ${q.validUntil})`,
    ...q.lines.map((l) => `• ${l.description}: ${l.quantity} × ${m(l.unitPrice)} = ${m(l.amount)}`),
    "",
    `Subtotal: ${m(q.subtotal)}`,
    `VAT (${q.vatRate}%): ${m(q.vat)}`,
    `Total: ${m(q.total)}`,
    ...(q.assumptions.length ? ["", "This quote assumes:", ...q.assumptions.map((a) => `• ${a}`)] : []),
    ...(q.questions.length ? ["", "To confirm the price, could you let me know:", ...q.questions.map((a) => `• ${a}`)] : []),
    "",
    "Reply to this email to go ahead.",
    "",
    businessName,
  ].join("\n");
}

export const quoteBuilder = defineAgent<QuoteInput, QuoteOutput>({
  slug: "quote-builder",
  skillId: "quote.build",
  tier: "flash",
  inputSchema: QuoteInput,
  scrubFields: ["enquiry"],
  editableField: "intro",
  files: null,

  async run({ input, grounding, taskId }) {
    const res = await generateJson({
      tier: "flash",
      system: [
        "You price jobs for a small business. Build a quote for the enquiry using the prices in the business profile and company documents (price lists).",
        "Use list prices exactly. If something needed isn't priced anywhere, add your best estimate and set fromPriceList false. Prices exclude VAT.",
        "Keep lines specific (what, how many). Don't add items the customer didn't ask for unless the job can't be done without them, and say so in assumptions.",
      ].join(" "),
      parts: [...documentParts(grounding), textPart(`${groundingPrompt(grounding)}\n\nCustomer enquiry:\n"""${input.enquiry}"""`)],
      schema: ModelOutput,
      temperature: 0.2,
      thinkingBudget: 512,
    });
    const t = quoteTotals(res.data.lines, input.vatRate);
    const lines = res.data.lines.map((l, i) => ({ ...l, amount: t.amounts[i] }));
    const valid = new Date(Date.now() + input.validDays * 86_400_000).toISOString().slice(0, 10);
    const output: QuoteOutput = {
      reference: `Q-${taskId.slice(-6).toUpperCase()}`,
      customerName: input.customerName ?? null,
      customerEmail: input.customerEmail ?? null,
      currency: input.currency,
      vatRate: input.vatRate,
      validUntil: valid,
      lines,
      subtotal: t.subtotal,
      vat: t.vat,
      total: t.total,
      intro: res.data.intro,
      assumptions: res.data.assumptions,
      questions: res.data.questions,
      estimatedLines: lines.filter((l) => !l.fromPriceList).length,
    };
    return { ...res, output, notes: [`${lines.length} lines, ${output.estimatedLines} estimated (not on your price list)`] };
  },

  approval(o) {
    return {
      title: `Quote ${o.reference} ready: ${o.currency} ${o.total.toFixed(2)} inc. VAT`,
      preview: o.estimatedLines ? `${o.estimatedLines} line${o.estimatedLines > 1 ? "s are" : " is"} estimated, not from your price list. Check before sending.` : o.lines.map((l) => l.description).slice(0, 3).join(", "),
      severity: o.estimatedLines ? "check" : "info",
      actions: [
        { id: "approve", label: "Save as Gmail draft", kind: "approve" },
        { id: "edit", label: "Edit intro first", kind: "edit" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    const { db } = await import("@/lib/firebase-admin");
    const user = (await db().collection("users").doc(userId).get()).data() as { businessName?: string } | undefined;
    const draft = await gmailCreateDraft(userId, { to: o.customerEmail, subject: `Your quote ${o.reference}`, body: quoteText(o, user?.businessName ?? "") });
    if (!draft) return notDelivered("Quote ready. Connect Google to save it as a Gmail draft, or copy it from the result.");
    return { delivered: true, summary: "Quote saved as a Gmail draft. Nothing was sent.", links: [{ label: "Open draft", url: draft.url }] };
  },
});
