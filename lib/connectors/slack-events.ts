import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/firebase-admin";
import { GatewayError } from "@/lib/errors";
import { log } from "@/lib/log";
import { enqueue } from "@/lib/triggers";
import { COLLECTIONS, type ConnectionDoc, type HireDoc } from "@/types/firestore";

/** Verifies Slack's v0 request signature (HMAC-SHA256 of "v0:{timestamp}:{body}"). */
export function verifySlackSignature(body: string, timestamp: string | null, signature: string | null, now = Date.now()) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !timestamp || !signature) throw new GatewayError("UNAUTHENTICATED", "Missing Slack signature.");
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) throw new GatewayError("UNAUTHENTICATED", "Stale Slack request.");
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new GatewayError("UNAUTHENTICATED", "Invalid Slack signature.");
}

interface SlackEventBody {
  type: string;
  challenge?: string;
  team_id?: string;
  event?: { type: string; subtype?: string; bot_id?: string; user?: string; text?: string; channel?: string; ts?: string; thread_ts?: string };
}

/** Turns a customer's channel message into a DM Concierge job for the owner who connected that workspace. */
export async function handleSlackEvent(payload: SlackEventBody): Promise<{ challenge?: string; outcome: string }> {
  if (payload.type === "url_verification") return { challenge: payload.challenge, outcome: "verified" };
  const e = payload.event;
  if (payload.type !== "event_callback" || e?.type !== "message") return { outcome: "ignored" };
  // Only people's top-level messages: not bots (including ourselves), edits, joins or thread replies.
  if (e.subtype || e.bot_id || !e.text || !e.channel || !e.ts || (e.thread_ts && e.thread_ts !== e.ts)) return { outcome: "ignored" };

  const conns = await db().collection(COLLECTIONS.connections).where("provider", "==", "slack").where("meta.teamId", "==", payload.team_id).get();
  for (const doc of conns.docs) {
    const conn = doc.data() as ConnectionDoc;
    if (conn.status !== "active" || conn.meta?.defaultChannel !== e.channel) continue;
    const hire = (await db().collection(COLLECTIONS.hires).doc(`${conn.userId}_dm-concierge`).get()).data() as HireDoc | undefined;
    if (!hire?.active || hire.trigger.event !== "slack.message") continue;
    const outcome = await enqueue({
      key: `slack-${payload.team_id}-${e.channel}-${e.ts}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100),
      userId: conn.userId,
      agentId: "dm-concierge",
      input: { customerMessage: e.text.slice(0, 2000), slack: { channel: e.channel, ts: e.ts } },
      origin: "event",
    });
    log("INFO", "slack.message_queued", { component: "triggers", outcome });
    return { outcome };
  }
  return { outcome: "no matching hire" };
}
