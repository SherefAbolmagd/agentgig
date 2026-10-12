import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { GatewayError, isGatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { logError } from "@/lib/log";
import { parseProvider } from "@/lib/connectors/manage";
import { finishConnect } from "@/lib/connectors/oauth";
import { receiveWooKeys } from "@/lib/connectors/woocommerce";
import { errorResponse } from "@/lib/http";
import type { OAuthProvider } from "@/lib/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connections/{provider}/callback
 *   OAuth vendors redirect here after consent. WooCommerce sends the browser
 *   here (?state=…&success=1) after the owner approves on their own site.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const url = new URL(req.url);
  const base = env().PUBLIC_URL ?? env().APP_URL ?? url.origin;
  const back = (path: string, query: Record<string, string>) => NextResponse.redirect(`${base}${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(query)}`, 303);
  const provider = (await params).provider;

  if (provider === "woocommerce") {
    const state = url.searchParams.get("state") ?? "";
    const saved = (await db().collection("oauth_states").doc(state).get()).data() as { returnTo?: string; completedAt?: unknown } | undefined;
    const returnTo = saved?.returnTo ?? "/knowledge";
    if (url.searchParams.get("success") === "0") return back(returnTo, { connectError: "WooCommerce access wasn't approved." });
    if (!saved?.completedAt) return back(returnTo, { connectError: "WooCommerce didn't send the keys. Check your site is reachable over https and try again." });
    await db().collection("oauth_states").doc(state).delete();
    return back(returnTo, { connected: "woocommerce" });
  }

  const denied = url.searchParams.get("error");
  if (denied) return back("/knowledge", { connectError: `${provider} access wasn't granted (${denied}).` });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back("/knowledge", { connectError: "The sign-in response was incomplete. Try connecting again." });

  try {
    const { returnTo } = await finishConnect(parseProvider(provider) as OAuthProvider, code, state, url.origin, {
      realmId: url.searchParams.get("realmId") ?? undefined,
      accountsServer: url.searchParams.get("accounts-server") ?? undefined,
    });
    return back(returnTo, { connected: provider });
  } catch (err) {
    if (!isGatewayError(err)) logError(err, { provider });
    return back("/knowledge", { connectError: isGatewayError(err) ? err.message : "Connecting failed. Try again." });
  }
}

/** POST /api/connections/woocommerce/callback — the owner's WordPress site delivers the new API keys here. */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    if ((await params).provider !== "woocommerce") throw new GatewayError("INVALID_INPUT", "Not supported.");
    await receiveWooKeys((await req.json()) as Record<string, string>);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, req);
  }
}
