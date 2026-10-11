import { getCallerId } from "@/lib/auth";
import { GatewayError } from "@/lib/errors";
import { handle } from "@/lib/http";
import { consume } from "@/lib/rate-limit";
import { dropInInbox, isInboxType } from "@/lib/triggers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * POST /api/inbox — multipart `file` (repeatable). Drops invoices into the
 * owner's inbox; each one becomes a ReceiptHero task in the background.
 */
export const POST = handle(async (req) => {
  const uid = await getCallerId(req);
  await consume("uploadsPerUser", uid);
  const files = (await req.formData()).getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) throw new GatewayError("INVALID_INPUT", "Choose at least one invoice.");
  if (files.length > MAX_FILES) throw new GatewayError("INVALID_INPUT", `Drop up to ${MAX_FILES} invoices at a time.`);
  for (const f of files) {
    if (!isInboxType(f.type)) throw new GatewayError("INVALID_INPUT", `“${f.name}” isn't a PDF, JPEG, PNG or WebP.`);
    if (f.size > MAX_BYTES) throw new GatewayError("INVALID_INPUT", `“${f.name}” is larger than 10 MB.`);
  }
  for (const f of files) {
    await dropInInbox(uid, { name: f.name, mimeType: f.type, data: Buffer.from(await f.arrayBuffer()) });
  }
  return { queued: files.length };
});
