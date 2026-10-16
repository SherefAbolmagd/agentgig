import { z } from "zod";
import { createEmailDraft, notDelivered, selfAddress, type Delivery } from "@/lib/connectors";
import { meetings as externalMeetings } from "@/lib/connectors/mail";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, documentParts, groundingPrompt } from "./types";

/** Booking Prep: a short brief for each external meeting on today's (or tomorrow's) calendar. */

export const BookingInput = z.object({ day: z.enum(["today", "tomorrow"]).default("today") });
export type BookingInput = z.infer<typeof BookingInput>;

const ModelOutput = z.object({
  briefs: z.array(z.object({ ref: z.number().int(), purpose: z.string(), talkingPoints: z.array(z.string()).max(4), ask: z.string() })),
});

export type BookingOutput = {
  day: string;
  meetings: { title: string; start: string; end: string; who: string; purpose: string; talkingPoints: string[]; ask: string; link: string | null }[];
};

export const bookingPrep = defineAgent<BookingInput, BookingOutput>({
  slug: "booking-prep",
  skillId: "meetings.brief",
  tier: "flash",
  inputSchema: BookingInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    const tz = grounding.profile?.timeZone ?? "Europe/London";
    const now = new Date();
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    if (input.day === "tomorrow") start.setUTCDate(start.getUTCDate() + 1);
    const end = new Date(start.getTime() + 86_400_000);
    const events = await externalMeetings(userId, start, end);
    if (!events) throw new GatewayError("INVALID_INPUT", "Connect Google or Microsoft 365 so Meeting Prep can read your calendar.");
    const label = start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
    if (!events.length) return { output: { day: label, meetings: [] }, model: "rules", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
    // Names and companies (from email domains) only; no email addresses to the model.
    const who = (e: (typeof events)[number]) => e.attendees.map((a) => a.name ?? a.email.split("@")[0]).join(", ") + ` (${[...new Set(e.attendees.map((a) => a.email.split("@")[1]))].join(", ")})`;
    const res = await generateJson({
      tier: "flash",
      system: "Prepare a small business owner for each meeting: its likely purpose, up to 4 talking points and one clear ask. Use only the details given and what you know about the business. Be brief.",
      parts: [
        ...documentParts(grounding),
        textPart(`${groundingPrompt(grounding)}\n\nMeetings on ${label}:\n${events.map((e, ref) => `ref ${ref}: "${e.title}" at ${new Date(e.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz })} with ${who(e)}${e.description ? `. Notes: ${e.description.slice(0, 400)}` : ""}`).join("\n")}`),
      ],
      schema: ModelOutput,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    const meetings = res.data.briefs
      .filter((b) => events[b.ref])
      .map((b) => {
        const e = events[b.ref];
        return { title: e.title, start: e.start, end: e.end, who: who(e), purpose: b.purpose, talkingPoints: b.talkingPoints, ask: b.ask, link: e.meetLink };
      });
    return { ...res, output: { day: label, meetings }, notes: [`${events.length} external meetings on ${label}`] };
  },

  approval(o) {
    return {
      title: o.meetings.length ? `${o.meetings.length} meeting brief${o.meetings.length > 1 ? "s" : ""} for ${o.day}` : `No external meetings ${o.day}`,
      preview: o.meetings.map((m) => m.title).join(", "),
      severity: "info",
      actions: [
        { id: "approve", label: "Email me the briefs", kind: "approve" },
        { id: "skip", label: "Not needed", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    if (!o.meetings.length) return { delivered: true, summary: "No meetings to brief" };
    const self = await selfAddress(userId);
    const body = o.meetings
      .map((m) => `${m.title} — ${m.who}\n${m.purpose}\n${m.talkingPoints.map((t) => `• ${t}`).join("\n")}\nAsk: ${m.ask}${m.link ? `\nJoin: ${m.link}` : ""}`)
      .join("\n\n");
    const draft = await createEmailDraft(userId, { to: self, subject: `Meeting briefs for ${o.day}`, body });
    if (!draft) return notDelivered("Briefs ready in AgentGig. Connect Google or Microsoft 365 to get them in your inbox.");
    return { delivered: true, summary: `Briefs saved as a draft to yourself in ${draft.app}`, links: [{ label: "Open draft", url: draft.url }] };
  },
});
