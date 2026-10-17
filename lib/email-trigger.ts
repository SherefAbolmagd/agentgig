import "server-only";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { env } from "./env";
import { db } from "./firebase-admin";
import { log as writeLog } from "./log";
import { enqueue } from "./triggers";
import { gmailInboxSince, gmailLabelHandled, gmailRead, gmailWatch, type GmailMessage } from "./connectors/google";
import { getConnection } from "./connectors";
import { redactContact } from "./agents/enquiry-desk";
import { generateJson, textPart } from "./vertex";
import { COLLECTIONS, type ConnectionDoc, type HireDoc, type UserDoc } from "@/types/firestore";

/**
 * Agents that work on new emails. Gmail publishes inbox changes to Pub/Sub
 * (users.watch), which pushes to /api/triggers/gmail. Each new email is a
 * job: Ada reads it and hands it to the hired agent it belongs to, or to
 * nobody. The agent's draft then waits for the owner's OK like any other.
 */

export const EMAIL_EVENT = "gmail.message";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** What each email-triggered agent takes, and how Ada recognises its emails. */
const ROUTES: Record<string, { when: string; input: (m: GmailMessage, name: string | null) => Record<string, unknown> }> = {
  "order-desk": {
    when: "a customer asking about an order they placed: where it is, delivery, tracking, or changing it",
    input: (m) => ({ question: m.text.slice(0, 2000), customerEmail: m.fromEmail, email: reply(m) }),
  },
  "quote-builder": {
    when: "someone asking for prices or a quote, such as a wholesale, trade or bulk order",
    input: (m, name) => ({ enquiry: m.text.slice(0, 4000), customerEmail: m.fromEmail, ...(name && { customerName: name }), email: reply(m) }),
  },
};

const reply = (m: GmailMessage) => ({ threadId: m.threadId, messageId: m.messageId, subject: m.subject, fromName: m.fromName || m.fromEmail });

function log(message: string, fields: Record<string, unknown>, severity: "INFO" | "WARNING" | "ERROR" = "INFO") {
  void writeLog(severity, message, { component: "email", ...fields });
}

const topic = () => env().GMAIL_TOPIC ?? `projects/${env().GOOGLE_CLOUD_PROJECT}/topics/gmail-events`;

async function emailHires(userId: string): Promise<HireDoc[]> {
  const snap = await db().collection(COLLECTIONS.hires).where("userId", "==", userId).where("active", "==", true).where("trigger.event", "==", EMAIL_EVENT).get();
  return snap.docs.map((d) => d.data() as HireDoc).filter((h) => ROUTES[h.agentId]);
}

/**
 * Starts (or renews) Gmail's push for an owner who has an agent on the email
 * trigger. Keeps the history ID already processed, so a renewal skips nothing.
 */
export async function ensureGmailWatch(userId: string): Promise<"watching" | "no email agents" | "Google not connected" | "needs Gmail access"> {
  if (!(await emailHires(userId)).length) return "no email agents";
  const conn = await getConnection(userId, "google");
  if (!conn) return "Google not connected";
  if (!conn.scopes.includes(GMAIL_SCOPE)) return "needs Gmail access";
  const w = await gmailWatch(userId, topic());
  if (!w) return "Google not connected";
  const previous = conn.meta?.gmailWatch as { historyId?: string } | undefined;
  await db()
    .collection(COLLECTIONS.connections)
    .doc(conn.id)
    .update({ "meta.gmailWatch": { email: w.email, historyId: previous?.historyId ?? w.historyId, expiration: w.expiration } });
  log("email.watching", { userId, expiration: new Date(w.expiration).toISOString() });
  return "watching";
}

