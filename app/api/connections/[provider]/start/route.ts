import { z } from "zod";
import { getCallerId } from "@/lib/auth";
import { GatewayError } from "@/lib/errors";
import { parseProvider } from "@/lib/connectors/manage";
import { isConfigured, providerConfig, startConnect } from "@/lib/connectors/oauth";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/connections/{provider}/start — { returnTo } → { url } of the provider's consent screen. */
export const POST = handle<{ params: Promise<{ provider: string }> }>(async (req, { params }) => {
  const uid = await getCallerId(req);
  const provider = parseProvider((await params).provider);
  if (!isConfigured(provider)) {
    throw new GatewayError("AGENT_UNAVAILABLE", `${providerConfig(provider).label} connections aren't available yet.`);
  }
  const { returnTo } = await readJson(req, z.object({ returnTo: z.string().max(300).default("/workforce") }));
  return { url: await startConnect(uid, provider, new URL(req.url).origin, returnTo) };
});
