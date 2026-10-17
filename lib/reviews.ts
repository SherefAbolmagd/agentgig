import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "./firebase-admin";
import { GatewayError } from "./errors";
import { consume } from "./rate-limit";
import { enqueue } from "./triggers";
import { COLLECTIONS, type HireDoc, type ReviewDoc, type UserDoc } from "@/types/firestore";

/**
 * The review page: every business can have a public page at /r/{slug} where
 * customers leave a star rating and a comment. A new review starts ReviewPulse
 * when it's hired with the "reviews.new" trigger; the reply the owner approves
 * is published under the review on the same page.
 */

export const REVIEW_EVENT = "reviews.new";

export const ReviewSubmit = z.object({
  rating: z.number().int().min(1).max(5),
  name: z.string().trim().min(1).max(60),
  text: z.string().trim().min(2).max(2000),
  /** Honeypot: people never see this field, bots fill it in. */
  website: z.string().max(0).optional(),
});

export interface PublicReview {
  id: string;
  rating: number;
  name: string;
  text: string;
  createdAt: string;
  reply: { text: string; at: string } | null;
}

const reviews = () => db().collection(COLLECTIONS.reviews);

export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\b(ltd|limited|llc|inc)\b/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business"
  );
}

/** The account's review page slug, created on first use (unique across accounts). */
export async function ensureReviewPage(accountId: string, preferred?: string): Promise<string> {
  const ref = db().collection(COLLECTIONS.users).doc(accountId);
  const user = (await ref.get()).data() as UserDoc | undefined;
  if (!user) throw new GatewayError("USER_NOT_FOUND", "No such account.");
  if (user.reviewSlug && (!preferred || user.reviewSlug === preferred)) return user.reviewSlug;
  const base = preferred ?? slugify(user.businessName);
  for (let n = 0; n < 50; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const taken = await db().collection(COLLECTIONS.users).where("reviewSlug", "==", slug).limit(1).get();
    if (taken.empty || taken.docs[0].id === accountId) {
      await ref.update({ reviewSlug: slug, updatedAt: FieldValue.serverTimestamp() });
      return slug;
    }
  }
  throw new GatewayError("INVALID_INPUT", "Couldn't find a free review page address.");
}

export async function accountBySlug(slug: string): Promise<{ id: string; user: UserDoc } | null> {
  if (!/^[a-z0-9-]{1,48}$/.test(slug)) return null;
  const snap = await db().collection(COLLECTIONS.users).where("reviewSlug", "==", slug).limit(1).get();
  const doc = snap.docs[0];
  return doc ? { id: doc.id, user: doc.data() as UserDoc } : null;
}

/** Newest first. Read through the server only: the page is public, the collection is not. */
export async function listReviews(accountId: string, limit = 30): Promise<PublicReview[]> {
  const snap = await reviews().where("userId", "==", accountId).limit(200).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as ReviewDoc) }))
    .filter((r) => r.status !== "hidden")
    .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      rating: r.rating,
      name: r.name,
      text: r.text,
      createdAt: r.createdAt?.toDate().toISOString() ?? new Date().toISOString(),
      reply: r.reply ? { text: r.reply.text, at: r.reply.at.toDate().toISOString() } : null,
    }));
}

/** A customer's review: saved, shown at once, and handed to ReviewPulse if it's listening. */
export async function submitReview(slug: string, input: z.infer<typeof ReviewSubmit>, ip: string) {
  if (input.website) throw new GatewayError("INVALID_INPUT", "Something went wrong. Please try again.");
  const account = await accountBySlug(slug);
  if (!account) throw new GatewayError("USER_NOT_FOUND", "This review page doesn't exist.");
  await consume("reviewsPerIp", ip);
  await consume("reviewsPerPage", account.id);

  const ref = reviews().doc();
  await ref.set({ userId: account.id, rating: input.rating, name: input.name, text: input.text, status: "new", reply: null, createdAt: FieldValue.serverTimestamp() });

  const hire = (await db().collection(COLLECTIONS.hires).doc(`${account.id}_reviewpulse`).get()).data() as HireDoc | undefined;
  if (hire?.active && hire.trigger.event === REVIEW_EVENT) {
    await enqueue({
      key: `review-${ref.id}`,
      userId: account.id,
      agentId: "reviewpulse",
      input: { reviewText: input.text, rating: input.rating, reviewerName: input.name, platform: "your review page", reviewId: ref.id },
      origin: "event",
    });
  }
  return { id: ref.id };
}

/** The owner's approved reply, shown under the review. Only replies to the account's own reviews. */
export async function publishReply(accountId: string, reviewId: string, text: string): Promise<boolean> {
  const ref = reviews().doc(reviewId);
  return db().runTransaction(async (tx) => {
    const review = (await tx.get(ref)).data() as ReviewDoc | undefined;
    if (!review || review.userId !== accountId) return false;
    tx.update(ref, { status: "replied", reply: { text: text.trim().slice(0, 2000), at: FieldValue.serverTimestamp() } });
    return true;
  });
}
