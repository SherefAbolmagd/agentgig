import { NextResponse } from "next/server";
import { isStripeConfigured } from "@/lib/billing";
import { isConfigured } from "@/lib/connectors/oauth";
import { INTEGRATIONS, PROVIDERS, type OAuthProvider } from "@/lib/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/connections/status — which integrations can be connected on this server. */
export function GET() {
  return NextResponse.json({
    // Key-based vendors need nothing from us; OAuth vendors need their app's client ID and secret.
    providers: Object.fromEntries(PROVIDERS.map((p) => [p, INTEGRATIONS[p].kind === "oauth" ? isConfigured(p as OAuthProvider) : true])),
    payments: isStripeConfigured(),
  });
}
