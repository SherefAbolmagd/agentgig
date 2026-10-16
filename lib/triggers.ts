import "server-only";
import { CloudTasksClient } from "@google-cloud/tasks";
import { Storage } from "@google-cloud/storage";
import { CronExpressionParser } from "cron-parser";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { env } from "./env";
import { log as writeLog } from "./log";
import { db } from "./firebase-admin";
import { runTask } from "./gateway/pipeline";
import { rememberTask, syncToBank } from "./memory";
import { driveDownload, driveListInvoices } from "./connectors/google";
import { linkedinPost } from "./connectors/linkedin";
import { isGatewayError } from "./errors";
import { COLLECTIONS, type AgentDoc, type HireDoc, type TaskDoc, type UserDoc } from "@/types/firestore";

/**
 * Work that starts without a click. Schedules (Cloud Scheduler → /api/triggers/cron)
 * and invoice-inbox uploads (Cloud Storage → Pub/Sub → /api/triggers/inbox)
 * become jobs on a Cloud Tasks queue, which calls /api/tasks/run with
 * retries. Each job has a deterministic ID, so a duplicate event runs once.
 */

export interface Job {
  /** Deterministic; becomes the Cloud Task name and the task's idempotency key. */
  key: string;
  userId: string;
  agentId: string;
  input: Record<string, unknown>;
  origin: Extract<TaskDoc["origin"], "schedule" | "event">;
  /** gs:// object handed to the agent as its file (invoice inbox). */
  gcsFile?: { bucket: string; name: string; contentType: string };
  /** Google Drive file handed to the agent (Drive invoice folder). */
  driveFile?: { id: string; name: string; mimeType: string };
  /** Deliver an already-approved task at its scheduled time (LinkedIn posts). */
  publishTaskId?: string;
  /** Add what a delivered task learned to company memory. */
  rememberTaskId?: string;
  /** Copy the account's Firestore-only facts into Memory Bank (new sandboxes). */
  syncMemory?: true;
}

let tasksClient: CloudTasksClient | undefined;
let storage: Storage | undefined;
const gcs = () => (storage ??= new Storage({ projectId: env().GOOGLE_CLOUD_PROJECT }));

/** Queues a job on Cloud Tasks, or runs it inline in local dev. */
export async function enqueue(job: Job, runAt?: Date): Promise<"queued" | "duplicate" | "ran-inline"> {
  const { APP_URL, GOOGLE_CLOUD_PROJECT, TASKS_LOCATION, TASKS_QUEUE, TASKS_SERVICE_ACCOUNT } = env();
  if (!APP_URL || !TASKS_SERVICE_ACCOUNT) {
    void runJob(job).catch((err) => console.error("inline job failed", err));
    return "ran-inline";
  }
  tasksClient ??= new CloudTasksClient();
  const parent = tasksClient.queuePath(GOOGLE_CLOUD_PROJECT, TASKS_LOCATION, TASKS_QUEUE);
  try {
    await tasksClient.createTask({
      parent,
      task: {
        name: `${parent}/tasks/${job.key}`,
        ...(runAt && { scheduleTime: { seconds: Math.floor(runAt.getTime() / 1000) } }),
        httpRequest: {
          httpMethod: "POST",
          url: `${APP_URL}/api/tasks/run`,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(job)).toString("base64"),
          oidcToken: { serviceAccountEmail: TASKS_SERVICE_ACCOUNT, audience: APP_URL },
        },
      },
    });
    return "queued";
  } catch (err) {
    if ((err as { code?: number }).code === 6 /* ALREADY_EXISTS */) return "duplicate";
    throw err;
  }
}

/**
 * Runs a job through the normal gateway pipeline. Business outcomes (not
 * enough tokens, cap reached, agent failed) are final and recorded on the
 * task; only infrastructure errors are rethrown so Cloud Tasks retries.
 */
