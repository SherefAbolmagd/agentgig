/**
 * Integration checks for the operational code, against the Firestore database
 * in .env.local. It runs the sandbox cleanup and stuck-task jobs for real, so
 * it refuses the production database: set FIRESTORE_DATABASE_ID to a scratch
 * database to run it. Creates and removes its own users.
 *
 *   npm run test:ops
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import assert from "node:assert/strict";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS, type TaskDoc, type UserDoc } from "@/types/firestore";

async function main() {
  if (process.env.FIRESTORE_DATABASE_ID === "(default)") throw new Error("Refusing to run against the production database.");
  const { db } = await import("@/lib/firebase-admin");
  const { consume, LIMITS } = await import("@/lib/rate-limit");
  const { reserveTokens } = await import("@/lib/ledger");
  const { releaseStuckTasks, deleteAccount, cleanupSandboxes } = await import("@/lib/accounts");
  const { isGatewayError } = await import("@/lib/errors");
  const store = db();
  const stamp = Date.now();

  const makeUser = async (uid: string, extra: Record<string, unknown> = {}) => {
    await store.collection(COLLECTIONS.users).doc(uid).set({
      displayName: "Ops test", email: "", businessName: "Ops test", tokenBalance: 20, tokensHeld: 0, tokensSpent: 0,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), ...extra,
    });
  };

  // 1. Rate limit: the (limit + 1)th call in a window is refused.
  const subject = `ops-${stamp}`;
  const { limit } = LIMITS.registrationsPerUser;
  for (let i = 0; i < limit; i++) await consume("registrationsPerUser", subject);
  await assert.rejects(consume("registrationsPerUser", subject), (e) => isGatewayError(e) && e.code === "RATE_LIMITED");
  console.log(`✓ rate limit allows ${limit} then refuses`);

  // 2. Sweeper: a task stuck in "reserved" gets its tokens back and is marked failed.
  const stuckUid = `ops-stuck-${stamp}`;
  await makeUser(stuckUid);
  const { taskId } = await reserveTokens({ userId: stuckUid, agentId: "echosocial", agentName: "EchoSocial", skillId: "linkedin.post", cost: 5, hireId: null, origin: "manual", input: {} });
  await store.collection(COLLECTIONS.tasks).doc(taskId).update({ updatedAt: Timestamp.fromMillis(Date.now() - 20 * 60_000) });
  const { released } = await releaseStuckTasks();
  assert.ok(released >= 1, "sweeper released at least our task");
  const user = (await store.collection(COLLECTIONS.users).doc(stuckUid).get()).data() as UserDoc;
  const task = (await store.collection(COLLECTIONS.tasks).doc(taskId).get()).data() as TaskDoc;
  assert.equal(user.tokenBalance, 20);
  assert.equal(user.tokensHeld, 0);
  assert.equal(task.status, "failed");
  assert.equal(task.settlement, "released");
  console.log("✓ sweeper returns tokens held by a stuck task");

  // 3. Account deletion removes every document for the user.
  const n = await deleteAccount(stuckUid);
  for (const c of [COLLECTIONS.users, COLLECTIONS.tasks, COLLECTIONS.tokenTransactions]) {
    const left = c === COLLECTIONS.users
      ? Number((await store.collection(c).doc(stuckUid).get()).exists)
      : (await store.collection(c).where("userId", "==", stuckUid).get()).size;
    assert.equal(left, 0, `${c} emptied`);
  }
  console.log(`✓ account deletion removed ${n.documents} documents and left nothing behind`);

  // 4. Sandbox cleanup deletes demo users older than a week, and only those.
  const oldUid = `ops-old-${stamp}`;
  const newUid = `ops-new-${stamp}`;
  await makeUser(oldUid, { isDemo: true, createdAt: Timestamp.fromMillis(Date.now() - 8 * 86_400_000) });
  await makeUser(newUid, { isDemo: true });
  await cleanupSandboxes();
  assert.equal((await store.collection(COLLECTIONS.users).doc(oldUid).get()).exists, false, "old sandbox removed");
  assert.equal((await store.collection(COLLECTIONS.users).doc(newUid).get()).exists, true, "new sandbox kept");
  await deleteAccount(newUid);
  console.log("✓ sandbox cleanup removes week-old demos and keeps recent ones");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗", err.message ?? err);
    process.exit(1);
  },
);
