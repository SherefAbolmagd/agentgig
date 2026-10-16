import { z } from "zod";
import { getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { GatewayError } from "@/lib/errors";
import { parseProvider } from "@/lib/connectors/manage";
import { isConfigured, providerConfig, startConnect } from "@/lib/connectors/oauth";
import { startWooConnect } from "@/lib/connectors/woocommerce";
import { handle, readJson } from "@/lib/http";
import { INTEGRATIONS, type OAuthProvider } from "@/lib/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ returnTo: z.string().max(300).default("/knowledge"), siteUrl: z.string().max(300).optional() });

/**
 * POST /api/connections/{provider}/start — { returnTo, siteUrl? } → { url }
 * OAuth vendors: their consent screen. WooCommerce: the store's own approval page.
 */
export const POST = handle<{ params: Promise<{ provider: string }> }>(async (req, { params }) => {
  const member = await getMember(req);
  requireRole(member, "manager", "connect tools");
  const uid = member.accountId;
  const provider = parseProvider((await params).provider);
  const { returnTo, siteUrl } = await readJson(req, Body);
  const kind = INTEGRATIONS[provider].kind;
  if (kind === "woo") {
    if (!siteUrl) throw new GatewayError("INVALID_INPUT", "Enter your store's address.");
    return { url: await startWooConnect(uid, siteUrl, returnTo) };
  }
  if (kind !== "oauth") throw new GatewayError("INVALID_INPUT", `${INTEGRATIONS[provider].name} connects with a key, not a sign-in.`);
  const p = provider as OAuthProvider;
  if (!isConfigured(p)) throw new GatewayError("AGENT_UNAVAILABLE", `${providerConfig(p).label} connections aren't available yet.`);
  return { url: await startConnect(uid, p, new URL(req.url).origin, returnTo) };
});
