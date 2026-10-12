import "server-only";
import { getConnection } from "./index";
import { accessToken } from "./tokens";

interface SlackResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

async function slack<T extends SlackResponse>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as T;
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`);
  return json;
}

/** Posts as the AgentGig bot. Channel defaults to the one chosen at connect time. */
export async function slackPost(userId: string, msg: { channel?: string; text: string; threadTs?: string }) {
  const conn = await getConnection(userId, "slack");
  if (!conn) return null;
  const channel = msg.channel ?? (conn.meta?.defaultChannel as string | undefined);
  if (!channel) throw new Error("Choose a Slack channel for AgentGig in Company knowledge → Connections.");
  const token = await accessToken(conn);
  const res = await slack(token, "chat.postMessage", { channel, text: msg.text, thread_ts: msg.threadTs, unfurl_links: false });
  const link = await slack<SlackResponse & { permalink?: string }>(token, "chat.getPermalink", { channel: res.channel, message_ts: res.ts }).catch(() => null);
  return { channel: res.channel!, ts: res.ts!, url: link?.permalink ?? null };
}

export async function slackListChannels(userId: string): Promise<{ id: string; name: string; isMember: boolean }[] | null> {
  const conn = await getConnection(userId, "slack");
  if (!conn) return null;
  const token = await accessToken(conn);
  const res = await slack<SlackResponse & { channels: { id: string; name: string; is_member: boolean }[] }>(token, "conversations.list", {
    types: "public_channel",
    exclude_archived: true,
    limit: 200,
  });
  return res.channels.map((c) => ({ id: c.id, name: c.name, isMember: c.is_member }));
}
