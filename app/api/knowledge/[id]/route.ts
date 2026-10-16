import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { handle } from "@/lib/http";
import { deleteKnowledge } from "@/lib/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/knowledge/{id} */
export const DELETE = handle<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "manager", "delete company files");
  const uid = member.accountId;
  await deleteKnowledge(uid, (await params).id);
  return { ok: true };
});