export async function runJob(job: Job): Promise<{ status: string }> {
  log("job.start", { key: job.key, agentId: job.agentId, origin: job.origin, file: job.gcsFile?.name ?? job.driveFile?.name });
  if (job.publishTaskId) return publishTask(job.publishTaskId, job.userId);
  if (job.rememberTaskId) return rememberJob(job.rememberTaskId);
  if (job.syncMemory) {
    const moved = await syncToBank(job.userId);
    log("job.memory_synced", { key: job.key, moved });
    return { status: `synced ${moved}` };
  }
  let files: { name: string; mimeType: string; data: Buffer }[] = [];
  if (job.driveFile) {
    const data = await driveDownload(job.userId, job.driveFile.id);
    if (!data) {
      log("job.file_missing", { key: job.key, driveFile: job.driveFile.id }, "WARNING");
      return { status: "not run: Drive file no longer available" };
    }
    files = [{ name: job.driveFile.name, mimeType: job.driveFile.mimeType, data }];
  }
  if (job.gcsFile) {
    try {
      files = [await downloadJobFile(job.gcsFile)];
    } catch (err) {
      // Gone for good (already processed, or expired): retrying can't help.
      if ((err as { code?: number }).code === 404) {
        log("job.file_missing", { key: job.key, file: job.gcsFile.name }, "WARNING");
        return { status: "not run: file no longer in the inbox" };
      }
      throw err;
    }
  }
  // The inbox file is removed only once the outcome is final, so retries still find it.
  const cleanup = async () => {
    if (job.gcsFile) await gcs().bucket(job.gcsFile.bucket).file(job.gcsFile.name).delete({ ignoreNotFound: true }).catch(() => undefined);
  };
  try {
    const res = await runTask({ userId: job.userId, agentId: job.agentId, rawInput: job.input, files, origin: job.origin, idempotencyKey: job.key });
    await cleanup();
    log("job.done", { key: job.key, status: res.status });
    return { status: res.status };
  } catch (err) {
    if (isGatewayError(err) && err.code !== "BUSY") {
      await cleanup();
      log("job.not_run", { key: job.key, code: err.code });
      return { status: `not run: ${err.code}` };
    }
    log("job.error", { key: job.key, error: err instanceof Error ? err.message : String(err) }, "ERROR");
    throw err;
  }
}

/** Memory is a bonus: a model or Memory Bank error is logged, not retried forever. */
async function rememberJob(taskId: string): Promise<{ status: string }> {
  try {
    const { saved, pending } = await rememberTask(taskId);
    log("job.remembered", { taskId, saved, pending });
    return { status: `remembered ${saved}, pending ${pending}` };
  } catch (err) {
    log("job.remember_failed", { taskId, error: err instanceof Error ? err.message : String(err) }, "WARNING");
    return { status: "not remembered" };
  }
}

function log(message: string, fields: Record<string, unknown>, severity: "INFO" | "WARNING" | "ERROR" = "INFO") {
  writeLog(severity, message, { component: "triggers", ...fields });
}

async function downloadJobFile(f: NonNullable<Job["gcsFile"]>) {
  const [data] = await gcs().bucket(f.bucket).file(f.name).download();
  return { name: f.name.split("/").pop()!.replace(/^[a-z0-9]+-/, ""), mimeType: f.contentType, data };
}

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

const LOOKBACK_MS = 6 * 3_600_000; // a missed tick (deploy, outage) still fires within 6 hours

