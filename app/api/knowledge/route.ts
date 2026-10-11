import { getCallerId } from "@/lib/auth";
import { GatewayError } from "@/lib/errors";
import { handle } from "@/lib/http";
import { addKnowledge } from "@/lib/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/knowledge — multipart `file`. Uploads a company knowledge file. */
export const POST = handle(async (req) => {
  const uid = await getCallerId(req);
  const file = (await req.formData()).get("file");
  if (!(file instanceof File) || !file.size) throw new GatewayError("INVALID_INPUT", "Choose a file to upload.");
  const { id, doc } = await addKnowledge(uid, {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    data: Buffer.from(await file.arrayBuffer()),
  });
  return { id, name: doc.name, approxTokens: doc.approxTokens, dlpFindings: doc.dlpFindings };
});
