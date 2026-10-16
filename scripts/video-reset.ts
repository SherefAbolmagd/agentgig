/**
 * Puts the demo-video account back to the moment the video starts, so every
 * take begins the same. It only touches the video account (uid
 * video-cafe-lumen), never the judges' or anyone else's.
 *
 * Kept between takes: the sign-in, the Google connection and Sam's Telegram
 * link. Cleared: tasks, ledger, approvals, hires, memory, uploaded files,
 * teammates, invites and the Telegram chat history.
 *
 *   npm run video:reset                       (the first run prints the password)
 *   VIDEO_PASSWORD=... npm run video:reset    sets a password of your choice
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { randomBytes } from "node:crypto";

export const VIDEO = {
  uid: "video-cafe-lumen",
  email: "video@agentgig.si",
  startingTokens: 480,
} as const;

/** The team Sam already has when the video starts; Quote Builder is hired on camera. */
const TEAM: { agentId: string; triggerId: string; approvalMode: "ask" | "auto" }[] = [
  { agentId: "receipthero", triggerId: "inbox", approvalMode: "ask" },
  { agentId: "vat-reconciler", triggerId: "manual", approvalMode: "auto" },
  { agentId: "reviewpulse", triggerId: "manual", approvalMode: "ask" },
  { agentId: "echosocial", triggerId: "manual", approvalMode: "ask" },
  { agentId: "invoice-chaser", triggerId: "manual", approvalMode: "ask" },
  { agentId: "rotabuilder", triggerId: "manual", approvalMode: "ask" },
];

const CLEARED = ["tasks", "token_transactions", "approvals", "hires", "knowledge_sources", "style_examples", "invoice_keys", "memory"] as const;

export async function resetVideoAccount(): Promise<{ password?: string }> {
  const { FieldValue } = await import("firebase-admin/firestore");
  const { Storage } = await import("@google-cloud/storage");
  const { adminAuth, db } = await import("@/lib/firebase-admin");
  const { env } = await import("@/lib/env");
  const { hireAgent } = await import("@/lib/hires");
  const { forgetAccountMemory, queueBankSync } = await import("@/lib/memory");
  const { deleteMemberships } = await import("@/lib/org");
  const { seedDemoMemory } = await import("@/lib/users");
  const { DEMO_USER } = await import("@/data/agents");
  const { COLLECTIONS } = await import("@/types/firestore");
  const store = db();
  const uid = VIDEO.uid;

  // Memory Bank copies first, while the memory docs still list them.
  await forgetAccountMemory(uid);
  await deleteMemberships(uid);
  await store.recursiveDelete(store.collection(COLLECTIONS.telegramChats).doc(`${uid}_${uid}`));
  await store.collection(COLLECTIONS.telegramLinks).doc(uid).update({ pendingEdit: null }).catch(() => undefined);
  for (const name of CLEARED) {
    for (;;) {
      const snap = await store.collection(name).where("userId", "==", uid).limit(400).get();
      if (snap.empty) break;
      const batch = store.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  const storage = new Storage({ projectId: env().GOOGLE_CLOUD_PROJECT });
  for (const [bucket, prefix] of [
    [env().KNOWLEDGE_BUCKET, `users/${uid}/`],
    [env().INBOX_BUCKET, `${uid}/`],
  ] as const) {
    if (!bucket) continue;
    const [objects] = await storage.bucket(bucket).getFiles({ prefix });
    await Promise.all(objects.map((o) => o.delete({ ignoreNotFound: true })));
  }

  // The sign-in: created once, then only its password changes if asked.
  let password: string | undefined;
  try {
    await adminAuth().getUser(uid);
    if (process.env.VIDEO_PASSWORD) {
      password = process.env.VIDEO_PASSWORD;
      await adminAuth().updateUser(uid, { password });
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
    password = process.env.VIDEO_PASSWORD ?? randomBytes(9).toString("base64url");
    await adminAuth().createUser({ uid, email: VIDEO.email, password, displayName: DEMO_USER.displayName, emailVerified: true });
  }

  const userRef = store.collection(COLLECTIONS.users).doc(uid);
  const existing = await userRef.get();
  await userRef.set({
    displayName: DEMO_USER.displayName,
    email: VIDEO.email,
    businessName: "Café Lumen",
    tokenBalance: VIDEO.startingTokens,
    tokensHeld: 0,
    tokensSpent: 0,
    businessProfile: DEMO_USER.businessProfile,
    // Not a sandbox: the daily cleanup must leave it alone.
    isDemo: false,
    createdAt: existing.exists ? existing.get("createdAt") : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await store.collection(COLLECTIONS.tokenTransactions).add({
    userId: uid,
    type: "topup",
    amount: VIDEO.startingTokens,
    balanceAfter: VIDEO.startingTokens,
    description: "Token pack",
    createdAt: FieldValue.serverTimestamp(),
  });
  for (const h of TEAM) await hireAgent(uid, { ...h, knowledgeAccess: ["profile"] });
  await seedDemoMemory(uid);
  await queueBankSync(uid);
  return { password };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/video-reset.ts")) {
  resetVideoAccount()
    .then(({ password }) => {
      console.log(`✓ ${VIDEO.email} is ready for a take: ${VIDEO.startingTokens} tokens, ${TEAM.length} agents hired, memory seeded.`);
      if (password) console.log(`  Password: ${password}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
