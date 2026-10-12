import { createHash } from "node:crypto";
import { z } from "zod";
import { allBookings, type Booking } from "@/lib/connectors/bookings";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { generateJson, textPart } from "@/lib/vertex";
import { deliverDrafts, type DraftEmail } from "./drafts";
import { defineAgent, groundingPrompt } from "./types";

/**
 * Booking Assistant: reminders for tomorrow's appointments and follow-ups for
 * yesterday's (thank-you, missed appointment, or cancellation) from Square
 * Appointments, Calendly and Acuity. Each booking gets each message once.
 */

export const BookingAssistantInput = z.object({
  mode: z.enum(["both", "reminders", "follow-ups"]).default("both"),
  /** Falls back to the review link in the business profile. */
  reviewUrl: z.url({ protocol: /^https$/ }).optional(),
  /** Where people rebook; falls back to the website in the profile. */
  bookingUrl: z.url({ protocol: /^https?$/ }).optional(),
});
export type BookingAssistantInput = z.infer<typeof BookingAssistantInput>;

export type MessageKind = "reminder" | "thank_you" | "missed" | "cancelled";

/** Which message a booking needs, given when it is relative to today. */
export function messageFor(b: Pick<Booking, "start" | "status">, now: Date): MessageKind | null {
  const day = (iso: string) => Math.floor(Date.parse(iso) / 86_400_000);
  const today = Math.floor(now.getTime() / 86_400_000);
  const d = day(b.start) - today;
  if (d === 1) return b.status === "booked" ? "reminder" : null;
  if (d === -1) return b.status === "booked" ? "thank_you" : b.status === "no_show" ? "missed" : "cancelled";
  return null;
}

const ModelOutput = z.object({ emails: z.array(z.object({ ref: z.number().int(), subject: z.string(), body: z.string() })) });

export type BookingAssistantOutput = {
  sources: string[];
  counts: Record<MessageKind, number>;
  noEmail: number;
  alreadySent: number;
  emails: (DraftEmail & { key: string; kind: MessageKind })[];
};

const msgRef = (key: string) => db().collection("booking_messages").doc(key);

export const bookingAssistant = defineAgent<BookingAssistantInput, BookingAssistantOutput>({
  slug: "booking-assistant",
  skillId: "bookings.messages",
  tier: "flash",
  inputSchema: BookingAssistantInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    const now = new Date();
    const from = new Date(Math.floor(now.getTime() / 86_400_000 - 1) * 86_400_000);
    const to = new Date(from.getTime() + 3 * 86_400_000);
    const found = await allBookings(userId, from, to);
    if (!found) throw new GatewayError("INVALID_INPUT", "Connect Square, Calendly or Acuity so Booking Assistant can see your appointments.");
    const reviewUrl = input.reviewUrl ?? grounding.profile?.reviewUrl ?? null;
    const bookingUrl = input.bookingUrl ?? grounding.profile?.website ?? null;
    const tz = grounding.profile?.timeZone ?? "Europe/London";

    const wanted = found.bookings
      .map((b) => ({ ...b, kind: messageFor(b, now) }))
      .filter((b): b is Booking & { kind: MessageKind } => b.kind !== null)
      .filter((b) => input.mode === "both" || (input.mode === "reminders") === (b.kind === "reminder"))
      .map((b) => ({ ...b, key: createHash("sha256").update(`${userId}|${b.id}|${b.kind}`).digest("hex").slice(0, 40) }));
    const snaps = wanted.length ? await db().getAll(...wanted.map((w) => msgRef(w.key))) : [];
    const sent = new Set(snaps.filter((s) => s.exists).map((s) => s.id));
    const fresh = wanted.filter((w) => !sent.has(w.key));
    const withEmail = fresh.filter((w) => w.customerEmail).slice(0, 30);
    const counts = { reminder: 0, thank_you: 0, missed: 0, cancelled: 0 } as Record<MessageKind, number>;
    for (const w of withEmail) counts[w.kind]++;
    const base = { sources: found.sources, counts, noEmail: fresh.length - fresh.filter((w) => w.customerEmail).length, alreadySent: wanted.length - fresh.length };
    if (!withEmail.length) return { output: { ...base, emails: [] }, model: "rules", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };

    const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: tz });
    const res = await generateJson({
      tier: "flash",
      system: [
        "Write short emails from a small business to its customers about their appointments, one per customer. 40–90 words, warm and clear, signed with the business name.",
        "reminder: confirm the service, day and time; ask them to let you know if they can't make it.",
        "thank_you: thank them for coming; if a review link is given, invite a review with it, once, no pressure.",
        "missed: kind, no blame; say you'd be glad to find a new time and include the booking link if given.",
        "cancelled: sorry it didn't work out; offer to rebook with the booking link if given.",
        "Never invent prices, policies or fees.",
      ].join(" "),
      parts: [
        textPart(
          `${groundingPrompt(grounding)}\n${reviewUrl ? `Review link: ${reviewUrl}\n` : ""}${bookingUrl ? `Booking link: ${bookingUrl}\n` : ""}\nAppointments:\n${withEmail
            .map((w, ref) => `ref ${ref}: ${w.kind} — ${w.customerName.split(" ")[0] || "there"}, ${w.service}, ${when(w.start)}`)
            .join("\n")}`,
        ),
      ],
      schema: ModelOutput,
      temperature: 0.5,
      thinkingBudget: 0,
    });
    const emails = res.data.emails
      .filter((e) => withEmail[e.ref])
      .map((e) => ({ to: withEmail[e.ref].customerEmail, subject: e.subject, body: e.body, label: `${withEmail[e.ref].customerName} (${withEmail[e.ref].kind.replace("_", " ")})`, key: withEmail[e.ref].key, kind: withEmail[e.ref].kind }));
    return { ...res, output: { ...base, emails }, notes: [`${found.bookings.length} bookings from ${found.sources.join(", ")} between yesterday and tomorrow`] };
  },

  approval(o) {
    const c = o.counts;
    const parts = [c.reminder && `${c.reminder} reminder${c.reminder > 1 ? "s" : ""}`, c.thank_you && `${c.thank_you} thank-you${c.thank_you > 1 ? "s" : ""}`, c.missed && `${c.missed} missed`, c.cancelled && `${c.cancelled} cancelled`].filter(Boolean);
    return {
      title: o.emails.length ? `Booking emails ready: ${parts.join(", ")}` : "No booking emails needed",
      preview: o.noEmail ? `${o.noEmail} booking${o.noEmail > 1 ? "s have" : " has"} no customer email.` : o.emails.map((e) => e.label).slice(0, 3).join(", "),
      severity: "info",
      actions: [
        { id: "approve", label: "Save as email drafts", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }) {
    const result = await deliverDrafts(userId, o.emails, "booking emails");
    if (result.delivered) await Promise.all(o.emails.map((e) => msgRef(e.key).set({ userId, kind: e.kind, at: new Date() })));
    return result;
  },
});
