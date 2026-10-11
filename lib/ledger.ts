import "server-only";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { db } from "./firebase-admin";
import { GatewayError } from "./errors";
import { COLLECTIONS, type TaskDoc, type TokenTransactionDoc, type UserDoc } from "@/types/firestore";

/**
 * The token ledger. Tokens move in two steps so that neither failures nor
 * concurrent tasks can cost the owner money they shouldn't spend:
 *
 *   reserveTokens  balance → held      (before the agent runs)
 *   settleTask     held → spent        (agent produced output: "charge")
 *                  held → balance      (agent failed: "release")
 *
 * Every movement writes an append-only token_transactions row in the same
 * Firestore transaction, so the ledger always adds up to the balance.
 */

const users = () => db().collection(COLLECTIONS.users);
const tasks = () => db().collection(COLLECTIONS.tasks);
const txns = () => db().collection(COLLECTIONS.tokenTransactions);

export interface ReserveRequest {
  userId: string;
  agentId: string;
  agentName: string;
  skillId: string;
  cost: number;
  hireId: string | null;
  origin: TaskDoc["origin"];
  /** Stored on the task; must already be scrubbed or free of personal data. */
  input: Record<string, unknown>;
  /** Pass the same key to make a retried request reuse its first task. */
  idempotencyKey?: string;
}

/**
 * Holds `cost` tokens and creates the task in status "reserved".
 * Throws INSUFFICIENT_TOKENS without changing anything if the balance is too low.
 */
export async function reserveTokens(req: ReserveRequest): Promise<{ taskId: string; balance: number; reused: boolean }> {
  if (!Number.isInteger(req.cost) || req.cost <= 0) {
    throw new GatewayError("INVALID_INPUT", `Task cost must be a positive whole number, got ${req.cost}.`);
  }
  const taskRef = req.idempotencyKey ? tasks().doc(`${req.userId}_${req.idempotencyKey}`) : tasks().doc();

  return db().runTransaction(async (tx) => {
    const [userSnap, existing] = await Promise.all([tx.get(users().doc(req.userId)), tx.get(taskRef)]);
    if (!userSnap.exists) throw new GatewayError("USER_NOT_FOUND", "We couldn't find your account.");
    const user = userSnap.data() as UserDoc;

    if (existing.exists) return { taskId: taskRef.id, balance: user.tokenBalance, reused: true };

    if (user.tokenBalance < req.cost) {
      throw new GatewayError(
        "INSUFFICIENT_TOKENS",
        `${req.agentName} needs ${req.cost} tokens and you have ${user.tokenBalance}. Top up to keep your team working.`,
        { needed: req.cost, balance: user.tokenBalance },
      );
    }

    const balanceAfter = user.tokenBalance - req.cost;
    tx.update(users().doc(req.userId), {
      tokenBalance: FieldValue.increment(-req.cost),
      tokensHeld: FieldValue.increment(req.cost),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(taskRef, {
      userId: req.userId,
      agentId: req.agentId,
      hireId: req.hireId,
      skillId: req.skillId,
      origin: req.origin,
      status: "reserved",
      cost: req.cost,
      input: req.input,
      dlpFindings: [],
      steps: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    writeTxn(tx, {
      userId: req.userId,
      type: "hold",
      amount: -req.cost,
      balanceAfter,
      description: `Held for ${req.agentName}`,
      taskId: taskRef.id,
      agentId: req.agentId,
    });
    return { taskId: taskRef.id, balance: balanceAfter, reused: false };
  });
}

/**
 * Settles a reserved task's held tokens. Safe to call twice: the second call
 * returns the current balance without moving tokens.
 */
export async function settleTask(
  taskId: string,
  outcome: "charge" | "release",
  description: string,
): Promise<{ balance: number }> {
  return db().runTransaction(async (tx) => {
    const taskSnap = await tx.get(tasks().doc(taskId));
    if (!taskSnap.exists) throw new GatewayError("TASK_NOT_FOUND", `Task ${taskId} does not exist.`);
    const task = taskSnap.data() as TaskDoc;
    const userRef = users().doc(task.userId);
    const user = (await tx.get(userRef)).data() as UserDoc;

    if (task.settlement) return { balance: user.tokenBalance };

    const charge = outcome === "charge";
    const balanceAfter = charge ? user.tokenBalance : user.tokenBalance + task.cost;
    tx.update(userRef, {
      tokensHeld: FieldValue.increment(-task.cost),
      ...(charge
        ? { tokensSpent: FieldValue.increment(task.cost) }
        : { tokenBalance: FieldValue.increment(task.cost) }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(taskSnap.ref, {
      settlement: charge ? "charged" : "released",
      updatedAt: FieldValue.serverTimestamp(),
    });
    writeTxn(tx, {
      userId: task.userId,
      type: outcome,
      amount: charge ? 0 : task.cost,
      balanceAfter,
      description,
      taskId,
      agentId: task.agentId,
    });
    return { balance: balanceAfter };
  });
}

/** Adds purchased tokens. Payment is simulated for the hackathon. */
export async function topUp(userId: string, amount: number, description: string): Promise<{ balance: number }> {
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10_000) {
    throw new GatewayError("INVALID_INPUT", "Top-up must be between 1 and 10,000 tokens.");
  }
  return db().runTransaction(async (tx) => {
    const ref = users().doc(userId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new GatewayError("USER_NOT_FOUND", "We couldn't find your account.");
    const balanceAfter = (snap.data() as UserDoc).tokenBalance + amount;
    tx.update(ref, { tokenBalance: FieldValue.increment(amount), updatedAt: FieldValue.serverTimestamp() });
    writeTxn(tx, { userId, type: "topup", amount, balanceAfter, description });
    return { balance: balanceAfter };
  });
}

function writeTxn(tx: Transaction, row: Omit<TokenTransactionDoc, "createdAt">) {
  tx.set(txns().doc(), { ...row, createdAt: FieldValue.serverTimestamp() });
}
