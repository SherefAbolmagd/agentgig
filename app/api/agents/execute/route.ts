import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCallerId } from "@/lib/auth";
import { GatewayError } from "@/lib/errors";
import { runTask } from "@/lib/gateway/pipeline";
import { errorResponse, readTaskBody } from "@/lib/http";
import { consume } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const AgentId = z.string().regex(/^[a-z0-9-]{2,64}$/);

/**
 * POST /api/agents/execute
 *
 * Runs one task through the gateway: verify → reserve tokens → scrub personal
 * data → ground → run agent → charge and deliver (or send to approval).
 *
 * JSON:      { "agentId": "echosocial", "input": { ... } }
 * Multipart: agentId, input (JSON string), file   — for ReceiptHero
 * Optional header Idempotency-Key makes a retried request reuse its first task.
 *
 * 200 { taskId, status, output, dlpFindings, tokensCharged, balance, approvalId?, delivery? }
 * 400 INVALID_INPUT · 401 UNAUTHENTICATED · 402 INSUFFICIENT_TOKENS · 403 NOT_HIRED
 * 502 AGENT_FAILED / 504 AGENT_TIMEOUT (tokens released; details.taskId and details.balance included)
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getCallerId(req);
    await consume("tasksPerUser", userId);
    const body = await readTaskBody(req);
    const agentId = AgentId.safeParse(body.agentId);
    if (!agentId.success) throw new GatewayError("INVALID_INPUT", "Choose which agent should do this task.");

    const idempotencyKey = req.headers.get("idempotency-key") ?? undefined;
    if (idempotencyKey && !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
      throw new GatewayError("INVALID_INPUT", "Idempotency-Key must be 8–64 letters, digits, - or _.");
    }

    const result = await runTask({
      userId,
      agentId: agentId.data,
      rawInput: body.input,
      files: body.files,
      origin: "manual",
      idempotencyKey,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, req);
  }
}
