import { onGmailPush } from "@/lib/email-trigger";
import { handle } from "@/lib/http";
import { verifyInternalCall } from "@/lib/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PushBody {
  message?: { data?: string };
}

/**
 * POST /api/triggers/gmail — Pub/Sub push for Gmail inbox changes
 * ({ emailAddress, historyId }). Always acknowledges (2xx) events it decides
 * to ignore, so Pub/Sub doesn't redeliver them.
 */
export const POST = handle(async (req) => {
  await verifyInternalCall(req);
  const body = (await req.json().catch(() => ({}))) as PushBody;
  let note: { emailAddress?: string; historyId?: string | number } = {};
  try {
    note = JSON.parse(Buffer.from(body.message?.data ?? "", "base64").toString("utf8"));
  } catch {
    /* no payload: ignored */
  }
  if (!note.emailAddress || !note.historyId) return { outcome: "ignored" };
  return { outcome: await onGmailPush(note.emailAddress, String(note.historyId)) };
});
