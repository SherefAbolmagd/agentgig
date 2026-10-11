import { getCallerId } from "@/lib/auth";
import { handle } from "@/lib/http";
import { deleteKnowledge } from "@/lib/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/knowledge/{id} */
export const DELETE = handle<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const uid = await getCallerId(req);
  await deleteKnowledge(uid, (await params).id);
  return { ok: true };
});
