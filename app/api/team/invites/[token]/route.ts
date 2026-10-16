import { getCaller, getMember } from "@/lib/auth";
import { handle } from "@/lib/http";
import { describeInvite, requireRole, revokeInvite } from "@/lib/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

/** GET /api/team/invites/{token} — which business the link is for. Needs sign-in, not membership. */
export const GET = handle<Ctx>(async (req, { params }) => {
  await getCaller(req);
  return describeInvite((await params).token);
});

/** DELETE /api/team/invites/{token} — cancel an unused link. */
export const DELETE = handle<Ctx>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "manager", "cancel invites");
  await revokeInvite(member.accountId, (await params).token);
  return { ok: true };
});
