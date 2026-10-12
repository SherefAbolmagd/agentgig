import "server-only";
import { db } from "@/lib/firebase-admin";
import { COLLECTIONS, type ConnectionDoc } from "@/types/firestore";
import { gmailCreateDraft, sheetsAppendRow } from "./google";
import { linkedinPost } from "./linkedin";
import { slackPost } from "./slack";

/**
 * Real tool access for agents' Deliver step. Every function returns null when
 * the owner hasn't connected that provider (or its OAuth app isn't
 * configured), so callers can fall back to a clearly labelled simulation.
 */

export type Provider = "google" | "linkedin" | "slack";

export async function getConnection(userId: string, provider: Provider): Promise<(ConnectionDoc & { id: string }) | null> {
  const snap = await db().collection(COLLECTIONS.connections).doc(`${userId}_${provider}`).get();
  const c = snap.data() as ConnectionDoc | undefined;
  if (!c || c.status !== "active" || c.secretRef === "simulated") return null;
  return { ...c, id: snap.id };
}

export { gmailCreateDraft, sheetsAppendRow, linkedinPost, slackPost };

/** Shape every agent's deliver() returns. */
export interface Delivery extends Record<string, unknown> {
  simulated: boolean;
  /** Plain-English line for the task log and result view. */
  summary: string;
  links?: { label: string; url: string }[];
}

export function simulated(summary: string): Delivery {
  return { simulated: true, summary };
}
