import { z } from "zod";
import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { HireRequest, hireAgent, releaseAgent } from "@/lib/hires";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/hires — hire an agent or change its settings. */
export const POST = handle(async (req) => {
  const member = await getMember(req);
  requireRole(member, "manager", "hire agents or change their settings");
  const uid = member.accountId;
  const hire = await hireAgent(uid, await readJson(req, HireRequest));
  return { agentId: hire.agentId, approvalMode: hire.approvalMode, trigger: hire.trigger };
});

/** DELETE /api/hires — { agentId } removes an agent from the team. */
export const DELETE = handle(async (req) => {
  const member = await getMember(req);
  requireRole(member, "manager", "remove agents from the team");
  const uid = member.accountId;
  const { agentId } = await readJson(req, z.object({ agentId: z.string().min(1) }));
  await releaseAgent(uid, agentId);
  return { ok: true };
});
