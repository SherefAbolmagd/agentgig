import "server-only";
import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { z } from "zod";
import { NATIVE_AGENTS, type AnyNativeAgent, type UploadedFile } from "@/lib/agents";
import { mergeFindings, scrubFile, scrubText } from "@/lib/dlp";
import { GatewayError, isGatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { reserveTokens, settleTask } from "@/lib/ledger";
import {
  COLLECTIONS,
  type AgentDoc,
  type DlpFinding,
  type GatewayStep,
  type HireDoc,
  type TaskDoc,
  type TaskStatus,
  type UserDoc,
} from "@/types/firestore";
import { buildGrounding, describeGrounding } from "./ground";

/**
 * The gateway: every task, from the dashboard or a trigger, runs through
 *   1 Verify  2 Reserve  3 Scrub  4 Ground  5 Run  6 Deliver
 * and logs each step on tasks/{id}.steps so the dashboard can show progress.
 */

export interface RunTaskRequest {
  userId: string;
  agentId: string;
  rawInput: unknown;
  files: UploadedFile[];
  origin: TaskDoc["origin"];
  idempotencyKey?: string;
}

export interface RunTaskResult {
  taskId: string;
  status: TaskStatus;
  output: Record<string, unknown>;
  dlpFindings: DlpFinding[];
  tokensCharged: number;
  balance: number;
  approvalId?: string;
  delivery?: Record<string, unknown>;
}

export async function runTask(req: RunTaskRequest): Promise<RunTaskResult> {
  /* 1 · Verify — before any tokens move, so bad requests cost nothing */
  const { agent, hire, user, handler, input } = await verify(req);

  /* 2 · Reserve */
  let taskId: string;
  let reused: boolean;
  try {
    ({ taskId, reused } = await reserveTokens({
      userId: req.userId,
      agentId: agent.slug,
      agentName: agent.name,
      skillId: handler.skillId,
      cost: agent.tokensPerTask,
      hireId: `${req.userId}_${agent.slug}`,
      origin: req.origin,
      input: {},
      idempotencyKey: req.idempotencyKey,
    }));
  } catch (err) {
    if (isGatewayError(err) && err.code === "INSUFFICIENT_TOKENS") await recordRejected(req, agent, handler, err);
    throw err;
  }
  const taskRef = db().collection(COLLECTIONS.tasks).doc(taskId);
  if (reused) return existingResult(taskRef, user.tokenBalance);
  const log = stepLogger(taskRef);
  await log("verify", "ok", `${agent.name} is on your team · ${hire.approvalMode === "ask" ? "asks first" : "acts on its own"}`);
  await log("reserve", "ok", `Held ${agent.tokensPerTask} tokens`);

  let output: Record<string, unknown>;
  let dlpFindings: DlpFinding[];
  try {
    /* 3 · Scrub */
    const textFields = Object.fromEntries(
      handler.scrubFields.flatMap((k) => (typeof input[k] === "string" ? [[k, input[k] as string]] : [])),
    );
    const [text, ...fileResults] = await Promise.all([
      scrubText(textFields),
      ...req.files.map((f) => scrubFile(f.data, f.mimeType)),
    ]);
    const cleanInput = { ...input, ...text.fields };
    const files = req.files.map((f, i) => ({ ...f, data: fileResults[i].data }));
    dlpFindings = mergeFindings([...text.findings, ...fileResults.flatMap((r) => r.findings)]);
    await taskRef.update({
      input: { ...cleanInput, files: req.files.map((f) => ({ name: f.name, mimeType: f.mimeType, sizeBytes: f.data.length })) },
      dlpFindings,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const notes = fileResults.flatMap((r) => (r.note ? [r.note] : []));
    await log("scrub", "ok", [summariseFindings(dlpFindings), ...notes].join(" "));

    /* 4 · Ground */
    const grounding = await buildGrounding(user, hire);
    await log("ground", "ok", describeGrounding(grounding));

    /* 5 · Run */
    await taskRef.update({ status: "running", updatedAt: FieldValue.serverTimestamp() });
    const result = await handler.run({ taskId, userId: req.userId, input: cleanInput, files, grounding });
    output = result.output;
    await log("run", "ok", `${result.model} answered in ${(result.latencyMs / 1000).toFixed(1)}s (${result.usage.outputTokens} output tokens)`);
  } catch (err) {
    const failure = isGatewayError(err)
      ? err
      : new GatewayError("AGENT_FAILED", "Something went wrong while the agent was working.", { cause: String(err) });
    const { balance } = await settleTask(taskId, "release", `Refund: ${agent.name} task failed`);
    await taskRef.update({
      status: "failed",
      error: { code: failure.code, message: failure.message },
      finishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await log("run", "error", `${failure.message} Your ${agent.tokensPerTask} tokens were released.`);
    throw new GatewayError(failure.code, failure.message, { ...failure.details, taskId, balance });
  }

  /* 6 · Deliver — charge first: the work is done even if the owner later skips it */
  const { balance } = await settleTask(taskId, "charge", `${agent.name}: ${handler.skillId}`);
  void db().collection(COLLECTIONS.agents).doc(agent.slug).update({ taskCount: FieldValue.increment(1) });

  if (hire.approvalMode === "ask") {
    const draft = handler.approval(output);
    const approvalRef = await db()
      .collection(COLLECTIONS.approvals)
      .add({ ...draft, userId: req.userId, taskId, agentId: agent.slug, status: "open", createdAt: FieldValue.serverTimestamp() });
    await taskRef.update({ status: "awaiting_approval", output, finishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    await log("deliver", "ok", `Charged ${agent.tokensPerTask} tokens · draft sent to your approval inbox`);
    return { taskId, status: "awaiting_approval", output, dlpFindings, tokensCharged: agent.tokensPerTask, balance, approvalId: approvalRef.id };
  }

  const delivery = await handler.deliver(output, { userId: req.userId, taskId });
  await taskRef.update({ status: "delivered", output, delivery, finishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await log("deliver", "ok", `Charged ${agent.tokensPerTask} tokens · delivered${delivery.simulated ? " (simulated)" : ""}`);
  return { taskId, status: "delivered", output, dlpFindings, tokensCharged: agent.tokensPerTask, balance, delivery };
}

async function verify(req: RunTaskRequest) {
  const store = db();
  const [agentSnap, hireSnap, userSnap] = await Promise.all([
    store.collection(COLLECTIONS.agents).doc(req.agentId).get(),
    store.collection(COLLECTIONS.hires).doc(`${req.userId}_${req.agentId}`).get(),
    store.collection(COLLECTIONS.users).doc(req.userId).get(),
  ]);
  if (!userSnap.exists) throw new GatewayError("USER_NOT_FOUND", "We couldn't find your account.");
  if (!agentSnap.exists) throw new GatewayError("AGENT_NOT_FOUND", `There is no agent called “${req.agentId}”.`);
  const agent = agentSnap.data() as AgentDoc;
  if (agent.status !== "listed") throw new GatewayError("AGENT_UNAVAILABLE", `${agent.name} isn't available right now.`);

  const hire = hireSnap.data() as HireDoc | undefined;
  if (!hire?.active) throw new GatewayError("NOT_HIRED", `Hire ${agent.name} from the marketplace before giving it tasks.`);

  const handler = agent.source === "native" ? NATIVE_AGENTS[agent.slug] : undefined;
  if (!handler) {
    throw new GatewayError("AGENT_UNAVAILABLE", `${agent.name} is a preview listing and can't take tasks yet.`);
  }

  const parsed = handler.inputSchema.safeParse(req.rawInput ?? {});
  if (!parsed.success) {
    throw new GatewayError("INVALID_INPUT", "Some task details are missing or invalid.", { issues: z.prettifyError(parsed.error) });
  }
  checkFiles(handler, req.files);

  return { agent, hire, user: userSnap.data() as UserDoc, handler, input: parsed.data };
}

function checkFiles(handler: AnyNativeAgent, files: UploadedFile[]) {
  const rules = handler.files;
  if (!rules) {
    if (files.length) throw new GatewayError("INVALID_INPUT", "This agent doesn't take file uploads.");
    return;
  }
  if (rules.required && !files.length) throw new GatewayError("INVALID_INPUT", "Attach a file for this task.");
  if (files.length > 1) throw new GatewayError("INVALID_INPUT", "Attach one file per task.");
  for (const f of files) {
    if (!rules.mimeTypes.includes(f.mimeType)) {
      throw new GatewayError("INVALID_INPUT", `“${f.name}” is a ${f.mimeType} file. Upload a PDF, JPEG, PNG or WebP.`);
    }
    if (f.data.length > rules.maxBytes) {
      throw new GatewayError("INVALID_INPUT", `“${f.name}” is larger than ${rules.maxBytes / 1024 / 1024} MB.`);
    }
  }
}

async function recordRejected(req: RunTaskRequest, agent: AgentDoc, handler: AnyNativeAgent, err: GatewayError) {
  const ref = await db().collection(COLLECTIONS.tasks).add({
    userId: req.userId,
    agentId: agent.slug,
    hireId: `${req.userId}_${agent.slug}`,
    skillId: handler.skillId,
    origin: req.origin,
    status: "rejected",
    cost: agent.tokensPerTask,
    input: {},
    dlpFindings: [],
    steps: [{ step: "reserve", status: "error", message: err.message, at: Timestamp.now() }],
    error: { code: err.code, message: err.message },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    finishedAt: FieldValue.serverTimestamp(),
  });
  Object.assign(err.details ?? {}, { taskId: ref.id });
}

/** A retried request (same Idempotency-Key) gets the first attempt's state, never a second run. */
async function existingResult(taskRef: DocumentReference, balance: number): Promise<RunTaskResult> {
  const task = (await taskRef.get()).data() as TaskDoc & { delivery?: Record<string, unknown> };
  return {
    taskId: taskRef.id,
    status: task.status,
    output: task.output ?? {},
    dlpFindings: task.dlpFindings,
    tokensCharged: task.settlement === "charged" ? task.cost : 0,
    balance,
    delivery: task.delivery,
  };
}

function stepLogger(taskRef: DocumentReference) {
  return (step: GatewayStep, status: "ok" | "error" | "skipped", message: string) =>
    taskRef.update({
      steps: FieldValue.arrayUnion({ step, status, message, at: Timestamp.now() }),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

function summariseFindings(findings: DlpFinding[]): string {
  if (!findings.length) return "No personal data found.";
  return `Removed ${findings.map((f) => `${f.count} ${f.infoType.toLowerCase().replace(/_/g, " ")}`).join(", ")}.`;
}
