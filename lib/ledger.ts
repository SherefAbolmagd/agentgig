import "server-only";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { db } from "./firebase-admin";
import { GatewayError } from "./errors";
import { COLLECTIONS, type HireDoc, type TaskDoc, type TokenTransactionDoc, type UserDoc } from "@/types/firestore";

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
const hires = () => db().collection(COLLECTIONS.hires);

/** Calendar month (UTC) that monthly spending caps count against, e.g. "2026-10". */
export function spendPeriod(at = new Date()): string {
  return at.toISOString().slice(0, 7);
}

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

  return ledgerTransaction(async (tx) => {
    const hireRef = req.hireId ? hires().doc(req.hireId) : null;
    const [userSnap, existing, hireSnap] = await Promise.all([
      tx.get(users().doc(req.userId)),
      tx.get(taskRef),
      hireRef ? tx.get(hireRef) : Promise.resolve(null),
    ]);
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

    // Monthly spending cap for this agent, counted in the same transaction.
    const hire = hireSnap?.data() as HireDoc | undefined;
    const period = spendPeriod();
    const spent = hire?.spend?.period === period ? hire.spend.tokens : 0;
    if (hire && hire.monthlyCapTokens != null && spent + req.cost > hire.monthlyCapTokens) {
      throw new GatewayError(
        "CAP_REACHED",
        `${req.agentName} has used ${spent} of its ${hire.monthlyCapTokens}-token monthly limit. Raise the limit in its settings to keep it working.`,
        { spent, cap: hire.monthlyCapTokens },
      );
    }
    if (hireRef && hire) tx.update(hireRef, { spend: { period, tokens: spent + req.cost } });

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
      spendPeriod: period,
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
  return ledgerTransaction(async (tx) => {
    const taskSnap = await tx.get(tasks().doc(taskId));
    if (!taskSnap.exists) throw new GatewayError("TASK_NOT_FOUND", `Task ${taskId} does not exist.`);
    const task = taskSnap.data() as TaskDoc;
    const userRef = users().doc(task.userId);
    const hireRef = task.hireId ? hires().doc(task.hireId) : null;
    const [userSnap, hireSnap] = await Promise.all([tx.get(userRef), hireRef ? tx.get(hireRef) : Promise.resolve(null)]);
    const user = userSnap.data() as UserDoc;

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
    // A released task no longer counts towards the agent's monthly cap.
    const hire = hireSnap?.data() as HireDoc | undefined;
    if (!charge && hireRef && hire?.spend && hire.spend.period === task.spendPeriod) {
      tx.update(hireRef, { "spend.tokens": Math.max(0, hire.spend.tokens - task.cost) });
    }
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
/**
 * Adds purchased tokens. With `idempotencyId` (e.g. a Stripe Checkout
 * Session ID) the same payment can be applied any number of times and
 * credits once: the ledger row's ID is the payment ID.
 */
export async function topUp(userId: string, amount: number, description: string, idempotencyId?: string): Promise<{ balance: number }> {
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10_000) {
    throw new GatewayError("INVALID_INPUT", "Top-up must be between 1 and 10,000 tokens.");
  }
  return ledgerTransaction(async (tx) => {
    const ref = users().doc(userId);
    const rowRef = idempotencyId ? txns().doc(idempotencyId) : null;
    const [snap, row] = await Promise.all([tx.get(ref), rowRef ? tx.get(rowRef) : Promise.resolve(null)]);
    if (!snap.exists) throw new GatewayError("USER_NOT_FOUND", "We couldn't find your account.");
    const balance = (snap.data() as UserDoc).tokenBalance;
    if (row?.exists) return { balance };
    const balanceAfter = balance + amount;
    tx.update(ref, { tokenBalance: FieldValue.increment(amount), updatedAt: FieldValue.serverTimestamp() });
    const data = { userId, type: "topup" as const, amount, balanceAfter, description, createdAt: FieldValue.serverTimestamp() };
    if (rowRef) tx.set(rowRef, data);
    else writeTxn(tx, { userId, type: "topup", amount, balanceAfter, description });
    return { balance: balanceAfter };
  });
}

/**
 * Every ledger change touches the user's doc, so simultaneous tasks for one
 * user contend. Allow more retries than Firestore's default 5, then report
 * "busy" instead of a generic failure. Nothing is written when it gives up.
 */
async function ledgerTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    return await db().runTransaction(fn, { maxAttempts: 12 });
  } catch (err) {
    if ((err as { code?: number }).code === 10 /* gRPC ABORTED */) {
      throw new GatewayError("BUSY", "Your account is handling a lot of tasks at once. Try again in a moment.");
    }
    throw err;
  }
}

function writeTxn(tx: Transaction, row: Omit<TokenTransactionDoc, "createdAt">) {
  tx.set(txns().doc(), { ...row, createdAt: FieldValue.serverTimestamp() });
}
