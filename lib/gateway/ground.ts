import "server-only";
import { db } from "@/lib/firebase-admin";
import type { Grounding } from "@/lib/agents";
import { COLLECTIONS, type HireDoc, type StyleExampleDoc, type UserDoc } from "@/types/firestore";

const STYLE_EXAMPLES = 3;

/**
 * Builds the company knowledge an agent may see, limited to what the owner
 * ticked for this hire. Uploaded knowledge files join this in Milestone 2.
 */
export async function buildGrounding(user: UserDoc, hire: HireDoc): Promise<Grounding> {
  const snap = await db()
    .collection(COLLECTIONS.styleExamples)
    .where("userId", "==", hire.userId)
    .where("agentId", "==", hire.agentId)
    .limit(20)
    .get();
  // Sorted in memory to avoid a composite index for a handful of docs.
  const styleExamples = snap.docs
    .map((d) => d.data() as StyleExampleDoc)
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
    .slice(0, STYLE_EXAMPLES)
    .map(({ draft, edited }) => ({ draft, edited }));

  return {
    businessName: user.businessName,
    profile: hire.knowledgeAccess.includes("profile") ? (user.businessProfile ?? null) : null,
    styleExamples,
  };
}

export function describeGrounding(g: Grounding): string {
  const parts = [g.profile ? "business profile" : null, g.styleExamples.length ? `${g.styleExamples.length} style examples` : null].filter(Boolean);
  return parts.length ? `Attached ${parts.join(" and ")}` : "No company knowledge shared with this agent";
}
