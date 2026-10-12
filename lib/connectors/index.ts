import "server-only";
import { db } from "@/lib/firebase-admin";
import { COLLECTIONS, type ConnectionDoc } from "@/types/firestore";
import { gmailCreateDraft, sheetsAppendRow } from "./google";
import { linkedinPost } from "./linkedin";
import { slackPost } from "./slack";

/**
 * Real tool access for agents' Deliver step. Every function returns null when
 * the owner hasn't connected that provider, and the agent then reports its
 * result as ready but not sent. Nothing is ever faked.
 */

export type { Provider } from "@/lib/integrations";
import type { Provider } from "@/lib/integrations";

export async function getConnection(userId: string, provider: Provider): Promise<(ConnectionDoc & { id: string }) | null> {
  const snap = await db().collection(COLLECTIONS.connections).doc(`${userId}_${provider}`).get();
  const c = snap.data() as ConnectionDoc | undefined;
  // "simulated" only exists on records from before demo connections were removed.
  if (!c || c.status !== "active" || c.secretRef === "simulated") return null;
  return { ...c, id: snap.id };
}

export { gmailCreateDraft, sheetsAppendRow, linkedinPost, slackPost };

/** Shape every agent's deliver() returns. */
export interface Delivery extends Record<string, unknown> {
  /** True only when the action really happened in the owner's tool. */
  delivered: boolean;
  /** Plain-English line for the task log and result view. */
  summary: string;
  links?: { label: string; url: string }[];
}

export function notDelivered(summary: string): Delivery {
  return { delivered: false, summary };
}
