import { z } from "zod";
import { notDelivered, type Delivery } from "@/lib/connectors";
import { connectedAccounting, createBill } from "@/lib/connectors/accounting";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { COLLECTIONS, type TaskDoc } from "@/types/firestore";
import { defineAgent } from "./types";

/**
 * Bookkeeper: turns invoices ReceiptHero has audited into bills in Xero or
 * QuickBooks. Invoices with problems are held back, and each invoice is
 * booked once (tracked in booked_invoices).
 */

export const BookkeeperInput = z.object({ period: z.enum(["this-month", "last-month"]).default("this-month") });
export type BookkeeperInput = z.infer<typeof BookkeeperInput>;

interface Invoice {
  taskId: string;
  key: string;
  supplier: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  currency: string;
  total: number;
  lines: { description: string; quantity: number; unitPrice: number }[];
  taxAmount: number | null;
  problem: string | null;
}

export type BookkeeperOutput = { system: string | null; toBook: Invoice[]; heldBack: Invoice[]; alreadyBooked: number };

function range(period: string) {
  const now = new Date();
  const offset = period === "last-month" ? -1 : 0;
  return [Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1), Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1)];
}

export const bookkeeper = defineAgent<BookkeeperInput, BookkeeperOutput>({
  slug: "bookkeeper",
  skillId: "bills.book",
  tier: "flash",
  inputSchema: BookkeeperInput,
  scrubFields: [],
  files: null,

  async run({ input, userId }) {
    const system = await connectedAccounting(userId);
    if (!system) throw new GatewayError("INVALID_INPUT", "Connect Xero or QuickBooks so Bookkeeper can create bills.");
    const [start, end] = range(input.period);
    const tasks = (await db().collection(COLLECTIONS.tasks).where("userId", "==", userId).where("agentId", "==", "receipthero").get()).docs
      .map((d) => ({ id: d.id, ...(d.data() as TaskDoc) }))
      .filter((t) => t.settlement === "charged" && t.output);
    const seen = new Set<string>();
    const invoices: Invoice[] = [];
    for (const t of tasks) {
      const o = t.output as Record<string, unknown> & { vendor: { name: string }; flags: { severity: string; message: string }[]; lineItems: { description: string; quantity: number; unitPrice: number }[] };
      const when = typeof o.issueDate === "string" ? Date.parse(o.issueDate) : t.createdAt.toMillis();
      if (when < start || when >= end) continue;
      const key = (o.invoiceKey as string | null) ?? `task-${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      invoices.push({
        taskId: t.id,
        key,
        supplier: o.vendor.name,
        invoiceNumber: (o.invoiceNumber as string | null) ?? null,
        issueDate: (o.issueDate as string | null) ?? null,
        currency: String(o.currency ?? "GBP"),
        total: Number(o.totalPrinted ?? 0),
        lines: o.lineItems.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
        taxAmount: (o.taxAmount as number | null) ?? null,
        problem: o.flags.find((f) => f.severity !== "low")?.message ?? null,
      });
    }
    const bookedSnaps = invoices.length ? await db().getAll(...invoices.map((i) => db().collection("booked_invoices").doc(bookId(userId, i.key)))) : [];
    const booked = new Set(bookedSnaps.filter((s) => s.exists).map((s) => s.id));
    const fresh = invoices.filter((i) => !booked.has(bookId(userId, i.key)));
    return {
      output: { system, toBook: fresh.filter((i) => !i.problem), heldBack: fresh.filter((i) => i.problem), alreadyBooked: invoices.length - fresh.length },
      model: "rules",
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      notes: [`${invoices.length} audited invoices in the period; ${invoices.length - fresh.length} already booked`],
    };
  },

  approval(o) {
    return {
      title: o.toBook.length ? `${o.toBook.length} bill${o.toBook.length > 1 ? "s" : ""} ready for ${o.system === "xero" ? "Xero" : "QuickBooks"}` : "Nothing new to book",
      preview: o.heldBack.length ? `${o.heldBack.length} held back: ${o.heldBack[0].problem}` : o.toBook.map((b) => b.supplier).join(", "),
      severity: o.heldBack.length ? "check" : "info",
      actions: [
        { id: "approve", label: o.system === "xero" ? "Create draft bills in Xero" : "Create bills in QuickBooks", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    if (!o.toBook.length) return { delivered: true, summary: "Nothing new to book" };
    const links: { label: string; url: string }[] = [];
    for (const inv of o.toBook) {
      const ref = db().collection("booked_invoices").doc(bookId(userId, inv.key));
      // Claim first so a retried delivery can't book the same invoice twice.
      try {
        await ref.create({ userId, key: inv.key, taskId: inv.taskId, at: new Date() });
      } catch {
        continue;
      }
      try {
        const bill = await createBill(userId, { ...inv, note: `Added by AgentGig from ReceiptHero task ${inv.taskId}` });
        if (!bill) {
          await ref.delete();
          return notDelivered("Bills ready. Connect Xero or QuickBooks to create them.");
        }
        await ref.update({ system: bill.system, billId: bill.id });
        links.push({ label: `${inv.supplier} ${inv.invoiceNumber ?? ""}`.trim(), url: bill.url });
      } catch (err) {
        await ref.delete();
        throw err;
      }
    }
    return { delivered: true, summary: `${links.length} bill${links.length === 1 ? "" : "s"} created${o.system === "xero" ? " as drafts in Xero" : " in QuickBooks"}`, links };
  },
});

function bookId(userId: string, key: string) {
  return `${userId}_${key}`.replace(/[^A-Za-z0-9_#-]/g, "-").slice(0, 400);
}
