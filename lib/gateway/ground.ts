import "server-only";
import { db } from "@/lib/firebase-admin";
import { loadKnowledge } from "@/lib/knowledge";
import { recall } from "@/lib/memory";
import { SHELF_INFO } from "@/lib/shelves";
import type { Grounding } from "@/lib/agents";
import { COLLECTIONS, type AgentDoc, type HireDoc, type StyleExampleDoc, type UserDoc } from "@/types/firestore";

const STYLE_EXAMPLES = 3;

/**
 * Builds the company knowledge an agent may see, limited to what the owner
 * ticked for this hire: the business profile, uploaded files, the owner's
 * past edits to this agent's drafts, and company memory from the shelves it
 * may read. `query` (the task) picks the most relevant facts.
 */
export async function buildGrounding(user: UserDoc, hire: HireDoc, agent: AgentDoc, query: string): Promise<Grounding> {
  const [examplesSnap, documents, memory] = await Promise.all([
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
    recall(user, hire, agent, query),
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
    memory: memory.map(({ shelf, fact }) => ({ shelf, fact })),
  };
}

export function describeGrounding(g: Grounding): string {
  const shelves = [...new Set(g.memory.map((m) => SHELF_INFO[m.shelf].label))].join(", ");
  const parts = [
    g.profile ? "business profile" : null,
    g.documents.length ? `${g.documents.length} company file${g.documents.length > 1 ? "s" : ""}` : null,
    g.styleExamples.length ? `${g.styleExamples.length} of your past edits` : null,
    g.memory.length ? `${g.memory.length} fact${g.memory.length > 1 ? "s" : ""} from company memory (${shelves})` : null,
  ].filter(Boolean);
  return parts.length ? `Shared ${parts.join(", ")}` : "No company knowledge shared with this agent";
}
