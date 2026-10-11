import { z } from "zod";
import { getCallerId } from "@/lib/auth";
import { HireRequest, hireAgent, releaseAgent } from "@/lib/hires";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/hires — hire an agent or change its settings. */
export const POST = handle(async (req) => {
  const uid = await getCallerId(req);
  const hire = await hireAgent(uid, await readJson(req, HireRequest));
  return { agentId: hire.agentId, approvalMode: hire.approvalMode, trigger: hire.trigger };
});

/** DELETE /api/hires — { agentId } removes an agent from the team. */
export const DELETE = handle(async (req) => {
  const uid = await getCallerId(req);
  const { agentId } = await readJson(req, z.object({ agentId: z.string().min(1) }));
  await releaseAgent(uid, agentId);
  return { ok: true };
});
