import { getMember } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { createInvite, InviteRequest, requireRole } from "@/lib/org";
import { consume } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/team/invites — { role, label } → { token } for a /join/{token} link valid for 7 days. */
export const POST = handle(async (req) => {
  const member = await getMember(req);
  requireRole(member, "manager", "invite people");
  await consume("registrationsPerUser", member.accountId);
  return createInvite(member.accountId, member, await readJson(req, InviteRequest));
});