/** Finds scheduled hires whose last cron time has passed since they last ran, and queues them. */
export async function queueDueSchedules(now = new Date()) {
  const store = db();
  const hires = await store.collection(COLLECTIONS.hires).where("active", "==", true).where("trigger.type", "==", "schedule").get();
  const results: { hire: string; outcome: string }[] = [];

  for (const doc of hires.docs) {
    const hire = doc.data() as HireDoc & { lastTriggeredAt?: Timestamp };
    if (!hire.trigger.cron) continue;
    const [userSnap, agentSnap] = await Promise.all([
      store.collection(COLLECTIONS.users).doc(hire.userId).get(),
      store.collection(COLLECTIONS.agents).doc(hire.agentId).get(),
    ]);
    const user = userSnap.data() as UserDoc | undefined;
    const agent = agentSnap.data() as AgentDoc | undefined;
    if (!user || !agent) continue;

    const tz = user.businessProfile?.timeZone ?? "Europe/London";
    const due = CronExpressionParser.parse(hire.trigger.cron, { currentDate: now, tz }).prev().toDate();
    const since = Math.max(hire.lastTriggeredAt?.toMillis() ?? hire.createdAt.toMillis(), now.getTime() - LOOKBACK_MS);
    if (due.getTime() <= since) continue;

    const input = await scheduledInput(agent, user, hire);
    if (!input) {
      results.push({ hire: doc.id, outcome: "skipped: business profile incomplete" });
      continue;
    }
    const outcome = await enqueue({
      key: `sched-${doc.id}-${due.getTime()}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100),
      userId: hire.userId,
      agentId: hire.agentId,
      input,
      origin: "schedule",
    });
    await doc.ref.update({ lastTriggeredAt: FieldValue.serverTimestamp() });
    results.push({ hire: doc.id, outcome });
  }
  return { checked: hires.size, results };
}

/** What a scheduled run asks for, built from the business profile. Null when there isn't enough to go on. */
async function lastManualInput(userId: string, agentId: string): Promise<Record<string, unknown> | null> {
  // Equality filters only, so no composite index is needed; an owner has few tasks per agent.
  const snap = await db().collection(COLLECTIONS.tasks).where("userId", "==", userId).where("agentId", "==", agentId).get();
  const last = snap.docs
    .map((d) => d.data() as TaskDoc)
    .filter((t) => t.origin === "manual" && t.status !== "failed")
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())[0];
  return last?.input ?? null;
}

async function scheduledInput(agent: AgentDoc, user: UserDoc, hire: HireDoc): Promise<Record<string, unknown> | null> {
  const p = user.businessProfile;
  switch (agent.skills[0]?.id) {
    case "linkedin.post":
      return p?.website && p.audience ? { brandUrl: p.website, audience: p.audience, tone: "Friendly" } : null;
    case "vat.summary":
      return { period: "last-month" };
    case "stock.monitor":
    case "revenue.weekly":
    case "newsletter.draft":
    case "meetings.brief":
      return {};
    case "customers.winback":
      return { inactiveDays: 60 };
    case "leads.followup":
      return { sinceDays: new Date().getUTCDay() === 1 ? 3 : 1 };
    case "bills.book":
      return { period: "last-month" };
    case "bookings.messages":
    case "deals.nudge":
      return {};
    case "enquiries.triage":
      return { sinceHours: new Date().getUTCDay() === 1 ? 72 : 24 };
    case "invoices.chase":
      return (await lastManualInput(hire.userId, agent.slug)) ?? {};
    case "reviews.request":
      return p?.reviewUrl ? {} : null;
    case "deadlines.track": {
      const last = await lastManualInput(hire.userId, agent.slug);
      return last ?? (p?.companyNumber ? {} : null);
    }
    default:
      return agent.source === "a2a" ? { request: `Scheduled run: ${hire.trigger.label}` } : null;
  }
}

/* ------------------------------------------------------------------ */
/* Invoice inbox                                                       */
/* ------------------------------------------------------------------ */

const INBOX_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

/** Stores an upload in the inbox bucket; in production its Pub/Sub event starts ReceiptHero. */
export async function dropInInbox(userId: string, file: { name: string; mimeType: string; data: Buffer }) {
  const bucket = env().INBOX_BUCKET;
  if (!bucket) throw new Error("INBOX_BUCKET is not configured");
  const id = Math.random().toString(36).slice(2, 10);
  const name = `${userId}/${id}-${file.name.replace(/[^\w.\- ]/g, "_")}`;
  await gcs().bucket(bucket).file(name).save(file.data, { contentType: file.mimeType, resumable: false });
  // Locally there's no Pub/Sub push, so handle the event directly.
  if (!env().APP_URL) await onInboxObject(bucket, name, file.mimeType);
  return name;
}

/** Handles a new inbox object: queue ReceiptHero if the owner has hired it with the inbox trigger. */
export async function onInboxObject(bucket: string, name: string, contentType: string) {
  const userId = name.split("/")[0];
  if (!userId || !INBOX_TYPES.has(contentType)) {
    log("inbox.ignored", { name, contentType });
    return "ignored";
  }
  const hire = (await db().collection(COLLECTIONS.hires).doc(`${userId}_receipthero`).get()).data() as HireDoc | undefined;
  if (!hire?.active || hire.trigger.event !== "inbox.file_created") {
    await gcs().bucket(bucket).file(name).delete({ ignoreNotFound: true });
    log("inbox.no_hire", { name, trigger: hire?.trigger.id ?? null }, "WARNING");
    return "no inbox hire";
  }
  log("inbox.enqueue", { name });
  return enqueue({
    key: `inbox-${name}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100),
    userId,
    agentId: "receipthero",
    input: { note: "Arrived in the invoice inbox" },
    origin: "event",
    gcsFile: { bucket, name, contentType },
  });
}

