import "server-only";
import { env } from "@/lib/env";
import { GatewayError } from "@/lib/errors";

/**
 * The few Telegram Bot API calls AgentGig uses. One shared bot serves every
 * organization; which organization a chat belongs to is decided by
 * telegram_links, never by anything in a message.
 * Docs: https://core.telegram.org/bots/api
 */

export function telegramEnabled(): boolean {
  const e = env();
  return !!(e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_BOT_USERNAME && e.TELEGRAM_WEBHOOK_SECRET);
}

function token(): string {
  const t = env().TELEGRAM_BOT_TOKEN;
  if (!t) throw new GatewayError("AGENT_UNAVAILABLE", "Telegram isn't set up yet.");
  return t;
}

export async function tg<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result as T;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** Telegram's HTML subset: only these three characters need escaping. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MAX_TEXT = 4000; // Telegram's limit is 4096

export async function sendMessage(chatId: number, html: string, buttons?: InlineButton[][]) {
  const text = html.length > MAX_TEXT ? `${html.slice(0, MAX_TEXT)}…` : html;
  return tg<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(buttons && { reply_markup: { inline_keyboard: buttons } }),
  });
}

export async function sendTyping(chatId: number) {
  await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
}

export async function answerCallback(callbackQueryId: string, text?: string) {
  await tg("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text && { text }) }).catch(() => undefined);
}

/** Removes the buttons under a message once its draft is decided. */
export async function clearButtons(chatId: number, messageId: number) {
  await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
}

const MAX_VOICE_BYTES = 10 * 1024 * 1024;

/** Downloads a file the user sent (voice notes). */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const file = await tg<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram returned no file path.");
  if ((file.file_size ?? 0) > MAX_VOICE_BYTES) throw new GatewayError("INVALID_INPUT", "That voice note is too long. Keep it under a few minutes.");
  const res = await fetch(`https://api.telegram.org/file/bot${token()}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function botLink(startToken: string): string {
  return `https://t.me/${env().TELEGRAM_BOT_USERNAME}?start=${startToken}`;
}
