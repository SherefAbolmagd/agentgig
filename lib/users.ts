import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { DEMO_USER } from "@/data/agents";
import { db } from "./firebase-admin";
import { hireAgent } from "./hires";
import { bankEnabled } from "./memory/bank";
import { enqueue } from "./triggers";
import { COLLECTIONS, type MemoryDoc, type UserDoc } from "@/types/firestore";

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
    await hireAgent(caller.uid, { agentId: "receipthero", triggerId: "inbox", approvalMode: "auto", knowledgeAccess: ["profile"] });
    await seedDemoMemory(caller.uid);
    if (bankEnabled()) {
      // Moving the seeds into Memory Bank takes ~5 s a fact, so it happens off the sign-in path.
      await enqueue({ key: `memsync-${caller.uid}`.slice(0, 100), userId: caller.uid, agentId: "memory", input: {}, origin: "event", syncMemory: true });
    }
  }
  return { user: (await ref.get()).data() as UserDoc, created };
}

/** A few facts so the sandbox's Memory page and first tasks show sharing at work. */
async function seedDemoMemory(accountId: string, now = new Date()) {
  // Next Friday (or the one after, if today is Friday), in words and as an expiry.
  const friday = new Date(now);
  friday.setUTCDate(now.getUTCDate() + (((5 - now.getUTCDay() + 7) % 7) || 7));
  const fridayWords = friday.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  const agent = (agentId: string, agentName: string) => ({ kind: "agent" as const, agentId, agentName, taskId: "demo" });
  const facts: Pick<MemoryDoc, "shelf" | "fact" | "source" | "pinned" | "expiresAt">[] = [
    { shelf: "brand", fact: "This month's offer: a free tasting box for any new office that signs up.", source: { kind: "person", uid: accountId, name: DEMO_USER.displayName }, pinned: true },
    { shelf: "stock", fact: `Oat milk is short until ${fridayWords}, when Bridgewater Dairy delivers the next batch.`, source: agent("inventory-guardian", "Inventory Guardian"), expiresAt: Timestamp.fromDate(new Date(`${friday.toISOString().slice(0, 10)}T23:59:59Z`)) },
    { shelf: "brand", fact: "Posts with latte-art photos get about twice the likes of menu photos.", source: agent("echosocial", "EchoSocial") },
    { shelf: "customers", fact: "Northside Offices usually pays invoices about 3 weeks late.", source: agent("invoice-chaser", "Invoice Chaser") },
    { shelf: "money", fact: "Lumen Supplies invoices are due 30 days after delivery; pay them on the last Friday of the month.", source: agent("receipthero", "ReceiptHero") },
    { shelf: "team", fact: "Priya handles customer complaints; Jordan covers Monday deliveries.", source: { kind: "person", uid: accountId, name: DEMO_USER.displayName } },
  ];
  const batch = db().batch();
  for (const f of facts) {
    batch.set(db().collection(COLLECTIONS.memory).doc(), {
      userId: accountId,
      status: "saved",
      ...f,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}
