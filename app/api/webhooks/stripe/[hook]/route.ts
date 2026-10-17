import { NextResponse } from "next/server";
import { onStripeWebhook } from "@/lib/event-sources";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/stripe/{hookId} — an owner's own Stripe account telling
 * AgentGig about a failed payment. Verified with that endpoint's signing secret.
 */
export async function POST(req: Request, { params }: { params: Promise<{ hook: string }> }) {
  try {
    const body = await req.text();
    const outcome = await onStripeWebhook((await params).hook, body, req.headers.get("stripe-signature") ?? "");
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    return errorResponse(err, req);
  }
}
