/**
 * Ledger stress test against real Firestore (no emulator needed).
 * Fires 20 one-token tasks at once at an account holding 10 tokens, then
 * settles them, and checks the balance can never go negative and the ledger
 * always adds up. Creates and deletes its own throwaway user.
 *
 *   npm run test:ledger
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import assert from "node:assert/strict";
import { FieldValue } from "firebase-admin/firestore";
import { COLLECTIONS, type TokenTransactionDoc, type UserDoc } from "@/types/firestore";

const START = 10;
const ATTEMPTS = 20;

async function main() {
  const { db } = await import("@/lib/firebase-admin");
  const { reserveTokens, settleTask, topUp } = await import("@/lib/ledger");
  const { isGatewayError } = await import("@/lib/errors");
  const store = db();
  const uid = `ledger-test-${Date.now()}`;
  const userRef = store.collection(COLLECTIONS.users).doc(uid);
  const read = async () => (await userRef.get()).data() as UserDoc;

  await userRef.set({
    displayName: "Ledger test",
    email: "ledger@test.invalid",
    businessName: "Ledger test",
    tokenBalance: 0,
    tokensHeld: 0,
    tokensSpent: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    await topUp(uid, START, "Test top-up");

    console.log(`Firing ${ATTEMPTS} concurrent 1-token reservations at a balance of ${START}…`);
    const results = await Promise.allSettled(
      Array.from({ length: ATTEMPTS }, (_, i) =>
        reserveTokens({
          userId: uid,
          agentId: "echosocial",
          agentName: "EchoSocial",
          skillId: "linkedin.post",
          cost: 1,
          hireId: null,
          origin: "manual",
          input: { i },
        }),
      ),
    );
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.taskId] : []));
    const rejected = results.filter((r) => r.status === "rejected" && isGatewayError(r.reason) && r.reason.code === "INSUFFICIENT_TOKENS");
    const other = results.filter((r) => r.status === "rejected" && !(isGatewayError(r.reason) && r.reason.code === "INSUFFICIENT_TOKENS"));
    console.log(`  reserved ${ok.length}, rejected for balance ${rejected.length}, other errors ${other.length}`);
    other.forEach((r) => r.status === "rejected" && console.log("   ", String(r.reason?.message ?? r.reason)));

    let u = await read();
    assert.equal(ok.length + rejected.length + other.length, ATTEMPTS);
    assert.ok(ok.length <= START, "never reserves more than the balance");
    assert.equal(u.tokenBalance, START - ok.length);
    assert.equal(u.tokensHeld, ok.length);
    assert.ok(u.tokenBalance >= 0);

    const half = Math.floor(ok.length / 2);
    await Promise.all(ok.map((id, i) => settleTask(id, i < half ? "charge" : "release", "test")));
    await Promise.all(ok.map((id) => settleTask(id, "charge", "double settle must be a no-op")));

    u = await read();
    assert.equal(u.tokensHeld, 0);
    assert.equal(u.tokensSpent, half);
    assert.equal(u.tokenBalance, START - half);

    const rows = (await store.collection(COLLECTIONS.tokenTransactions).where("userId", "==", uid).get()).docs.map(
      (d) => d.data() as TokenTransactionDoc,
    );
    const sum = rows.reduce((s, r) => s + r.amount, 0);
    assert.equal(sum, u.tokenBalance, "ledger rows add up to the balance");
    assert.equal(rows.filter((r) => r.type === "charge").length, half, "each task charged once");

    console.log(`✓ balance ${u.tokenBalance}, held ${u.tokensHeld}, spent ${u.tokensSpent}; ${rows.length} ledger rows sum to the balance`);
  } finally {
    const batch = store.batch();
    for (const c of [COLLECTIONS.tasks, COLLECTIONS.tokenTransactions]) {
      (await store.collection(c).where("userId", "==", uid).get()).docs.forEach((d) => batch.delete(d.ref));
    }
    batch.delete(userRef);
    await batch.commit();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗", err.message ?? err);
    process.exit(1);
  },
);
