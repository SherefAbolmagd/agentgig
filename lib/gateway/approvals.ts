import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { NATIVE_AGENTS } from "@/lib/agents";
import { partnerAgent } from "@/lib/agents/partner";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { queueRemember } from "./pipeline";
import { COLLECTIONS, type AgentDoc, type ApprovalDoc, type TaskDoc } from "@/types/firestore";

export const ApprovalDecision = z.object({
  action: z.enum(["approve", "skip"]),
  /** Owner's edited text for the agent's editable field. Saved as a style example. */
  editedText: z.string().trim().min(1).max(3000).optional(),
  /** Publish now instead of at the suggested time (EchoSocial). */
  postNow: z.boolean().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/**
 * Resolves an approval. Approving runs only the delivery half of the
 * pipeline; tokens were charged when the draft was made, so it costs nothing
 * extra. Edits are kept as style examples the agent sees next time.
 */
export async function resolveApproval(userId: string, approvalId: string, decision: ApprovalDecision) {
  const store = db();
  const approvalRef = store.collection(COLLECTIONS.approvals).doc(approvalId);

  // Claim the approval first so a double click can't deliver twice.
  const approval = await store.runTransaction(async (tx) => {
    const snap = await tx.get(approvalRef);
    const a = snap.data() as ApprovalDoc | undefined;
    if (!a || a.userId !== userId) throw new GatewayError("TASK_NOT_FOUND", "That approval doesn't exist.");
    if (a.status !== "open") throw new GatewayError("ALREADY_SETTLED", "This has already been decided.");
    tx.update(approvalRef, {
      status: decision.action === "approve" ? "approved" : "skipped",
      resolvedAt: FieldValue.serverTimestamp(),
    });
    return a;
  });

  const taskRef = store.collection(COLLECTIONS.tasks).doc(approval.taskId);
  const task = (await taskRef.get()).data() as TaskDoc;
  const log = (message: string) =>
    taskRef.update({
      steps: FieldValue.arrayUnion({ step: "deliver", status: "ok", message, at: Timestamp.now() }),
      updatedAt: FieldValue.serverTimestamp(),
    });

  if (decision.action === "skip") {
    await taskRef.update({ status: "discarded", updatedAt: FieldValue.serverTimestamp() });
    await log("You skipped this draft. Nothing was sent.");
    return { status: "discarded" as const };
  }

  const agentDoc = (await store.collection(COLLECTIONS.agents).doc(task.agentId).get()).data() as AgentDoc | undefined;
  const handler = NATIVE_AGENTS[task.agentId] ?? (agentDoc?.endpointUrl ? partnerAgent(agentDoc) : undefined);
  if (!handler) throw new GatewayError("AGENT_UNAVAILABLE", "This agent can't deliver results yet.");

  let output = task.output ?? {};
  const field = handler.editableField;
  const original = field && typeof output[field] === "string" ? (output[field] as string) : null;
  if (field && decision.editedText && original !== null && decision.editedText !== original) {
    output = {
      ...output,
      [field]: decision.editedText,
      ...(field === "text" && { characterCount: decision.editedText.length }),
      editedByOwner: true,
    };
    await store.collection(COLLECTIONS.styleExamples).add({
      userId,
      agentId: task.agentId,
      draft: original,
      edited: decision.editedText,
      createdAt: FieldValue.serverTimestamp(),
    });
    await approvalRef.update({ editedOutput: output });
  }
  if (decision.postNow && typeof output.scheduledFor === "string") output = { ...output, scheduledFor: new Date().toISOString() };

  let delivery;
  try {
    delivery = await handler.deliver(output, { userId, taskId: approval.taskId });
  } catch (err) {
    // Nothing was delivered: reopen the approval so the owner can fix the cause and approve again.
    await approvalRef.update({ status: "open", resolvedAt: null });
    throw err;
  }
  await taskRef.update({ status: "delivered", output, delivery, updatedAt: FieldValue.serverTimestamp() });
  await log(`You approved${output.editedByOwner ? " your edited version" : ""} · ${delivery.summary}`);
  await queueRemember(userId, task.agentId, approval.taskId);
  return { status: "delivered" as const, delivery };
}
