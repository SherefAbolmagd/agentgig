import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { disconnect, parseProvider } from "@/lib/connectors/manage";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/connections/{provider} — disconnects and deletes the stored tokens. */
export const DELETE = handle<{ params: Promise<{ provider: string }> }>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "manager", "disconnect tools");
  const uid = member.accountId;
  await disconnect(uid, parseProvider((await params).provider));
  return { ok: true };
});
