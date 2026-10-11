import { getCallerId } from "@/lib/auth";
import { ApprovalDecision, resolveApproval } from "@/lib/gateway/approvals";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/approvals/{id} — { action: "approve" | "skip", editedText? } */
export const POST = handle<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const uid = await getCallerId(req);
  const { id } = await params;
  return resolveApproval(uid, id, await readJson(req, ApprovalDecision));
});
