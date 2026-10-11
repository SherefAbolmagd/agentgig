import { handle } from "@/lib/http";
import { verifyInternalCall } from "@/lib/internal-auth";
import { onInboxObject } from "@/lib/triggers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PushBody {
  message?: { attributes?: Record<string, string>; data?: string };
}

/**
 * POST /api/triggers/inbox — Pub/Sub push for Cloud Storage notifications on
 * the inbox bucket. Always acknowledges (2xx) events it decides to ignore, so
 * Pub/Sub doesn't redeliver them.
 */
export const POST = handle(async (req) => {
  await verifyInternalCall(req);
  const body = (await req.json().catch(() => ({}))) as PushBody;
  const a = body.message?.attributes ?? {};
  if (a.eventType !== "OBJECT_FINALIZE" || !a.bucketId || !a.objectId) return { outcome: "ignored" };
  let contentType = "";
  try {
    contentType = JSON.parse(Buffer.from(body.message?.data ?? "", "base64").toString("utf8")).contentType ?? "";
  } catch {
    /* no payload: treated as unsupported */
  }
  return { outcome: await onInboxObject(a.bucketId, a.objectId, contentType) };
});
