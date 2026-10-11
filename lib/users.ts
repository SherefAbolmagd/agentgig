import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { DEMO_USER } from "@/data/agents";
import { db } from "./firebase-admin";
import { hireAgent } from "./hires";
import { COLLECTIONS, type UserDoc } from "@/types/firestore";

export const WELCOME_TOKENS = 100;

export interface Caller {
  uid: string;
  email?: string;
  name?: string;
  isAnonymous: boolean;
}

/**
 * Creates the user's account on first sign-in. Anonymous visitors ("Try the
 * demo") get a private copy of the Café Lumen sandbox: its balance, business
 * profile and two hired agents. Everyone else starts with welcome tokens and
 * an empty team.
 */
export async function ensureUser(caller: Caller): Promise<{ user: UserDoc; created: boolean }> {
  const ref = db().collection(COLLECTIONS.users).doc(caller.uid);
  const demo = caller.isAnonymous;
  const tokens = demo ? DEMO_USER.startingTokens : WELCOME_TOKENS;

  const created = await db().runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return false;
    tx.set(ref, {
      displayName: demo ? DEMO_USER.displayName : (caller.name ?? caller.email?.split("@")[0] ?? "there"),
      email: demo ? "" : (caller.email ?? ""),
      businessName: demo ? DEMO_USER.businessName : "My business",
      tokenBalance: tokens,
      tokensHeld: 0,
      tokensSpent: 0,
      ...(demo && { businessProfile: DEMO_USER.businessProfile }),
      isDemo: demo,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db().collection(COLLECTIONS.tokenTransactions).doc(), {
      userId: caller.uid,
      type: "topup",
      amount: tokens,
      balanceAfter: tokens,
      description: demo ? "Demo starting balance" : "Welcome tokens",
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  });

  if (created && demo) {
    await hireAgent(caller.uid, { agentId: "echosocial", triggerId: "manual", approvalMode: "ask", knowledgeAccess: ["profile"] });
    await hireAgent(caller.uid, { agentId: "receipthero", triggerId: "manual", approvalMode: "auto", knowledgeAccess: ["profile"] });
  }
  return { user: (await ref.get()).data() as UserDoc, created };
}
