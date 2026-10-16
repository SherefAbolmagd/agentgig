import { NextResponse } from "next/server";
import { isGatewayError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { log } from "@/lib/log";
import { handleTelegramUpdate, verifyTelegramSecret, type TgUpdate } from "@/lib/telegram/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/telegram/webhook — Telegram Bot API updates for the shared
 * AgentGig bot. Only calls carrying our secret header are read. Anything else
 * that goes wrong still answers 200, so Telegram doesn't retry it forever.
 */
export async function POST(req: Request) {
  try {
    verifyTelegramSecret(req.headers.get("x-telegram-bot-api-secret-token"));
  } catch (err) {
    return errorResponse(err, req);
  }
  try {
    const outcome = await handleTelegramUpdate((await req.json()) as TgUpdate);
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    log("ERROR", "telegram.webhook_failed", { component: "telegram", error: isGatewayError(err) ? err.message : String(err) });
    return NextResponse.json({ ok: true, outcome: "error" });
  }
}
