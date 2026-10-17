import { z } from "zod";
import { GatewayError } from "@/lib/errors";
import { deliverEmail, emailSummary, notDelivered, type Delivery, type EmailOutcome } from "@/lib/connectors";
import { shopifyOrder, type ShopifyNewOrder } from "@/lib/connectors/shopify";
import { storeProducts } from "@/lib/connectors/store";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, groundingPrompt, type Grounding } from "./types";

/**
 * Inventory Guardian: reads stock (Shopify, WooCommerce or a CSV export),
 * works out days of cover and reorder quantities in code, and asks Gemini only
 * to write the supplier emails. Started by a new Shopify order, it tells the
 * owner what to pack and reorders only what that order ran low.
 */

export const InventoryInput = z.object({
  /** Optional when a Shopify or WooCommerce store is connected. */
  stockCsv: z.string().trim().min(10).max(200_000).optional(),
  leadTimeDays: z.number().int().min(0).max(60).default(3),
  coverDays: z.number().int().min(1).max(90).default(14),
  /** Set by the Shopify "new order" trigger (gid://shopify/Order/…). */
  orderId: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/).optional(),
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

/** A supplier's email from company memory or the profile: an address in the same fact as the supplier's name. */
export function supplierEmail(g: Grounding, supplier: string): string | null {
  const key = supplier.toLowerCase().split(/\s+/)[0];
  if (!key || key === "unknown") return null;
  const texts = [...g.memory.map((m) => m.fact), ...(g.profile?.description.split(/(?<=[.!?])\s+/) ?? [])];
  for (const t of texts) {
    if (!t.toLowerCase().includes(key)) continue;
    const email = t.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
    if (email) return email;
  }
  return null;
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
  source: string;
  /** The new order that started this check, when a Shopify order did. */
  order?: Pick<ShopifyNewOrder, "number" | "customerName" | "total" | "currency"> & { items: string[] };
};

export const inventoryGuardian = defineAgent<InventoryInput, InventoryOutput>({
  slug: "inventory-guardian",
  skillId: "stock.monitor",
  tier: "flash",
  inputSchema: InventoryInput,
  // Stock exports are business data; supplier emails are needed to address orders.
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    let lines: StockLine[];
    let source = "your stock file";
    if (input.stockCsv) lines = parseStockCsv(input.stockCsv);
    else {
      const store = await storeProducts(userId);
      if (!store) throw new GatewayError("INVALID_INPUT", "Connect Shopify or WooCommerce, or paste a stock export.");
      lines = store.products;
      source = store.source === "shopify" ? "Shopify" : "WooCommerce";
    }
    const products = analyseStock(lines, input.leadTimeDays, input.coverDays);
    let reorders = products.filter((p) => p.reorderQty > 0);
    let order: InventoryOutput["order"];
    if (input.orderId) {
      const o = await shopifyOrder(userId, input.orderId);
      if (!o) throw new GatewayError("INVALID_INPUT", "That order isn't in your Shopify store.");
      order = { number: o.number, customerName: o.customerName, total: o.total, currency: o.currency, items: o.lines.map((l) => `${l.quantity} × ${l.name}`) };
      // Only what this order ran low; the morning check covers the rest.
      const inOrder = new Set(o.lines.flatMap((l) => [l.sku, l.name]));
      reorders = reorders.filter((r) => inOrder.has(r.sku) || inOrder.has(r.name));
    }
    const costs = reorders.map((r) => r.reorderCost);
    const totalCost = costs.every((c) => c !== null) ? Math.round(costs.reduce((s, c) => s + (c ?? 0), 0) * 100) / 100 : null;

    if (!reorders.length) {
      return {
        output: { products, reorders, totalCost: 0, emails: [], summary: order ? "Everything in it has enough stock." : "Everything has enough stock for now. Nothing to reorder.", source, ...(order && { order }) },
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
    const emails = res.data.emails.map((e) => ({ ...e, to: bySupplier[e.supplier]?.[0]?.supplierEmail ?? supplierEmail(grounding, e.supplier) }));
    return { ...res, output: { products, reorders, totalCost, emails, summary: res.data.summary, source, ...(order && { order }) }, notes: [`Read ${products.length} products from ${source}`] };
  },

  approval(o) {
    if (o.order) {
      const pack = `${o.order.number}${o.order.customerName ? ` from ${o.order.customerName}` : ""}: ${o.order.items.join(", ")}`;
      if (!o.reorders.length) return { title: `New order ${o.order.number} to pack`, preview: `${pack}. ${o.summary}`, severity: "info", actions: [{ id: "approve", label: "OK", kind: "approve" }] };
      const low = o.reorders.map((r) => `${r.name} is down to ${r.onHand}`).join(", ");
      return {
        title: `New order ${o.order.number} to pack. ${low}`,
        preview: `${pack}.
${o.summary} Reorder drafted to ${[...new Set(o.reorders.map((r) => r.supplier))].join(", ")}.`,
        severity: "check",
        actions: [
          { id: "approve", label: "Approve reorder email", kind: "approve" },
          { id: "skip", label: "Not now", kind: "skip" },
        ],
      };
    }
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
    const results: EmailOutcome[] = [];
    for (const e of o.emails) {
      const mail = await deliverEmail(userId, { to: e.to, subject: e.subject, body: e.body });
      if (!mail) return notDelivered(`${o.emails.length} order email(s) ready. Connect Google or Microsoft 365 to save them as email drafts.`);
      results.push(mail);
      links.push({ label: `${mail.sent ? "Sent" : "Draft"} · ${e.supplier}`, url: mail.url });
    }
    return { delivered: true, summary: emailSummary(results, results.length > 1 ? `${results.length} supplier orders` : "supplier order"), links };
  },
});
