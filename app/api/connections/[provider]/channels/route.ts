import { z } from "zod";
import { getCallerId, getMember } from "@/lib/auth";
import { requireRole } from "@/lib/org";
import { GatewayError } from "@/lib/errors";
import { setSlackChannel } from "@/lib/connectors/manage";
import { slackListChannels } from "@/lib/connectors/slack";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/connections/slack/channels — public channels in the connected workspace. */
type Ctx = { params: Promise<{ provider: string }> };

async function requireSlack(ctx: Ctx) {
  if ((await ctx.params).provider !== "slack") throw new GatewayError("INVALID_INPUT", "Only Slack has channels.");
}

export const GET = handle<Ctx>(async (req, ctx) => {
  await requireSlack(ctx);
  const uid = await getCallerId(req);
  return { channels: (await slackListChannels(uid)) ?? [] };
});

/** PUT /api/connections/slack/channels — { channel } sets where agents post by default. */
export const PUT = handle<Ctx>(async (req, ctx) => {
  await requireSlack(ctx);
  const member = await getMember(req);
  requireRole(member, "manager", "change connections");
  const uid = member.accountId;
  const { channel } = await readJson(req, z.object({ channel: z.string().regex(/^[A-Z0-9]{6,20}$/) }));
  await setSlackChannel(uid, channel);
  return { ok: true };
});
