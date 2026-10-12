import { z } from "zod";
import { notDelivered, type Delivery } from "@/lib/connectors";
import { mailchimpDraftCampaign } from "@/lib/connectors/mailchimp";
import { storeProducts } from "@/lib/connectors/store";
import { db } from "@/lib/firebase-admin";
import { generateJson, textPart } from "@/lib/vertex";
import { COLLECTIONS, type TaskDoc } from "@/types/firestore";
import { defineAgent, documentParts, groundingPrompt } from "./types";

/** Newsletter Writer: a campaign from your profile, best sellers and recent posts, saved as a Mailchimp draft. */

export const NewsletterInput = z.object({
  topic: z.string().trim().max(300).optional(),
  ctaUrl: z.url({ protocol: /^https?$/ }).optional(),
});
export type NewsletterInput = z.infer<typeof NewsletterInput>;

const ModelOutput = z.object({
  subject: z.string().describe("Under 60 characters"),
  previewText: z.string().describe("Under 100 characters"),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })).min(1).max(4),
  ctaLabel: z.string(),
});

export type NewsletterOutput = z.infer<typeof ModelOutput> & { html: string; ctaUrl: string | null };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Simple, email-safe HTML (tables, inline styles). */
export function newsletterHtml(n: z.infer<typeof ModelOutput>, ctaUrl: string | null, business: string): string {
  const sections = n.sections
    .map((s) => `<tr><td style="padding:16px 24px"><h2 style="margin:0 0 8px;font:600 20px Arial,sans-serif;color:#14201b">${esc(s.heading)}</h2>${s.body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;font:16px/1.5 Arial,sans-serif;color:#333">${esc(p)}</p>`).join("")}</td></tr>`)
    .join("");
  const cta = ctaUrl ? `<tr><td style="padding:8px 24px 24px"><a href="${esc(ctaUrl)}" style="display:inline-block;background:#0b7a62;color:#fff;padding:12px 20px;border-radius:8px;font:600 16px Arial,sans-serif;text-decoration:none">${esc(n.ctaLabel)}</a></td></tr>` : "";
  return `<!doctype html><html><body style="margin:0;background:#f3f5f2"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px"><tr><td style="padding:24px 24px 0;font:700 14px Arial,sans-serif;color:#56655e">${esc(business)}</td></tr>${sections}${cta}<tr><td style="padding:16px 24px;font:12px Arial,sans-serif;color:#888">*|LIST:ADDRESSLINE|* · <a href="*|UNSUB|*">Unsubscribe</a></td></tr></table></td></tr></table></body></html>`;
}

export const newsletterWriter = defineAgent<NewsletterInput, NewsletterOutput>({
  slug: "newsletter-writer",
  skillId: "newsletter.draft",
  tier: "flash",
  inputSchema: NewsletterInput,
  scrubFields: ["topic"],
  files: null,

  async run({ input, grounding, userId }) {
    const store = await storeProducts(userId).catch(() => null);
    const best = store?.products.sort((a, b) => b.soldLast7 - a.soldLast7).slice(0, 5) ?? [];
    const posts = (await db().collection(COLLECTIONS.tasks).where("userId", "==", userId).where("agentId", "==", "echosocial").limit(10).get()).docs
      .map((d) => d.data() as TaskDoc)
      .filter((t) => t.status === "delivered" && typeof t.output?.text === "string")
      .slice(0, 3)
      .map((t) => String(t.output!.text).slice(0, 600));
    const res = await generateJson({
      tier: "flash",
      system:
        "Write a short email newsletter for a small business: 2–4 sections, warm and useful, never pushy. Use only facts given about the business, its products and its recent posts. No invented discounts.",
      parts: [
        ...documentParts(grounding),
        textPart(
          [
            groundingPrompt(grounding),
            input.topic ? `Theme for this issue: ${input.topic}` : "Theme: what's new and what customers love.",
            best.length ? `Best sellers this week: ${best.map((b) => `${b.name} (${b.soldLast7} sold)`).join(", ")}` : "",
            posts.length ? `Recent social posts:\n${posts.join("\n---\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      ],
      schema: ModelOutput,
      temperature: 0.6,
      thinkingBudget: 0,
    });
    const ctaUrl = input.ctaUrl ?? grounding.profile?.website ?? null;
    return { ...res, output: { ...res.data, ctaUrl, html: newsletterHtml(res.data, ctaUrl, grounding.businessName) } };
  },

  approval(o) {
    return {
      title: `Newsletter ready: “${o.subject}”`,
      preview: o.previewText,
      severity: "info",
      actions: [
        { id: "approve", label: "Save as Mailchimp draft", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    const draft = await mailchimpDraftCampaign(userId, { subject: o.subject, previewText: o.previewText, html: o.html, fromName: "" });
    if (!draft) return notDelivered("Newsletter ready. Connect Mailchimp to save it as a draft campaign.");
    return { delivered: true, summary: "Saved as a draft campaign in Mailchimp. Nothing was sent.", links: [{ label: "Open in Mailchimp", url: draft.url }] };
  },
});
