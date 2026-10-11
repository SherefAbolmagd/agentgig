import "server-only";
import { Storage } from "@google-cloud/storage";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, db } from "./firebase-admin";
import { env } from "./env";
import { log } from "./log";
import { settleTask } from "./ledger";
import { COLLECTIONS, type TaskDoc } from "@/types/firestore";

/** Collections holding per-user documents (all keyed by a `userId` field). */
const USER_COLLECTIONS = [
  COLLECTIONS.tasks,
  COLLECTIONS.tokenTransactions,
  COLLECTIONS.approvals,
  COLLECTIONS.hires,
  COLLECTIONS.connections,
  COLLECTIONS.knowledgeSources,
  COLLECTIONS.styleExamples,
  COLLECTIONS.invoiceKeys,
] as const;

/**
 * Permanently deletes a user's account: every Firestore document, uploaded
 * files, and the sign-in itself. Agents they registered as a developer are
 * suspended rather than deleted, so other owners' history stays readable.
 */
export async function deleteAccount(uid: string): Promise<{ documents: number; files: number }> {
  const store = db();
  let documents = 0;
  for (const name of USER_COLLECTIONS) {
    for (;;) {
      const snap = await store.collection(name).where("userId", "==", uid).limit(400).get();
      if (snap.empty) break;
      const batch = store.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      documents += snap.size;
    }
  }
  const owned = await store.collection(COLLECTIONS.agents).where("ownerUid", "==", uid).get();
  await Promise.all(owned.docs.map((d) => d.ref.update({ status: "suspended", ownerUid: FieldValue.delete() })));
  await store.collection(COLLECTIONS.users).doc(uid).delete();
  documents += 1;

  let files = 0;
  const storage = new Storage({ projectId: env().GOOGLE_CLOUD_PROJECT });
  for (const [bucket, prefix] of [
    [env().KNOWLEDGE_BUCKET, `users/${uid}/`],
    [env().INBOX_BUCKET, `${uid}/`],
  ] as const) {
    if (!bucket) continue;
    const [objects] = await storage.bucket(bucket).getFiles({ prefix });
    await Promise.all(objects.map((o) => o.delete({ ignoreNotFound: true })));
    files += objects.length;
  }

  await adminAuth()
    .deleteUser(uid)
    .catch((err) => {
      if (err?.code !== "auth/user-not-found") throw err;
    });
  log("INFO", "account.deleted", { component: "accounts", uidHash: uid.slice(0, 6), documents, files });
  return { documents, files };
}

const SANDBOX_TTL_DAYS = 7;

/** Deletes demo sandboxes older than a week. Runs daily from Cloud Scheduler. */
export async function cleanupSandboxes(now = new Date(), max = 200): Promise<{ deleted: number }> {
  const cutoff = Timestamp.fromMillis(now.getTime() - SANDBOX_TTL_DAYS * 86_400_000);
  const snap = await db().collection(COLLECTIONS.users).where("isDemo", "==", true).where("createdAt", "<", cutoff).limit(max).get();
  for (const d of snap.docs) await deleteAccount(d.id);
  log("INFO", "sandboxes.cleaned", { component: "accounts", deleted: snap.size });
  return { deleted: snap.size };
}

const STUCK_AFTER_MS = 15 * 60_000;

/**
 * Finds tasks stuck in "reserved" or "running" (for example the instance
 * running them was stopped) and returns their held tokens. Runs every 5 minutes.
 */
export async function releaseStuckTasks(now = new Date()): Promise<{ released: number }> {
  const cutoff = Timestamp.fromMillis(now.getTime() - STUCK_AFTER_MS);
  const snap = await db().collection(COLLECTIONS.tasks).where("status", "in", ["reserved", "running"]).where("updatedAt", "<", cutoff).limit(100).get();
  let released = 0;
  for (const d of snap.docs) {
    const task = d.data() as TaskDoc;
    if (!task.settlement) await settleTask(d.id, "release", "Refund: task didn't finish");
    await d.ref.update({
      status: "failed",
      error: { code: "AGENT_TIMEOUT", message: "This task didn't finish, so its tokens were returned." },
      steps: FieldValue.arrayUnion({ step: "run", status: "error", message: "Task stopped unexpectedly. Tokens returned.", at: Timestamp.now() }),
      finishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    released++;
  }
  if (released) log("WARNING", "tasks.released_stuck", { component: "accounts", released });
  return { released };
}
