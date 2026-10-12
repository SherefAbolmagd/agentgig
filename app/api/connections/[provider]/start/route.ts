import { z } from "zod";
import { getCallerId } from "@/lib/auth";
import { connectSimulated, parseProvider } from "@/lib/connectors/manage";
import { isConfigured, startConnect } from "@/lib/connectors/oauth";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/connections/{provider}/start — { returnTo }
 * Returns { url } to send the browser to the provider's consent screen, or
 * { simulated: true } after creating a demo connection when the provider's
 * OAuth app isn't configured on this server.
 */
export const POST = handle<{ params: Promise<{ provider: string }> }>(async (req, { params }) => {
  const uid = await getCallerId(req);
  const provider = parseProvider((await params).provider);
  const { returnTo } = await readJson(req, z.object({ returnTo: z.string().max(300).default("/workforce") }));
  if (!isConfigured(provider)) {
    await connectSimulated(uid, provider);
    return { simulated: true };
  }
  return { url: await startConnect(uid, provider, new URL(req.url).origin, returnTo) };
});
