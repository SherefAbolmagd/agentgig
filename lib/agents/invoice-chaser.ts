import { z } from "zod";
import { openItems } from "@/lib/connectors/accounting";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { generateJson, textPart } from "@/lib/vertex";
import { deliverDrafts, type DraftEmail } from "./drafts";
import { defineAgent, groundingPrompt } from "./types";

/**
 * Invoice Chaser: polite reminders for overdue customer invoices in Xero or
 * QuickBooks, getting firmer with each chase. Each invoice is chased at most
 * once a week (tracked in invoice_chases).
 */

export const ChaserInput = z.object({
  minDaysOverdue: z.number().int().min(0).max(365).default(1),
  maxInvoices: z.number().int().min(1).max(25).default(15),
});
export type ChaserInput = z.infer<typeof ChaserInput>;

export type ChaseStage = "friendly" | "firm" | "final";

/** Tone by how late the invoice is and how often it's been chased already. */
export function chaseStage(daysOverdue: number, timesChased: number): ChaseStage {
  if (daysOverdue > 30 || timesChased >= 2) return "final";
  if (daysOverdue > 14 || timesChased >= 1) return "firm";
  return "friendly";
}

const CHASE_GAP_DAYS = 7;

const ModelOutput = z.object({ emails: z.array(z.object({ ref: z.number().int(), subject: z.string(), body: z.string() })) });

interface Overdue {
  key: string;
  number: string | null;
  customer: string;
  amountDue: number;
  currency: string;
  dueDate: string;
  daysOverdue: number;
  stage: ChaseStage;
  url: string;
}

export type ChaserOutput = {
  system: string;
  totalOverdue: number;
  currency: string | null;
  chasing: Overdue[];
  noEmail: Overdue[];
  recentlyChased: number;
  emails: (DraftEmail & { key: string })[];
};

const chaseRef = (userId: string, key: string) => db().collection("invoice_chases").doc(`${userId}_${key}`.replace(/[^A-Za-z0-9_-]/g, "-"));

export const invoiceChaser = defineAgent<ChaserInput, ChaserOutput>({
  slug: "invoice-chaser",
  skillId: "invoices.chase",
  tier: "flash",
  inputSchema: ChaserInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    const books = await openItems(userId);
    if (!books) throw new GatewayError("INVALID_INPUT", "Connect Xero or QuickBooks so Invoice Chaser can see who owes you.");
    const today = Date.now();
    const overdue = books.receivable
      .filter((i) => i.dueDate)
      .map((i) => ({ ...i, daysOverdue: Math.floor((today - Date.parse(i.dueDate!)) / 86_400_000) }))
      .filter((i) => i.daysOverdue >= Math.max(1, input.minDaysOverdue))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
    const snaps = overdue.length ? await db().getAll(...overdue.map((i) => chaseRef(userId, `${books.system}-${i.id}`))) : [];
    const history = new Map(snaps.map((s) => [s.id, s.data() as { count: number; lastAt: FirebaseFirestore.Timestamp } | undefined]));
    let recentlyChased = 0;
    const rows: (Overdue & { email: string | null })[] = [];
    for (const i of overdue) {
      const key = `${books.system}-${i.id}`;
      const h = history.get(chaseRef(userId, key).id);
      if (h && today - h.lastAt.toMillis() < CHASE_GAP_DAYS * 86_400_000) {
        recentlyChased++;
        continue;
      }
      rows.push({ key, number: i.number, customer: i.contact, email: i.email, amountDue: i.amountDue, currency: i.currency, dueDate: i.dueDate!, daysOverdue: i.daysOverdue, stage: chaseStage(i.daysOverdue, h?.count ?? 0), url: i.url });
    }
    const chasing = rows.filter((r) => r.email).slice(0, input.maxInvoices);
    const noEmail = rows.filter((r) => !r.email);
    // Email addresses stay out of the stored output tables; they only go on the drafts.
    const strip = (r: (typeof rows)[number]): Overdue => ({ key: r.key, number: r.number, customer: r.customer, amountDue: r.amountDue, currency: r.currency, dueDate: r.dueDate, daysOverdue: r.daysOverdue, stage: r.stage, url: r.url });
    const totalOverdue = Math.round(overdue.reduce((s, i) => s + i.amountDue, 0) * 100) / 100;
    const base = { system: books.system, totalOverdue, currency: overdue[0]?.currency ?? null, chasing: chasing.map(strip), noEmail: noEmail.map(strip), recentlyChased };
    if (!chasing.length) return { output: { ...base, emails: [] }, model: "rules", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };

    // The model sees customer names, amounts and dates; email addresses are added afterwards.
    const res = await generateJson({
      tier: "flash",
      system: [
        "Write payment reminder emails from a small business to customers with overdue invoices, one per invoice.",
        "Tone by stage: friendly = a light nudge, assume it was missed; firm = clear and direct, ask for a payment date; final = serious and polite, say this is the last reminder before the owner gets in touch personally.",
        "Always quote the invoice number, amount and due date exactly as given. Offer to resend the invoice. Never threaten legal action, add fees or invent interest. 60–110 words. Sign off with the business name.",
      ].join(" "),
      parts: [
        textPart(
          `${groundingPrompt(grounding)}\n\nOverdue invoices:\n${chasing
            .map((c, ref) => `ref ${ref}: ${c.customer}, invoice ${c.number ?? "(no number)"}, ${c.amountDue.toFixed(2)} ${c.currency} due ${c.dueDate} (${c.daysOverdue} days overdue), stage ${c.stage}`)
            .join("\n")}`,
        ),
      ],
      schema: ModelOutput,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    const emails = res.data.emails
      .filter((e) => chasing[e.ref])
      .map((e) => ({ to: chasing[e.ref].email, subject: e.subject, body: e.body, label: `${chasing[e.ref].customer} (${chasing[e.ref].stage})`, key: chasing[e.ref].key }));
    return { ...res, output: { ...base, emails }, notes: [`${overdue.length} overdue invoices in ${books.system === "xero" ? "Xero" : "QuickBooks"}; ${recentlyChased} chased in the last week`] };
  },

  approval(o) {
    const money = o.currency ? `${o.totalOverdue.toFixed(2)} ${o.currency}` : "";
    return {
      title: o.emails.length ? `${o.emails.length} payment reminder${o.emails.length > 1 ? "s" : ""} ready · ${money} overdue` : "No reminders due",
      preview: o.noEmail.length ? `${o.noEmail.length} overdue customer${o.noEmail.length > 1 ? "s have" : " has"} no email in your books.` : o.emails.map((e) => e.label).slice(0, 3).join(", "),
      severity: o.chasing.some((c) => c.stage === "final") ? "check" : "info",
      actions: [
        { id: "approve", label: "Save reminders as Gmail drafts", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }) {
    const result = await deliverDrafts(userId, o.emails, "payment reminders");
    if (result.delivered) {
      const { FieldValue } = await import("firebase-admin/firestore");
      await Promise.all(o.emails.map((e) => chaseRef(userId, e.key).set({ userId, count: FieldValue.increment(1), lastAt: FieldValue.serverTimestamp() }, { merge: true })));
    }
    return result;
  },
});
