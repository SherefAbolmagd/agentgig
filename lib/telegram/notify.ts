import "server-only";
import { NATIVE_AGENTS } from "@/lib/agents";
import { db } from "@/lib/firebase-admin";
import { log } from "@/lib/log";
import { hasRole } from "@/lib/org";
import { COLLECTIONS, type AgentDoc, type ApprovalDoc } from "@/types/firestore";
import { telegramEnabled, type InlineButton } from "./api";
import { linkedPeople } from "./link";
import { post } from "./supervisor";

/**
 * Tells the account's linked owners and managers that a draft is waiting,
 * with buttons. `exceptUid` is the person who asked for it from Telegram:
 * they already got the draft in their own chat.
 */
export async function notifyApproval(accountId: string, approvalId: string, exceptUid?: string) {
  if (!telegramEnabled()) return;
  try {
    const people = (await linkedPeople(accountId)).filter((p) => hasRole(p.role, "manager") && p.uid !== exceptUid);
    if (!people.length) return;
    const approval = (await db().collection(COLLECTIONS.approvals).doc(approvalId).get()).data() as ApprovalDoc | undefined;
    if (!approval || approval.userId !== accountId) return;
    const agent = (await db().collection(COLLECTIONS.agents).doc(approval.agentId).get()).data() as AgentDoc | undefined;
    const editable = !!NATIVE_AGENTS[approval.agentId]?.editableField;
    const buttons: InlineButton[][] = [[
      { text: "Approve", callback_data: `ap:${approvalId}:a` },
      ...(editable ? [{ text: "Edit", callback_data: `ap:${approvalId}:e` }] : []),
      { text: "Skip", callback_data: `ap:${approvalId}:s` },
    ]];
    await Promise.all(people.map((p) => post(p.link.chatId, agent?.name ?? approval.agentId, approval.title, buttons, approval.preview)));
  } catch (err) {
    log("WARNING", "telegram.notify_failed", { component: "telegram", error: String(err) });
  }
}
