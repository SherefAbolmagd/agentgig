import { NextResponse } from "next/server";
import { isStripeConfigured } from "@/lib/billing";
import { PROVIDERS } from "@/lib/connectors/manage";
import { isConfigured } from "@/lib/connectors/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/connections/status — which real integrations this server has keys for. */
export function GET() {
  return NextResponse.json({
    providers: Object.fromEntries(PROVIDERS.map((p) => [p, isConfigured(p)])),
    payments: isStripeConfigured(),
  });
}
