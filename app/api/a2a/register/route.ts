import { RegisterRequest, registerAgent } from "@/lib/a2a/registry";
import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { handle, readJson } from "@/lib/http";
import { consume } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/a2a/register — { cardUrl, apiKey? }
 * Fetches and validates an A2A Agent Card, sends the agent a test task and
 * lists it. Always 200 with the checks; `ok` says whether it was listed.
 */
export const POST = handle(async (req) => {
  const member = await getMember(req);
  requireRole(member, "manager", "list agents for this business");
  const uid = member.accountId;
  await consume("registrationsPerUser", uid);
  const result = await registerAgent(uid, await readJson(req, RegisterRequest));
  return { ok: result.ok, checks: result.checks, agent: result.agent, card: result.card };
});
