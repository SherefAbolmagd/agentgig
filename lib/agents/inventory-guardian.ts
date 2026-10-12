import { z } from "zod";
import { GatewayError } from "@/lib/errors";
import { gmailCreateDraft, notDelivered, type Delivery } from "@/lib/connectors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, groundingPrompt } from "./types";

/**
 * Inventory Guardian: reads a stock export (CSV), works out days of cover and
 * reorder quantities in code, and asks Gemini only to write the supplier emails.
 */

export const InventoryInput = z.object({
  stockCsv: z.string().trim().min(10).max(200_000),
  leadTimeDays: z.number().int().min(0).max(60).default(3),
  coverDays: z.number().int().min(1).max(90).default(14),
});
export type InventoryInput = z.infer<typeof InventoryInput>;

export interface StockLine {
  sku: string;
  name: string;
  onHand: number;
  soldLast7: number;
  unitCost: number | null;
  supplier: string;
  supplierEmail: string | null;
}

export interface StockAnalysis extends StockLine {
  perDay: number;
  daysOfCover: number | null;
  reorderQty: number;
  reorderCost: number | null;
}

const HEADERS: Record<keyof StockLine, string[]> = {
  sku: ["sku", "code", "product_code", "id", "item_code"],
  name: ["name", "product", "item", "description", "product_name"],
  onHand: ["on_hand", "stock", "quantity", "qty", "in_stock", "available"],
  soldLast7: ["sold_last_7_days", "sold_7d", "weekly_sales", "sales_7d", "sold_this_week", "units_sold_7d"],
  unitCost: ["unit_cost", "cost", "cost_price", "unit_price", "price"],
  supplier: ["supplier", "vendor", "supplier_name"],
  supplierEmail: ["supplier_email", "vendor_email", "email"],
};

