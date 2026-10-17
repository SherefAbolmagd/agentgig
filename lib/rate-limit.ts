import "server-only";
import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase-admin";
import { GatewayError } from "./errors";

/**
 * Fixed-window rate limits stored in Firestore, so they hold across Cloud Run
 * instances. Counter docs carry `expireAt`; a Firestore TTL policy deletes
 * them after their window.
 */

export const LIMITS = {
  /**
   * New demo sandboxes per IP address. Generous because judges at one venue
   * share a network; sandboxGlobal is the real cost ceiling.
   */
  sandboxPerIp: { limit: 30, windowSec: 3600 },
  /** New demo sandboxes per day across everyone. Each one can spend real Gemini and DLP money. */
  sandboxGlobal: { limit: 500, windowSec: 86_400 },
  /** Agent tasks per user. */
  tasksPerUser: { limit: 40, windowSec: 600 },
  /** Simulated top-ups per user; in production this is replaced by real payments. */
  topupsPerUser: { limit: 3, windowSec: 86_400 },
  /** Knowledge and inbox uploads per user. */
  uploadsPerUser: { limit: 40, windowSec: 3600 },
  /** Agent registrations per developer (each sends a test task). */
  registrationsPerUser: { limit: 10, windowSec: 3600 },
  /** Telegram messages per linked person. */
  telegramPerUser: { limit: 60, windowSec: 600 },
  /** Replies to Telegram users who aren't linked, per Telegram account. */
  telegramStranger: { limit: 5, windowSec: 3600 },
  /** Telegram link codes per person. */
  telegramLinkCodes: { limit: 10, windowSec: 3600 },
  /** Reviews from one network, across all review pages. */
  reviewsPerIp: { limit: 5, windowSec: 3600 },
  /** Reviews on one business's page (each one can start a paid agent task). */
  reviewsPerPage: { limit: 30, windowSec: 86_400 },
} as const;

export type LimitName = keyof typeof LIMITS;

const MESSAGES: Record<LimitName, string> = {
  sandboxPerIp: "Too many demo sandboxes from your network. Try again in an hour, or create a free account.",
  sandboxGlobal: "The demo is very busy today. Create a free account to keep going.",
  tasksPerUser: "Your team is running a lot of tasks at once. Wait a few minutes and try again.",
  topupsPerUser: "You've reached today's limit for demo top-ups.",
  uploadsPerUser: "Too many uploads in the last hour. Try again later.",
  registrationsPerUser: "Too many registration attempts. Try again in an hour.",
  telegramPerUser: "You're sending messages faster than your team can keep up. Give it a few minutes.",
  telegramStranger: "Too many messages.",
  telegramLinkCodes: "Too many Telegram links created. Try again in an hour.",
  reviewsPerIp: "Thanks! You've left several reviews already. Try again later.",
  reviewsPerPage: "This business has had a lot of reviews today. Try again tomorrow.",
};

/** Counts one use of `name` for `subject`; throws RATE_LIMITED when over the limit. */
export async function consume(name: LimitName, subject: string): Promise<void> {
  const { limit, windowSec } = LIMITS[name];
  const now = Date.now();
  const windowStart = Math.floor(now / 1000 / windowSec) * windowSec;
  const id = createHash("sha256").update(`${name}\n${subject}\n${windowStart}`).digest("hex").slice(0, 40);
  const ref = db().collection("rate_limits").doc(id);

  const count = await db().runTransaction(async (tx) => {
    const current = ((await tx.get(ref)).get("count") as number | undefined) ?? 0;
    if (current >= limit) return current + 1;
    tx.set(ref, {
      name,
      count: FieldValue.increment(1),
      expireAt: Timestamp.fromMillis((windowStart + windowSec) * 1000 + 60_000),
    }, { merge: true });
    return current + 1;
  });

  if (count > limit) {
    const retryAfter = windowStart + windowSec - Math.floor(now / 1000);
    throw new GatewayError("RATE_LIMITED", MESSAGES[name], { retryAfterSeconds: retryAfter });
  }
}

/** Best-effort client IP behind Cloud Run's front end. */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
