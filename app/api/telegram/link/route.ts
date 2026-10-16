import { getMember } from "@/lib/auth";
import { handle } from "@/lib/http";
import { consume } from "@/lib/rate-limit";
import { createLinkCode, unlinkTelegram } from "@/lib/telegram/link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/telegram/link — a one-time t.me link (10 minutes) that connects the caller's Telegram. */
export const POST = handle(async (req) => {
  const member = await getMember(req);
  await consume("telegramLinkCodes", member.uid);
  return createLinkCode(member);
});

/** DELETE /api/telegram/link — disconnects the caller's Telegram. */
export const DELETE = handle(async (req) => {
  const member = await getMember(req);
  return { unlinked: await unlinkTelegram(member.uid) };
});
