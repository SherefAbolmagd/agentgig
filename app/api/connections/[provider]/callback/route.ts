import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { isGatewayError } from "@/lib/errors";
import { logError } from "@/lib/log";
import { parseProvider } from "@/lib/connectors/manage";
import { finishConnect } from "@/lib/connectors/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/connections/{provider}/callback — the provider redirects here after consent. */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const url = new URL(req.url);
  const base = env().APP_URL ?? url.origin;
  const back = (path: string, query: Record<string, string>) => NextResponse.redirect(`${base}${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(query)}`, 303);
  const provider = (await params).provider;

  const denied = url.searchParams.get("error");
  if (denied) return back("/knowledge", { connectError: `${provider} access wasn't granted (${denied}).` });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back("/knowledge", { connectError: "The sign-in response was incomplete. Try connecting again." });

  try {
    const { returnTo } = await finishConnect(parseProvider(provider), code, state, url.origin);
    return back(returnTo, { connected: provider });
  } catch (err) {
    if (!isGatewayError(err)) logError(err, { provider });
    return back("/knowledge", { connectError: isGatewayError(err) ? err.message : "Connecting failed. Try again." });
  }
}
