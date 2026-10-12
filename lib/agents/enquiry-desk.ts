import { z } from "zod";
import { newFormEntries } from "@/lib/connectors/forms";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { generateJson, textPart } from "@/lib/vertex";
import { deliverDrafts, type DraftEmail } from "./drafts";
import { defineAgent, documentParts, groundingPrompt } from "./types";

/**
 * Enquiry Desk: sorts new Typeform and Jotform responses (quote request,
 * question, complaint, spam…) and drafts a reply to each real enquiry.
 * Each entry is handled once (form_entries keeps its key).
 */

export const EnquiryInput = z.object({ sinceHours: z.number().int().min(1).max(168).default(24) });
export type EnquiryInput = z.infer<typeof EnquiryInput>;

export const CATEGORIES = ["quote_request", "question", "booking", "complaint", "job_application", "supplier_pitch", "spam", "other"] as const;

const ModelOutput = z.object({
  items: z.array(
    z.object({
      ref: z.number().int(),
      category: z.enum(CATEGORIES),
      urgent: z.boolean().describe("A complaint, a deadline within days, or a large order"),
      summary: z.string().describe("One line for the owner"),
      reply: z.object({ subject: z.string(), body: z.string() }).nullable().describe("Null for spam and supplier pitches"),
    }),
  ),
});

export type EnquiryOutput = {
  sources: string[];
  entries: { key: string; form: string; submittedAt: string; name: string | null; category: (typeof CATEGORIES)[number]; urgent: boolean; summary: string; hasEmail: boolean }[];
  emails: DraftEmail[];
  /** Every entry handled in this run, marked done on delivery. */
  keys: string[];
};

/** Hides email addresses and phone numbers in free-text answers before they reach the model. */
export function redactContact(text: string): string {
  return text.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
}

const doneRef = (userId: string, key: string) => db().collection("form_entries").doc(`${userId}_${key}`.replace(/[^A-Za-z0-9_-]/g, "-"));

export const enquiryDesk = defineAgent<EnquiryInput, EnquiryOutput>({
  slug: "enquiry-desk",
  skillId: "enquiries.triage",
  tier: "flash",
  inputSchema: EnquiryInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    const found = await newFormEntries(userId, new Date(Date.now() - input.sinceHours * 3_600_000));
    if (!found) throw new GatewayError("INVALID_INPUT", "Connect Typeform or Jotform so Enquiry Desk can read your form responses.");
    const snaps = found.entries.length ? await db().getAll(...found.entries.map((e) => doneRef(userId, e.key))) : [];
    const done = new Set(snaps.filter((s) => s.exists).map((s) => s.id));
    const fresh = found.entries.filter((e) => !done.has(doneRef(userId, e.key).id)).slice(0, 25);
    if (!fresh.length) return { output: { sources: found.sources, entries: [], emails: [], keys: [] }, model: "rules", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };

    const res = await generateJson({
      tier: "flash",
      system: [
        "You triage enquiries a small business received through its website forms. For each one: pick a category, flag it urgent if it is, write a one-line summary for the owner, and draft a helpful reply.",
        "Answer from the business's own information only. For quote requests, thank them, confirm what they asked for, and say a quote will follow (or ask the one or two details needed to price it); never make up prices.",
        "Reply null for spam and supplier sales pitches. Replies are 50–120 words and signed with the business name.",
      ].join(" "),
      parts: [
        ...documentParts(grounding),
        textPart(
          `${groundingPrompt(grounding)}\n\nNew form entries:\n${fresh
            .map((e, ref) => `ref ${ref} (${e.form}, first name ${e.name?.split(" ")[0] ?? "unknown"}):\n${e.answers.map((a) => `- ${a.question}: ${redactContact(a.answer).slice(0, 800)}`).join("\n")}`)
            .join("\n\n")}`,
        ),
      ],
      schema: ModelOutput,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    const entries: EnquiryOutput["entries"] = [];
    const emails: DraftEmail[] = [];
    for (const item of res.data.items) {
      const e = fresh[item.ref];
      if (!e) continue;
      entries.push({ key: e.key, form: e.form, submittedAt: e.submittedAt, name: e.name, category: item.category, urgent: item.urgent, summary: item.summary, hasEmail: !!e.email });
      if (item.reply && e.email) emails.push({ to: e.email, subject: item.reply.subject, body: item.reply.body, label: `${e.name ?? e.email} (${item.category.replace("_", " ")})` });
    }
    return { ...res, output: { sources: found.sources, entries, emails, keys: fresh.map((e) => e.key) }, notes: [`${fresh.length} new entries from ${found.sources.join(" and ")}`] };
  },

  approval(o) {
    const urgent = o.entries.filter((e) => e.urgent).length;
    return {
      title: o.entries.length ? `${o.entries.length} new enquir${o.entries.length === 1 ? "y" : "ies"}, ${o.emails.length} repl${o.emails.length === 1 ? "y" : "ies"} drafted` : "No new enquiries",
      preview: urgent ? `${urgent} urgent: ${o.entries.find((e) => e.urgent)!.summary}` : (o.entries[0]?.summary ?? ""),
      severity: urgent ? "check" : "info",
      actions: [
        { id: "approve", label: "Save replies as email drafts", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }) {
    const result = o.emails.length ? await deliverDrafts(userId, o.emails, "replies") : { delivered: true, summary: "No replies needed" };
    if (result.delivered) await Promise.all(o.keys.map((k) => doneRef(userId, k).set({ userId, at: new Date() })));
    return result;
  },
});
