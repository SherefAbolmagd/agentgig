import { getCallerId } from "@/lib/auth";
import { disconnect, parseProvider } from "@/lib/connectors/manage";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/connections/{provider} — disconnects and deletes the stored tokens. */
export const DELETE = handle<{ params: Promise<{ provider: string }> }>(async (req, { params }) => {
  const uid = await getCallerId(req);
  await disconnect(uid, parseProvider((await params).provider));
  return { ok: true };
});