export function isInboxType(mime: string) {
  return INBOX_TYPES.has(mime);
}

/* ------------------------------------------------------------------ */
/* Scheduled publishing                                                */
/* ------------------------------------------------------------------ */

/** Queues an approved task's delivery for a future time. */
export async function schedulePublish(taskId: string, userId: string, at: Date) {
  return enqueue({ key: `publish-${taskId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100), userId, agentId: "echosocial", input: {}, origin: "schedule", publishTaskId: taskId }, at);
}

async function publishTask(taskId: string, userId: string): Promise<{ status: string }> {
  const ref = db().collection(COLLECTIONS.tasks).doc(taskId);
  const task = (await ref.get()).data() as (TaskDoc & { delivery?: { published?: boolean } }) | undefined;
  if (!task || task.userId !== userId || task.status !== "delivered") return { status: "not run: task not approved" };
  if (task.delivery?.published) return { status: "already published" };
  const post = await linkedinPost(userId, String(task.output?.text ?? ""));
  if (!post) return { status: "not run: LinkedIn not connected" };
  await ref.update({
    "delivery.published": true,
    "delivery.summary": "Posted on LinkedIn",
    "delivery.links": [{ label: "View post", url: post.url }],
    steps: FieldValue.arrayUnion({ step: "deliver", status: "ok", message: "Posted on LinkedIn at the scheduled time", at: Timestamp.now() }),
    updatedAt: FieldValue.serverTimestamp(),
  });
  log("job.published", { taskId });
  return { status: "published" };
}

/* ------------------------------------------------------------------ */
/* Google Drive invoice folder                                         */
/* ------------------------------------------------------------------ */

/** For every owner whose ReceiptHero watches Drive, queues files that appeared since it was hired. */
export async function queueDriveInvoices() {
  const hires = await db().collection(COLLECTIONS.hires).where("active", "==", true).where("trigger.event", "==", "google_drive.file_created").get();
  let queued = 0;
  for (const doc of hires.docs) {
    const hire = doc.data() as HireDoc;
    const listing = await driveListInvoices(hire.userId).catch((err) => {
      log("drive.list_failed", { hire: doc.id, error: err instanceof Error ? err.message : String(err) }, "WARNING");
      return null;
    });
    if (!listing) continue;
    const since = (hire.updatedAt ?? hire.createdAt).toMillis();
    for (const f of listing.files) {
      if (Date.parse(f.createdTime) < since) continue;
      // Claim the file once, atomically, so overlapping cron ticks can't double-process it.
      const claim = db().collection("drive_seen").doc(`${hire.userId}_${f.id}`);
      try {
        await claim.create({ userId: hire.userId, fileId: f.id, createdAt: FieldValue.serverTimestamp() });
      } catch {
        continue;
      }
      await enqueue({
        key: `drive-${hire.userId}-${f.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100),
        userId: hire.userId,
        agentId: "receipthero",
        input: { note: `Found in Google Drive: ${f.name}` },
        origin: "event",
        driveFile: { id: f.id, name: f.name, mimeType: f.mimeType },
      });
      queued++;
    }
  }
  if (queued) log("drive.queued", { queued });
  return { watched: hires.size, queued };
}
