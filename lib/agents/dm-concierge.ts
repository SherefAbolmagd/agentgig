import { z } from "zod";
import { slackPost, notDelivered, type Delivery } from "@/lib/connectors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, documentParts, groundingPrompt } from "./types";

export const DmConciergeInput = z.object({
  customerMessage: z.string().trim().min(2).max(2000),
  customerName: z.string().trim().max(80).optional(),
  /** Set by the Slack trigger so the reply lands in the same thread. */
  slack: z.object({ channel: z.string(), ts: z.string() }).optional(),
});
export type DmConciergeInput = z.infer<typeof DmConciergeInput>;

const ModelOutput = z.object({
  reply: z.string().describe("The reply to send the customer, in the business's voice"),
  confidence: z.number().min(0).max(1).describe("How sure you are the reply is correct from the facts given"),
  needsHuman: z.boolean().describe("True for refunds, complaints, anything not covered by the facts, or anything risky"),
  reason: z.string().describe("One short sentence: why a human is or isn't needed"),
  category: z.enum(["delivery", "order_status", "product", "pricing", "refund_or_complaint", "other"]),
});
export type DmConciergeOutput = z.infer<typeof ModelOutput> & { slack?: { channel: string; ts: string } };

const SYSTEM = `You are DM Concierge, answering customer messages for a small business.
- Answer only from the business profile and documents given. If the answer isn't there, say you'll check with the team and set needsHuman.
- Refunds, complaints, damaged goods, legal or payment problems always need a human.
- Keep replies short (2–4 sentences), warm and specific. Never invent prices, times or policies.`;

export const dmConcierge = defineAgent<DmConciergeInput, DmConciergeOutput>({
  slug: "dm-concierge",
  skillId: "support.reply",
  tier: "flash",
  inputSchema: DmConciergeInput,
  scrubFields: ["customerMessage", "customerName"],
  editableField: "reply",
  files: null,

  async run({ input, grounding }) {
    const res = await generateJson({
      tier: "flash",
      system: SYSTEM,
      parts: [
        ...documentParts(grounding),
        textPart(`${groundingPrompt(grounding)}\n\nCustomer${input.customerName ? ` (${input.customerName})` : ""} wrote:\n"""${input.customerMessage}"""`),
      ],
      schema: ModelOutput,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    const needsHuman = res.data.needsHuman || res.data.confidence < 0.6;
    return { ...res, output: { ...res.data, needsHuman, ...(input.slack && { slack: input.slack }) } };
  },

  approval(o) {
    return o.needsHuman
      ? {
          title: "A customer needs you",
          preview: `${o.reason} Suggested reply: “${o.reply.slice(0, 120)}”`,
          severity: "check",
          actions: [
            { id: "approve", label: "Send suggested reply", kind: "approve" },
            { id: "edit", label: "Edit first", kind: "edit" },
            { id: "skip", label: "I'll reply myself", kind: "skip" },
          ],
        }
      : {
          title: "A customer reply is ready",
          preview: `“${o.reply.slice(0, 140)}”`,
          severity: "info",
          actions: [
            { id: "approve", label: "Send reply", kind: "approve" },
            { id: "edit", label: "Edit first", kind: "edit" },
            { id: "skip", label: "Skip", kind: "skip" },
          ],
        };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    const text = o.reply;
    if (o.slack) {
      const posted = await slackPost(userId, { channel: o.slack.channel, threadTs: o.slack.ts, text });
      if (posted) return { delivered: true, summary: "Replied in the Slack thread", links: posted.url ? [{ label: "Open in Slack", url: posted.url }] : [] };
    }
    return notDelivered("Reply ready. Connect Slack so DM Concierge can answer in your channel.");
  },
});