/** Parses a stock CSV with flexible headers. Throws INVALID_INPUT naming what's missing. */
export function parseStockCsv(csv: string): StockLine[] {
  const rows = csv.split(/\r?\n/).filter((l) => l.trim()).map(splitCsvLine);
  if (rows.length < 2) throw new GatewayError("INVALID_INPUT", "The stock file needs a header row and at least one product.");
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const col = (k: keyof StockLine) => header.findIndex((h) => HEADERS[k].includes(h));
  const idx = Object.fromEntries((Object.keys(HEADERS) as (keyof StockLine)[]).map((k) => [k, col(k)])) as Record<keyof StockLine, number>;
  const missing = (["name", "onHand", "soldLast7"] as const).filter((k) => idx[k] < 0);
  if (missing.length) {
    throw new GatewayError("INVALID_INPUT", `The stock file needs columns for ${missing.map((m) => HEADERS[m][0]).join(", ")}.`);
  }
  const num = (v: string | undefined) => {
    const n = Number(String(v ?? "").replace(/[£$€,\s]/g, ""));
    return Number.isFinite(n) ? n : NaN;
  };
  return rows.slice(1).map((r, i) => {
    const onHand = num(r[idx.onHand]);
    const sold = num(r[idx.soldLast7]);
    if (Number.isNaN(onHand) || Number.isNaN(sold)) throw new GatewayError("INVALID_INPUT", `Row ${i + 2} has a stock or sales value that isn't a number.`);
    const cost = idx.unitCost >= 0 ? num(r[idx.unitCost]) : NaN;
    return {
      sku: idx.sku >= 0 ? r[idx.sku].trim() : `row-${i + 2}`,
      name: r[idx.name].trim(),
      onHand,
      soldLast7: sold,
      unitCost: Number.isNaN(cost) ? null : cost,
      supplier: idx.supplier >= 0 && r[idx.supplier]?.trim() ? r[idx.supplier].trim() : "Unknown supplier",
      supplierEmail: idx.supplierEmail >= 0 && r[idx.supplierEmail]?.includes("@") ? r[idx.supplierEmail].trim() : null,
    };
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const SAFETY_DAYS = 2;

/** Days of cover and reorder quantity per product. */
export function analyseStock(lines: StockLine[], leadTimeDays: number, coverDays: number): StockAnalysis[] {
  return lines.map((l) => {
    const perDay = l.soldLast7 / 7;
    const daysOfCover = perDay > 0 ? Math.round((l.onHand / perDay) * 10) / 10 : null;
    const needsOrder = daysOfCover !== null && daysOfCover < leadTimeDays + SAFETY_DAYS;
    const reorderQty = needsOrder ? Math.max(1, Math.ceil(perDay * (coverDays + leadTimeDays) - l.onHand)) : 0;
    return { ...l, perDay: Math.round(perDay * 100) / 100, daysOfCover, reorderQty, reorderCost: reorderQty && l.unitCost !== null ? Math.round(reorderQty * l.unitCost * 100) / 100 : null };
  });
}

const EmailSchema = z.object({
  emails: z.array(z.object({ supplier: z.string(), subject: z.string(), body: z.string() })),
  summary: z.string().describe("One or two sentences for the owner: what's running low and when"),
});

export type InventoryOutput = {
  products: StockAnalysis[];
  reorders: StockAnalysis[];
  totalCost: number | null;
  emails: { supplier: string; to: string | null; subject: string; body: string }[];
  summary: string;
};

export const inventoryGuardian = defineAgent<InventoryInput, InventoryOutput>({
  slug: "inventory-guardian",
  skillId: "stock.monitor",
  tier: "flash",
  inputSchema: InventoryInput,
  // Stock exports are business data; supplier emails are needed to address orders.
  scrubFields: [],
  files: null,

  async run({ input, grounding }) {
    const products = analyseStock(parseStockCsv(input.stockCsv), input.leadTimeDays, input.coverDays);
    const reorders = products.filter((p) => p.reorderQty > 0);
    const costs = reorders.map((r) => r.reorderCost);
    const totalCost = costs.every((c) => c !== null) ? Math.round(costs.reduce((s, c) => s + (c ?? 0), 0) * 100) / 100 : null;

    if (!reorders.length) {
      return {
        output: { products, reorders, totalCost: 0, emails: [], summary: "Everything has enough stock for now. Nothing to reorder." },
        model: "rules",
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    const bySupplier = Object.groupBy(reorders, (r) => r.supplier);
    const brief = Object.entries(bySupplier)
      .map(([supplier, items]) => `Supplier: ${supplier}\n${items!.map((i) => `- ${i.name} (${i.sku}): order ${i.reorderQty}`).join("\n")}`)
      .join("\n\n");
    const res = await generateJson({
      tier: "flash",
      system:
        "You write short, polite purchase-order emails from a small business to its suppliers, one per supplier, listing exactly the quantities given. Sign off with the business name. Then summarise for the owner what's running low.",
      parts: [textPart(`${groundingPrompt(grounding)}\n\nLead time ${input.leadTimeDays} days.\n\n${brief}`)],
      schema: EmailSchema,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    const emails = res.data.emails.map((e) => ({ ...e, to: bySupplier[e.supplier]?.[0]?.supplierEmail ?? null }));
    return { ...res, output: { products, reorders, totalCost, emails, summary: res.data.summary } };
  },

  approval(o) {
    if (!o.reorders.length) return { title: "Stock check: nothing to reorder", preview: o.summary, severity: "info", actions: [{ id: "approve", label: "OK", kind: "approve" }] };
    const suppliers = new Set(o.reorders.map((r) => r.supplier)).size;
    return {
      title: `Reorder ${o.reorders.length} product${o.reorders.length > 1 ? "s" : ""}${o.totalCost ? ` (£${o.totalCost.toFixed(2)})` : ""}`,
      preview: `${o.summary} ${suppliers} supplier email${suppliers > 1 ? "s" : ""} drafted.`,
      severity: "check",
      actions: [
        { id: "approve", label: "Create order emails", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    if (!o.emails.length) return { delivered: true, summary: "Nothing to order" };
    const links: { label: string; url: string }[] = [];
    for (const e of o.emails) {
      const draft = await gmailCreateDraft(userId, { to: e.to, subject: e.subject, body: e.body });
      if (!draft) return notDelivered(`${o.emails.length} order email(s) ready. Connect Google to save them as Gmail drafts.`);
      links.push({ label: `Gmail draft · ${e.supplier}`, url: draft.url });
    }
    return { delivered: true, summary: `${links.length} order email draft(s) saved in Gmail`, links };
  },
});
