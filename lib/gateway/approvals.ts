import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { NATIVE_AGENTS } from "@/lib/agents";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { COLLECTIONS, type ApprovalDoc, type TaskDoc } from "@/types/firestore";

export const ApprovalDecision = z.object({
  action: z.enum(["approve", "skip"]),
  /** Owner's edited post text (EchoSocial). Saved as a style example. */
  editedText: z.string().trim().min(1).max(3000).optional(),
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

  let output = task.output ?? {};
  const original = typeof output.text === "string" ? output.text : null;
  if (decision.editedText && original !== null && decision.editedText !== original) {
    output = { ...output, text: decision.editedText, characterCount: decision.editedText.length, editedByOwner: true };
    await store.collection(COLLECTIONS.styleExamples).add({
      userId,
      agentId: task.agentId,
      draft: original,
      edited: decision.editedText,
      createdAt: FieldValue.serverTimestamp(),
    });
    await approvalRef.update({ editedOutput: output });
  }

  const handler = NATIVE_AGENTS[task.agentId];
  if (!handler) throw new GatewayError("AGENT_UNAVAILABLE", "This agent can't deliver results yet.");
  const delivery = await handler.deliver(output, { userId, taskId: approval.taskId });
  await taskRef.update({ status: "delivered", output, delivery, updatedAt: FieldValue.serverTimestamp() });
  await log(`You approved${output.editedByOwner ? " your edited version" : ""} · delivered${delivery.simulated ? " (simulated)" : ""}`);
  return { status: "delivered" as const, delivery };
}
