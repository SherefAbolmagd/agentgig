import { createHash } from "node:crypto";
import { z } from "zod";
import { storeDeliveredOrders } from "@/lib/connectors/store";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { generateJson, textPart } from "@/lib/vertex";
import { deliverDrafts, type DraftEmail } from "./drafts";
import { defineAgent, groundingPrompt } from "./types";

/**
 * Review Requester: a few days after an order arrives, asks the customer for a
 * review. Refunded orders are skipped, and each customer is asked at most once
 * every 90 days (review_requests holds a hash of their email, not the address).
 */

export const ReviewRequestInput = z.object({
  /** Falls back to the review link in the business profile. */
  reviewUrl: z.url({ protocol: /^https$/ }).optional(),
  daysAfterDelivery: z.number().int().min(1).max(30).default(5),
  maxRequests: z.number().int().min(1).max(30).default(15),
  subscribedOnly: z.boolean().default(true),
});
export type ReviewRequestInput = z.infer<typeof ReviewRequestInput>;

const ModelOutput = z.object({ emails: z.array(z.object({ ref: z.number().int(), subject: z.string(), body: z.string() })) });

export type ReviewRequestOutput = {
  reviewUrl: string;
  source: string;
  emails: (DraftEmail & { hash: string })[];
  skipped: { refunded: number; noConsent: number; askedRecently: number };
};

const ASK_GAP_DAYS = 90;
const hashEmail = (userId: string, email: string) => createHash("sha256").update(`${userId}:${email.trim().toLowerCase()}`).digest("hex").slice(0, 40);
const askRef = (hash: string) => db().collection("review_requests").doc(hash);

export const reviewRequester = defineAgent<ReviewRequestInput, ReviewRequestOutput>({
  slug: "review-requester",
  skillId: "reviews.request",
  tier: "flash",
  inputSchema: ReviewRequestInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    const reviewUrl = input.reviewUrl ?? grounding.profile?.reviewUrl;
    if (!reviewUrl) throw new GatewayError("INVALID_INPUT", "Add your review link (for example your Google review link) in Company knowledge, or enter it here.");
    const found = await storeDeliveredOrders(userId, input.daysAfterDelivery, input.daysAfterDelivery + 7);
    if (!found) throw new GatewayError("INVALID_INPUT", "Connect Shopify or WooCommerce so Review Requester can see delivered orders.");

    const skipped = { refunded: 0, noConsent: 0, askedRecently: 0 };
    const byCustomer = new Map<string, (typeof found.orders)[number]>();
    for (const o of found.orders) {
      if (o.refunded) skipped.refunded++;
      else if (input.subscribedOnly && !o.marketingConsent) skipped.noConsent++;
      else byCustomer.set(o.email.toLowerCase(), o);
    }
    const candidates = [...byCustomer.values()].map((o) => ({ ...o, hash: hashEmail(userId, o.email) }));
    const snaps = candidates.length ? await db().getAll(...candidates.map((c) => askRef(c.hash))) : [];
    const recent = new Set(snaps.filter((s) => s.exists && Date.now() - (s.get("lastAt")?.toMillis() ?? 0) < ASK_GAP_DAYS * 86_400_000).map((s) => s.id));
    const picked = candidates.filter((c) => !recent.has(c.hash)).slice(0, input.maxRequests);
    skipped.askedRecently = candidates.length - candidates.filter((c) => !recent.has(c.hash)).length;
    if (!picked.length) return { output: { reviewUrl, source: found.source, emails: [], skipped }, model: "rules", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };

    // First names and what they bought only; addresses are attached afterwards.
    const res = await generateJson({
      tier: "flash",
      system:
        "Write a short, warm email from a small business asking a customer how their order went and inviting a review at the link given. Mention what they bought. One clear request, no pressure, no incentives for reviews, 50–90 words. Include the link exactly once. Sign off with the business name.",
      parts: [textPart(`${groundingPrompt(grounding)}\n\nReview link: ${reviewUrl}\n\nCustomers:\n${picked.map((p, ref) => `ref ${ref}: ${p.firstName || "there"} bought ${p.items.join(", ")} (order ${p.number})`).join("\n")}`)],
      schema: ModelOutput,
      temperature: 0.6,
      thinkingBudget: 0,
    });
    const emails = res.data.emails
      .filter((e) => picked[e.ref] && e.body.includes(reviewUrl))
      .map((e) => ({ to: picked[e.ref].email, subject: e.subject, body: e.body, label: picked[e.ref].firstName || picked[e.ref].number, hash: picked[e.ref].hash }));
    return { ...res, output: { reviewUrl, source: found.source, emails, skipped }, notes: [`${found.orders.length} orders delivered ${input.daysAfterDelivery}–${input.daysAfterDelivery + 7} days ago in ${found.source}`] };
  },

  approval(o) {
    const s = o.skipped;
    return {
      title: o.emails.length ? `${o.emails.length} review request${o.emails.length > 1 ? "s" : ""} ready` : "No one to ask for a review today",
      preview: [s.refunded && `${s.refunded} refunded`, s.noConsent && `${s.noConsent} without marketing consent`, s.askedRecently && `${s.askedRecently} asked recently`].filter(Boolean).join(", ") || o.emails.map((e) => e.label).slice(0, 4).join(", "),
      severity: "info",
      actions: [
        { id: "approve", label: "Save as email drafts", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }) {
    const result = await deliverDrafts(userId, o.emails, "review requests");
    if (result.delivered) await Promise.all(o.emails.map((e) => askRef(e.hash).set({ userId, lastAt: new Date() })));
    return result;
  },
});
