import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "./firebase-admin";
import { GatewayError } from "./errors";
import { COLLECTIONS, type AgentDoc, type HireDoc } from "@/types/firestore";
import { providerForTool } from "./connectors/manage";

export const HireRequest = z.object({
  agentId: z.string().regex(/^[a-z0-9-]{2,64}$/),
  triggerId: z.string().min(1),
  approvalMode: z.enum(["ask", "auto"]),
  /** "profile" and/or knowledge_sources IDs. */
  knowledgeAccess: z.array(z.string().min(1)).max(50).default(["profile"]),
  /** Monthly token limit for this agent; null removes it, omitted keeps the current one. */
  monthlyCapTokens: z.number().int().min(1).max(100_000).nullable().optional(),
});
export type HireRequest = z.infer<typeof HireRequest>;

/**
 * Hires (or re-configures) an agent for a user. Connecting the agent's tools
 * is separate (Company knowledge → Connections, or the hire wizard); an agent
 * whose tools aren't connected still works; its results are marked "not sent".
 */
export async function hireAgent(userId: string, req: HireRequest): Promise<HireDoc> {
  const store = db();
  const agentSnap = await store.collection(COLLECTIONS.agents).doc(req.agentId).get();
  if (!agentSnap.exists) throw new GatewayError("AGENT_NOT_FOUND", `There is no agent called “${req.agentId}”.`);
  const agent = agentSnap.data() as AgentDoc;
  if (agent.status !== "listed") throw new GatewayError("AGENT_UNAVAILABLE", `${agent.name} isn't available right now.`);
  if (agent.source === "a2a" && !agent.endpointUrl) {
    throw new GatewayError("AGENT_UNAVAILABLE", `${agent.name} is a preview listing. You can hire it once its developer connects it.`);
  }
  const trigger = agent.triggers.find((t) => t.id === req.triggerId);
  if (!trigger) throw new GatewayError("INVALID_INPUT", "Choose when this agent should work.");

  const knowledgeAccess = await allowedKnowledge(userId, req.knowledgeAccess);
  const hireRef = store.collection(COLLECTIONS.hires).doc(`${userId}_${agent.slug}`);

  return store.runTransaction(async (tx) => {
    const existing = await tx.get(hireRef);
    const connectionIds = [...new Set(agent.tools.map(providerForTool).filter(Boolean))].map((p) => `${userId}_${p}`);
    const hire = {
      userId,
      agentId: agent.slug,
      trigger,
      approvalMode: req.approvalMode,
      connectionIds,
      knowledgeAccess,
      monthlyCapTokens: req.monthlyCapTokens !== undefined ? req.monthlyCapTokens : ((existing.data() as HireDoc | undefined)?.monthlyCapTokens ?? null),
      active: true,
      updatedAt: FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    };
    tx.set(hireRef, hire, { merge: true });
    return hire as unknown as HireDoc;
  });
}

export async function releaseAgent(userId: string, agentId: string): Promise<void> {
  const ref = db().collection(COLLECTIONS.hires).doc(`${userId}_${agentId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new GatewayError("NOT_HIRED", "That agent isn't on your team.");
  await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
}

/** Keeps only "profile" and knowledge sources this user actually owns. */
async function allowedKnowledge(userId: string, ids: string[]): Promise<string[]> {
  const fileIds = [...new Set(ids.filter((id) => id !== "profile"))];
  const snaps = fileIds.length
    ? await db().getAll(...fileIds.map((id) => db().collection(COLLECTIONS.knowledgeSources).doc(id)))
    : [];
  const owned = snaps.filter((s) => s.exists && s.get("userId") === userId).map((s) => s.id);
  return [...(ids.includes("profile") ? ["profile"] : []), ...owned];
}
