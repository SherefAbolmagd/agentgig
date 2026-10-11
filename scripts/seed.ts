/**
 * Loads the agent catalogue and the demo account into Firestore.
 *
 *   npm run seed            upsert agents, create the demo user if missing
 *   npm run seed -- --reset also reset the demo user's balance and delete their
 *                           tasks, transactions and approvals
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { DEMO_USER, SEED_AGENTS } from "@/data/agents";
import { COLLECTIONS } from "@/types/firestore";

async function deleteWhere(store: Firestore, collection: string, uid: string) {
  const snap = await store.collection(collection).where("userId", "==", uid).get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = store.batch();
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return snap.size;
}

async function main() {
  // Imported after dotenv so lib/env sees .env.local.
  const { db } = await import("@/lib/firebase-admin");
  const store = db();
  const reset = process.argv.includes("--reset");

  const batch = store.batch();
  for (const agent of SEED_AGENTS) {
    batch.set(store.collection(COLLECTIONS.agents).doc(agent.slug), {
      ...agent,
      listedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  console.log(`✓ ${SEED_AGENTS.length} agents upserted`);

  const userRef = store.collection(COLLECTIONS.users).doc(DEMO_USER.uid);
  const exists = (await userRef.get()).exists;

  if (reset) {
    for (const c of [COLLECTIONS.tasks, COLLECTIONS.tokenTransactions, COLLECTIONS.approvals, COLLECTIONS.hires]) {
      const n = await deleteWhere(store, c, DEMO_USER.uid);
      console.log(`  deleted ${n} docs from ${c}`);
    }
  }

  if (!exists || reset) {
    await userRef.set({
      displayName: DEMO_USER.displayName,
      email: DEMO_USER.email,
      businessName: DEMO_USER.businessName,
      tokenBalance: DEMO_USER.startingTokens,
      tokensHeld: 0,
      tokensSpent: 0,
      businessProfile: DEMO_USER.businessProfile,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await store.collection(COLLECTIONS.tokenTransactions).add({
      userId: DEMO_USER.uid,
      type: "topup",
      amount: DEMO_USER.startingTokens,
      balanceAfter: DEMO_USER.startingTokens,
      description: "Demo starting balance",
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`✓ demo user ${DEMO_USER.uid} ${reset ? "reset" : "created"} with ${DEMO_USER.startingTokens} tokens`);
  } else {
    console.log(`• demo user ${DEMO_USER.uid} already exists (use --reset to start over)`);
  }

  // Demo hires: EchoSocial asks first, ReceiptHero acts on its own, so both
  // delivery paths can be exercised.
  for (const [slug, approvalMode] of [["echosocial", "ask"], ["receipthero", "auto"]] as const) {
    const agent = SEED_AGENTS.find((a) => a.slug === slug)!;
    await store
      .collection(COLLECTIONS.hires)
      .doc(`${DEMO_USER.uid}_${slug}`)
      .set({
        userId: DEMO_USER.uid,
        agentId: slug,
        trigger: agent.triggers.find((t) => t.type === "manual"),
        approvalMode,
        connectionIds: [],
        knowledgeAccess: ["profile"],
        monthlyCapTokens: null,
        active: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
  }
  console.log("✓ demo hires: echosocial (asks first), receipthero (acts on its own)");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("Seed failed:", err.message ?? err);
    process.exit(1);
  },
);
