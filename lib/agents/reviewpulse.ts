import { z } from "zod";
import type { Delivery } from "@/lib/connectors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, documentParts, groundingPrompt } from "./types";

export const ReviewInput = z.object({
  reviewText: z.string().trim().min(2).max(4000),
  rating: z.number().int().min(1).max(5),
  reviewerName: z.string().trim().max(80).optional(),
  platform: z.string().trim().max(40).default("Google"),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

const ModelOutput = z.object({
  reply: z.string().describe("Public reply from the business, 2–4 sentences, in its voice"),
  sentiment: z.enum(["positive", "mixed", "negative"]),
  urgent: z.boolean().describe("True if it mentions safety, illness, legal threats, or a serious service failure"),
  themes: z.array(z.string()).max(5).describe("Short topics the review is about, e.g. delivery speed"),
  internalNote: z.string().describe("One sentence for the owner: what to fix or follow up, if anything"),
});
export type ReviewOutput = z.infer<typeof ModelOutput> & { rating: number; platform: string };

const SYSTEM = `You are ReviewPulse. Draft a public reply to a customer review for a small business.
- Thank them by first name if given. Address the specific points they raised.
- For criticism: acknowledge, don't argue, offer to make it right offline (no personal contact details in the reply).
- Never promise refunds or compensation; never invent facts about the business.`;

export const reviewPulse = defineAgent<ReviewInput, ReviewOutput>({
  slug: "reviewpulse",
  skillId: "review.reply",
  tier: "flash",
  inputSchema: ReviewInput,
  scrubFields: ["reviewText"],
  editableField: "reply",
  files: null,

  async run({ input, grounding }) {
    const res = await generateJson({
      tier: "flash",
      system: SYSTEM,
      parts: [
        ...documentParts(grounding),
        textPart(`${groundingPrompt(grounding)}\n\n${input.rating}-star review on ${input.platform}${input.reviewerName ? ` from ${input.reviewerName}` : ""}:\n"""${input.reviewText}"""`),
      ],
      schema: ModelOutput,
      temperature: 0.4,
      thinkingBudget: 0,
    });
    const urgent = res.data.urgent || input.rating <= 2;
    return { ...res, output: { ...res.data, urgent, rating: input.rating, platform: input.platform } };
  },

  approval(o) {
    return {
      title: o.urgent ? `${o.rating}-star review needs attention` : `Reply ready for a ${o.rating}-star review`,
      preview: o.urgent ? o.internalNote : `“${o.reply.slice(0, 140)}”`,
      severity: o.urgent ? "check" : "info",
      actions: [
        { id: "approve", label: "Approve reply", kind: "approve" },
        { id: "edit", label: "Edit first", kind: "edit" },
        { id: "skip", label: "Skip", kind: "skip" },
      ],
    };
  },

  // Posting review replies needs Google Business Profile API access, which Google grants on application.
  async deliver(o): Promise<Delivery> {
    return { delivered: false, summary: `Reply approved. Paste it into ${o.platform}: it's in the result panel with a copy button.` };
  },
});
