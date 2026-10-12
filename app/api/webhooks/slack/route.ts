import { NextResponse } from "next/server";
import { handleSlackEvent, verifySlackSignature } from "@/lib/connectors/slack-events";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/webhooks/slack — Slack Events API (Request URL). Signature-verified; answers within Slack's 3 s. */
export async function POST(req: Request) {
  try {
    const body = await req.text();
    verifySlackSignature(body, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"));
    // Slack retries if we're slow; the job's deterministic name makes retries harmless.
    const { challenge, outcome } = await handleSlackEvent(JSON.parse(body));
    return challenge ? NextResponse.json({ challenge }) : NextResponse.json({ ok: true, outcome });
  } catch (err) {
    return errorResponse(err, req);
  }
}
