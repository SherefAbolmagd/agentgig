import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "@/lib/firebase-admin";
import { GatewayError } from "@/lib/errors";
import { filePart, generateJson, textPart } from "@/lib/vertex";
import { COLLECTIONS } from "@/types/firestore";
import { gmailCreateDraft, sheetsAppendRow, simulated, type Delivery } from "@/lib/connectors";
import { defineAgent, groundingPrompt } from "./types";

export const ReceiptHeroInput = z.object({
  note: z.string().trim().max(300).optional(),
});
export type ReceiptHeroInput = z.infer<typeof ReceiptHeroInput>;

/** What Gemini reads off the document. It does no arithmetic; we do. */
const Extracted = z.object({
  isInvoiceOrReceipt: z.boolean(),
  vendor: z.object({
    name: z.string(),
    address: z.string().nullable(),
    taxId: z.string().nullable().describe("VAT / GST / tax registration number exactly as printed"),
    email: z.string().nullable().describe("Supplier's email address if printed"),
  }),
  invoiceNumber: z.string().nullable(),
  issueDate: z.string().nullable().describe("YYYY-MM-DD"),
  currency: z.string().describe("ISO 4217 code, e.g. GBP, USD, EUR"),
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number(),
      amount: z.number().describe("Line total exactly as printed"),
    }),
  ),
  subtotal: z.number().nullable().describe("As printed, before tax"),
  taxRate: z.number().nullable().describe("As a fraction, e.g. 0.2 for 20%"),
  taxAmount: z.number().nullable().describe("As printed"),
  totalPrinted: z.number().describe("Total due exactly as printed"),
  readingConfidence: z.number().min(0).max(1).describe("How legible the document was"),
});
export type Extracted = z.infer<typeof Extracted>;

export interface AuditFlag {
  code:
    | "TOTAL_MISMATCH"
    | "SUBTOTAL_MISMATCH"
    | "LINE_MATH"
    | "TAX_MISMATCH"
    | "DUPLICATE_INVOICE"
    | "MISSING_INVOICE_NUMBER"
    | "MISSING_TAX_ID"
    | "LOW_CONFIDENCE";
  severity: "high" | "medium" | "low";
  message: string;
  difference?: number;
}

export type ReceiptHeroOutput = Extracted & {
  lineItemsTotal: number;
  calculatedTotal: number;
  flags: AuditFlag[];
  verdict: "ok" | "check";
  /** vendor + invoice number, normalised; used to spot duplicates. */
  invoiceKey: string | null;
};

const SYSTEM = `You are ReceiptHero, a careful bookkeeper. Read the attached receipt or invoice and copy its figures exactly as printed.
- Do not correct, recalculate or round any number. If the printed total is wrong, still report the printed total.
- Quantities and prices are plain numbers without currency symbols.
- Use null for anything not printed on the document.
- If the document is not a receipt or invoice, set isInvoiceOrReceipt to false.`;

const TOLERANCE = 0.01;

