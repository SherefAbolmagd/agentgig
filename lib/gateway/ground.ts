import "server-only";
import { db } from "@/lib/firebase-admin";
import { loadKnowledge } from "@/lib/knowledge";
import type { Grounding } from "@/lib/agents";
import { COLLECTIONS, type HireDoc, type StyleExampleDoc, type UserDoc } from "@/types/firestore";

const STYLE_EXAMPLES = 3;

/**
 * Builds the company knowledge an agent may see, limited to what the owner
 * ticked for this hire: the business profile, uploaded files, and the
 * owner's past edits to this agent's drafts.
 */
export async function buildGrounding(user: UserDoc, hire: HireDoc): Promise<Grounding> {
  const [examplesSnap, documents] = await Promise.all([
    db()
      .collection(COLLECTIONS.styleExamples)
      .where("userId", "==", hire.userId)
      .where("agentId", "==", hire.agentId)
      .limit(20)
      .get(),
    loadKnowledge(
      hire.userId,
      hire.knowledgeAccess.filter((id) => id !== "profile"),
    ),
  ]);
  // Sorted in memory to avoid a composite index for a handful of docs.
  const styleExamples = examplesSnap.docs
    .map((d) => d.data() as StyleExampleDoc)
    .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))
    .slice(0, STYLE_EXAMPLES)
    .map(({ draft, edited }) => ({ draft, edited }));

  return {
    businessName: user.businessName,
    profile: hire.knowledgeAccess.includes("profile") ? (user.businessProfile ?? null) : null,
    styleExamples,
    documents,
  };
}

export function describeGrounding(g: Grounding): string {
  const parts = [
    g.profile ? "business profile" : null,
    g.documents.length ? `${g.documents.length} company file${g.documents.length > 1 ? "s" : ""}` : null,
    g.styleExamples.length ? `${g.styleExamples.length} of your past edits` : null,
  ].filter(Boolean);
  return parts.length ? `Shared ${parts.join(", ")}` : "No company knowledge shared with this agent";
}