/** Daily: renews every owner's watch before Gmail's 7-day expiry. */
export async function renewGmailWatches() {
  const snap = await db().collection(COLLECTIONS.hires).where("active", "==", true).where("trigger.event", "==", EMAIL_EVENT).get();
  const users = [...new Set(snap.docs.map((d) => (d.data() as HireDoc).userId))];
  const results = await Promise.all(users.map((u) => ensureGmailWatch(u).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`)));
  return { owners: users.length, watching: results.filter((r) => r === "watching").length };
}

/** Pub/Sub push from Gmail: queues a job for each email that arrived since the last one handled. */
export async function onGmailPush(emailAddress: string, historyId: string): Promise<string> {
  const snap = await db().collection(COLLECTIONS.connections).where("meta.gmailWatch.email", "==", emailAddress.toLowerCase()).limit(5).get();
  let queued = 0;
  for (const doc of snap.docs) {
    const conn = doc.data() as ConnectionDoc;
    if (conn.provider !== "google" || conn.status !== "active") continue;
    const userId = conn.userId;
    const watch = conn.meta?.gmailWatch as { historyId: string };
    let since: Awaited<ReturnType<typeof gmailInboxSince>>;
    try {
      since = await gmailInboxSince(userId, watch.historyId);
    } catch (err) {
      // History older than about a week is gone; start again from now.
      if (!String(err).includes("404")) throw err;
      since = { messageIds: [], historyId };
    }
    if (!since) continue;
    for (const id of since.messageIds) {
      // Claim each email once, so overlapping pushes can't double-process it.
      try {
        await db().collection("gmail_seen").doc(`${userId}_${id}`).create({ userId, messageId: id, createdAt: FieldValue.serverTimestamp() });
      } catch {
        continue;
      }
      await enqueue({ key: `gmail-${userId}-${id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100), userId, agentId: "", input: {}, origin: "event", gmailMessageId: id });
      queued++;
    }
    await doc.ref.update({ "meta.gmailWatch.historyId": since.historyId });
  }
  if (queued) log("email.queued", { queued });
  return queued ? `queued ${queued}` : "nothing new";
}

const SKIP_LABELS = ["SENT", "DRAFT", "SPAM", "TRASH", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"];

/** One new email: Ada picks the agent it belongs to (or none), then that agent's task runs. */
export async function routeEmail(userId: string, messageId: string, key: string) {
  const hires = await emailHires(userId);
  if (!hires.length) return { status: "not run: no email agents" };
  const m = await gmailRead(userId, messageId);
  if (!m) return { status: "not run: Google not connected" };
  const self = (await getConnection(userId, "google"))?.meta?.gmailWatch as { email?: string } | undefined;
  if (m.labelIds.some((l) => SKIP_LABELS.includes(l)) || m.fromEmail === self?.email || /no-?reply|mailer-daemon|notifications?@/i.test(m.fromEmail) || !m.text) {
    log("email.skipped", { userId, messageId });
    return { status: "skipped" };
  }
  const user = (await db().collection(COLLECTIONS.users).doc(userId).get()).data() as UserDoc | undefined;
  const choices = hires.map((h) => h.agentId);
  const res = await generateJson({
    tier: "flash",
    system:
      "You sort a business's incoming email for its AI team. Pick the one agent whose job this email is, or \"none\" for anything else (newsletters, receipts, notifications, suppliers, spam, personal mail). Only pick an agent when the email clearly matches its job. Also give the sender's first name if they sign the email.",
    parts: [
      textPart(
        `Business: ${user?.businessName ?? "the business"}\n\nAgents:\n${choices.map((id) => `- ${id}: ${ROUTES[id].when}`).join("\n")}\n\nEmail subject: ${redactContact(m.subject).slice(0, 200)}\nEmail:\n"""${redactContact(m.text).slice(0, 1500)}"""`,
      ),
    ],
    schema: z.object({ agent: z.enum(["none", ...choices]), senderFirstName: z.string().nullable(), reason: z.string() }),
    temperature: 0,
    thinkingBudget: 0,
  });
  const { agent, senderFirstName, reason } = res.data;
  log("email.sorted", { userId, messageId, agent, reason });
  if (agent === "none") return { status: "not for an agent" };
  await gmailLabelHandled(userId, messageId).catch((err) => log("email.label_failed", { userId, error: String(err) }, "WARNING"));
  const name = m.fromName && !m.fromName.includes("@") ? m.fromName : senderFirstName;
  const { runTask } = await import("./gateway/pipeline");
  const task = await runTask({ userId, agentId: agent, rawInput: ROUTES[agent].input(m, name), files: [], origin: "event", idempotencyKey: key });
  return { status: `${agent}: ${task.status}` };
}