export const receiptHero = defineAgent<ReceiptHeroInput, ReceiptHeroOutput>({
  slug: "receipthero",
  skillId: "invoice.extract",
  tier: "pro",
  inputSchema: ReceiptHeroInput,
  scrubFields: ["note"],
  files: { required: true, mimeTypes: ["application/pdf", "image/jpeg", "image/png", "image/webp"], maxBytes: 10 * 1024 * 1024 },

  async run({ input, files, grounding, userId, taskId }) {
    const file = files[0];
    const res = await generateJson({
      tier: "pro",
      system: SYSTEM,
      parts: [
        filePart(file.data, file.mimeType),
        textPart(
          [`This document was uploaded by ${grounding.businessName}.`, groundingPrompt(grounding), input.note ? `Owner's note: ${input.note}` : ""]
            .filter(Boolean)
            .join("\n"),
        ),
      ],
      schema: Extracted,
      temperature: 0,
      thinkingBudget: 512, // reading figures needs little reasoning; the maths is ours
    });
    const ex = res.data;
    if (!ex.isInvoiceOrReceipt) {
      throw new GatewayError("AGENT_FAILED", `“${file.name}” doesn't look like a receipt or invoice, so nothing was charged.`);
    }

    const invoiceKey = ex.invoiceNumber ? `${normalise(ex.vendor.name)}#${normalise(ex.invoiceNumber)}` : null;
    const flags = audit(ex);
    if (invoiceKey && (await seenBefore(userId, invoiceKey, taskId))) {
      flags.unshift({
        code: "DUPLICATE_INVOICE",
        severity: "high",
        message: `You've already processed invoice ${ex.invoiceNumber} from ${ex.vendor.name}. Check it isn't paid twice.`,
      });
    }

    const lineItemsTotal = round(ex.lineItems.reduce((s, l) => s + l.amount, 0));
    const calculatedTotal = round((ex.subtotal ?? lineItemsTotal) + (ex.taxAmount ?? 0));
    return {
      ...res,
      output: {
        ...ex,
        lineItemsTotal,
        calculatedTotal,
        flags,
        verdict: flags.some((f) => f.severity !== "low") ? "check" : "ok",
        invoiceKey,
      },
    };
  },

  approval(o) {
    const ref = o.invoiceNumber ? `Invoice ${o.invoiceNumber}` : `${o.vendor.name} receipt`;
    const top = o.flags.find((f) => f.severity === "high") ?? o.flags.find((f) => f.severity === "medium");
    if (!top) {
      return {
        title: `${ref} checked: no problems`,
        preview: `${o.vendor.name} · ${money(o.totalPrinted, o.currency)} · ${o.lineItems.length} items`,
        severity: "info",
        actions: [
          { id: "approve", label: "File it", kind: "approve" },
          { id: "skip", label: "Skip", kind: "skip" },
        ],
      };
    }
    return {
      title: top.code === "TOTAL_MISMATCH" && top.difference ? `${ref} is ${top.difference > 0 ? "overcharged" : "undercharged"} by ${money(Math.abs(top.difference), o.currency)}` : `${ref} needs a check`,
      preview: top.message,
      severity: "check",
      actions: [
        { id: "approve", label: "Email supplier a correction", kind: "approve" },
        { id: "skip", label: "Pay anyway", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    const sheet = await sheetsAppendRow(userId, [
      o.issueDate ?? "",
      o.vendor.name,
      o.invoiceNumber ?? "",
      o.subtotal ?? o.lineItemsTotal,
      o.taxAmount ?? 0,
      o.totalPrinted,
      o.currency,
      o.verdict === "ok" ? "OK" : (o.flags.find((f) => f.severity !== "low")?.message ?? "Check"),
      new Date().toISOString().slice(0, 10),
    ]);
    if (!sheet) return simulated("Audited. Connect Google to log invoices to your spend sheet and draft supplier emails.");
    const links = [{ label: "Spend log", url: sheet.url }];
    const problem = o.flags.find((f) => f.severity === "high");
    if (problem) {
      const draft = await gmailCreateDraft(userId, {
        to: o.vendor.email,
        subject: `Invoice ${o.invoiceNumber ?? ""} needs correcting`.replace("  ", " "),
        body: `Hello ${o.vendor.name},

We've received invoice ${o.invoiceNumber ?? "(no number)"}. ${problem.message}

Could you send a corrected invoice? We'll pay as soon as it arrives.

Thank you`,
      });
      if (draft) links.push({ label: "Correction email draft", url: draft.url });
    }
    return { simulated: false, summary: problem ? "Logged to your spend sheet and drafted a correction email" : "Logged to your spend sheet", links };
  },
});

/** Exported for tests. */
export function audit(ex: Extracted): AuditFlag[] {
  const flags: AuditFlag[] = [];
  const cur = ex.currency;
  const lineSum = round(ex.lineItems.reduce((s, l) => s + l.amount, 0));

  ex.lineItems.forEach((l) => {
    const expected = round(l.quantity * l.unitPrice);
    if (Math.abs(expected - l.amount) > TOLERANCE) {
      flags.push({
        code: "LINE_MATH",
        severity: "medium",
        message: `“${l.description}”: ${l.quantity} × ${money(l.unitPrice, cur)} is ${money(expected, cur)}, but the line says ${money(l.amount, cur)}.`,
        difference: round(l.amount - expected),
      });
    }
  });

  if (ex.subtotal !== null && Math.abs(ex.subtotal - lineSum) > TOLERANCE) {
    flags.push({
      code: "SUBTOTAL_MISMATCH",
      severity: "high",
      message: `The items add up to ${money(lineSum, cur)}, but the subtotal says ${money(ex.subtotal, cur)}.`,
      difference: round(ex.subtotal - lineSum),
    });
  }

  const base = ex.subtotal ?? lineSum;
  if (ex.taxRate !== null && ex.taxAmount !== null) {
    const expectedTax = round(base * ex.taxRate);
    if (Math.abs(expectedTax - ex.taxAmount) > 0.02) {
      flags.push({
        code: "TAX_MISMATCH",
        severity: "medium",
        message: `${Math.round(ex.taxRate * 100)}% tax on ${money(base, cur)} is ${money(expectedTax, cur)}, but the invoice charges ${money(ex.taxAmount, cur)}.`,
        difference: round(ex.taxAmount - expectedTax),
      });
    }
  }

  const expectedTotal = round(base + (ex.taxAmount ?? 0));
  if (Math.abs(expectedTotal - ex.totalPrinted) > TOLERANCE) {
    const diff = round(ex.totalPrinted - expectedTotal);
    flags.unshift({
      code: "TOTAL_MISMATCH",
      severity: "high",
      message: `The invoice says ${money(ex.totalPrinted, cur)}, but the items${ex.taxAmount ? " plus tax" : ""} come to ${money(expectedTotal, cur)}. Ask for a corrected invoice before paying.`,
      difference: diff,
    });
  }

  if (!ex.invoiceNumber) flags.push({ code: "MISSING_INVOICE_NUMBER", severity: "low", message: "No invoice number is printed." });
  if (!ex.vendor.taxId && (ex.taxAmount ?? 0) > 0) {
    flags.push({ code: "MISSING_TAX_ID", severity: "low", message: "Tax is charged but no VAT/tax number is printed." });
  }
  if (ex.readingConfidence < 0.6) {
    flags.push({ code: "LOW_CONFIDENCE", severity: "medium", message: "The document was hard to read. Double-check the figures." });
  }
  return flags;
}

/**
 * Claims an invoice number for this user with a create-only write, so two
 * copies arriving at the same moment (an inbox drop) can't both pass as new.
 * Returns true if another task claimed it first.
 */
async function seenBefore(userId: string, invoiceKey: string, taskId: string): Promise<boolean> {
  const id = createHash("sha256").update(`${userId}\n${invoiceKey}`).digest("hex").slice(0, 40);
  const ref = db().collection(COLLECTIONS.invoiceKeys).doc(id);
  try {
    await ref.create({ userId, invoiceKey, taskId, createdAt: FieldValue.serverTimestamp() });
    return false;
  } catch (err) {
    if ((err as { code?: number }).code !== 6 /* ALREADY_EXISTS */) throw err;
    return (await ref.get()).get("taskId") !== taskId;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}
