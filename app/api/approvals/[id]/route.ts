import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { ApprovalDecision, resolveApproval } from "@/lib/gateway/approvals";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/approvals/{id} — { action: "approve" | "skip", editedText? } */
export const POST = handle<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "manager", "approve or skip drafts");
  const uid = member.accountId;
  const { id } = await params;
  return resolveApproval(uid, id, await readJson(req, ApprovalDecision));
});
