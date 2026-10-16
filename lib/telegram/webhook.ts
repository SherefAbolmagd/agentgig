import "server-only";
import { timingSafeEqual } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { env } from "@/lib/env";
import { GatewayError, isGatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { resolveApproval } from "@/lib/gateway/approvals";
import { log } from "@/lib/log";
import { hasRole } from "@/lib/org";
import { consume } from "@/lib/rate-limit";
import { enqueue } from "@/lib/triggers";
import { COLLECTIONS } from "@/types/firestore";
import { answerCallback, clearButtons, downloadFile, escapeHtml, sendMessage, sendTyping } from "./api";
import { isLinkCode, redeemLinkCode, resolveSender, setPendingEdit, unlinkTelegram, type LinkedPerson, type TelegramSender } from "./link";
import { handlePersonMessage, post, saveTurn, SUPERVISOR_NAME } from "./supervisor";

/**
 * Telegram webhook. Checks run in order before anything is read or stored:
 *   1 the secret header Telegram sends with every call
 *   2 each update ID handled once (Telegram retries slow answers)
 *   3 private chats only
 *   4 the sender's Telegram ID → telegram_links → still on that team
 * Linking (/start CODE) and /stop are answered here; real work goes to a
 * Cloud Tasks job so Telegram gets its answer within seconds.
 */

const STRANGER =
  "This bot works for AgentGig teams. To connect, sign in at agentgig.si and choose Team → Connect Telegram, then open the link it gives you.";
const EDIT_MINUTES = 15;

export function verifyTelegramSecret(header: string | null) {
  const secret = env().TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !header) throw new GatewayError("UNAUTHENTICATED", "Missing Telegram secret.");
  const a = Buffer.from(secret);
  const b = Buffer.from(header);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new GatewayError("UNAUTHENTICATED", "Invalid Telegram secret.");
}

interface TgMessage {
  message_id: number;
  from?: TelegramSender & { is_bot?: boolean };
  chat: { id: number; type: string };
  text?: string;
  voice?: { file_id: string; duration: number };
}
interface TgCallback {
  id: string;
  from: TelegramSender;
  data?: string;
  message?: { message_id: number; chat: { id: number; type: string } };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

/** The job queued for real work, re-checked when it runs. */
export interface TelegramJob {
  updateId: number;
  telegramUserId: number;
  chatId: number;
  kind: "message" | "callback";
  text?: string;
  voiceFileId?: string;
  callbackId?: string;
  callbackData?: string;
  messageId?: number;
}

/** True the first time an update ID is seen. The record expires after a day (TTL on expireAt). */
async function firstTime(updateId: number): Promise<boolean> {
  try {
    await db().collection(COLLECTIONS.telegramUpdates).doc(String(updateId)).create({ expireAt: Timestamp.fromMillis(Date.now() + 86_400_000) });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 6 /* ALREADY_EXISTS */) return false;
    throw err;
  }
}

async function strangerReply(chatId: number, telegramUserId: number) {
  try {
    await consume("telegramStranger", String(telegramUserId));
    await sendMessage(chatId, escapeHtml(STRANGER));
  } catch {
    /* rate limited: stay quiet */
  }
}

export async function handleTelegramUpdate(update: TgUpdate): Promise<string> {
  if (!(await firstTime(update.update_id))) return "duplicate";

  const cb = update.callback_query;
  if (cb) {
    if (cb.message?.chat.type !== "private") return "ignored: not private";
    const person = await resolveSender(cb.from.id);
    if (!person) {
      await answerCallback(cb.id, "This chat isn't linked to an AgentGig team.");
      return "stranger";
    }
    await answerCallback(cb.id, "On it…");
    await queue({ updateId: update.update_id, telegramUserId: cb.from.id, chatId: cb.message.chat.id, kind: "callback", callbackId: cb.id, callbackData: cb.data, messageId: cb.message.message_id }, person);
    return "callback queued";
  }

  const m = update.message;
  if (!m?.from || m.from.is_bot) return "ignored";
  if (m.chat.type !== "private") return "ignored: not private";
  const text = m.text?.trim();

  if (text?.startsWith("/start")) {
    const code = text.slice(6).trim();
    if (code && isLinkCode(code)) {
      const linked = await redeemLinkCode(code, m.from, m.chat.id);
      if (!linked) {
        await sendMessage(m.chat.id, escapeHtml("That link has expired or was already used. Make a new one on the Team page at agentgig.si."));
        return "link failed";
      }
      await sendMessage(
        m.chat.id,
        `You're connected to <b>${escapeHtml(linked.businessName)}</b> as ${linked.role === "owner" ? "the owner" : `a ${linked.role}`}.\n\n` +
          `I'm ${SUPERVISOR_NAME}, your team lead. Tell me what you need, type or send a voice note, and I'll hand it to the right agent. ` +
          `Drafts that need an OK come here with buttons.\n\nOnly you see this chat. Send /stop to disconnect.`,
      );
      return "linked";
    }
    const person = await resolveSender(m.from.id);
    if (person) await post(m.chat.id, SUPERVISOR_NAME, "Hi again. What can the team do for you?");
    else await strangerReply(m.chat.id, m.from.id);
    return person ? "hello" : "stranger";
  }

  const person = await resolveSender(m.from.id);
  if (!person) {
    await strangerReply(m.chat.id, m.from.id);
    return "stranger";
  }
  if (text === "/stop") {
    await unlinkTelegram(person.uid);
    await sendMessage(m.chat.id, escapeHtml("Disconnected. You can link again any time from the Team page."));
    return "unlinked";
  }
  if (text === "/help") {
    await post(m.chat.id, SUPERVISOR_NAME, "Just tell me what you need, like \"chase late invoices\" or \"what's in stock?\". You can also send a voice note. /stop disconnects this chat.");
    return "help";
  }
  if (!text && !m.voice) {
    await post(m.chat.id, SUPERVISOR_NAME, "I can read text and listen to voice notes. Files still go through agentgig.si for now.");
    return "unsupported";
  }
  try {
    await consume("telegramPerUser", person.uid);
  } catch (err) {
    if (isGatewayError(err)) await post(m.chat.id, SUPERVISOR_NAME, err.message);
    return "rate limited";
  }
  await sendTyping(m.chat.id);
  await queue({ updateId: update.update_id, telegramUserId: m.from.id, chatId: m.chat.id, kind: "message", text, voiceFileId: m.voice?.file_id, messageId: m.message_id }, person);
  return "queued";
}

async function queue(job: TelegramJob, person: LinkedPerson) {
  await enqueue({ key: `tg-${job.updateId}`, userId: person.accountId, agentId: "supervisor", input: {}, origin: "event", telegram: job });
}

/* ------------------------------------------------------------------ */
/* The queued job                                                      */
/* ------------------------------------------------------------------ */

export async function runTelegramJob(job: TelegramJob): Promise<string> {
  // Checked again: the person may have left the team since the message arrived.
  const person = await resolveSender(job.telegramUserId);
  if (!person || person.link.chatId !== job.chatId) return "sender no longer linked";
  try {
    if (job.kind === "callback") return await onButton(person, job);
    const pending = person.link.pendingEdit;
    if (pending && job.text && !job.text.startsWith("/") && Date.now() - pending.at.toMillis() < EDIT_MINUTES * 60_000) {
      await setPendingEdit(person.uid, null);
      const res = await resolveApproval(person.accountId, pending.approvalId, { action: "approve", editedText: job.text });
      await post(job.chatId, SUPERVISOR_NAME, res.status === "delivered" ? `Sent your version. ${res.delivery?.summary ?? ""}`.trim() : "Done.");
      await saveTurn(person, { role: "person", text: job.text });
      return "edited";
    }
    const voice = job.voiceFileId ? await downloadFile(job.voiceFileId) : undefined;
    await handlePersonMessage(person, { text: job.text, voice });
    return "answered";
  } catch (err) {
    log("WARNING", "telegram.job_failed", { component: "telegram", kind: job.kind, error: err instanceof Error ? err.message : String(err) });
    await post(job.chatId, SUPERVISOR_NAME, isGatewayError(err) ? err.message : "Something went wrong on my side. Try again in a minute.").catch(() => undefined);
    return "failed";
  }
}

async function onButton(person: LinkedPerson, job: TelegramJob): Promise<string> {
  const match = /^ap:([A-Za-z0-9]{10,40}):([aes])$/.exec(job.callbackData ?? "");
  if (!match) return "unknown button";
  const [, approvalId, choice] = match;
  if (!hasRole(person.role, "manager")) {
    await post(job.chatId, SUPERVISOR_NAME, "Only an owner or manager can decide on drafts.");
    return "forbidden";
  }
  if (choice === "e") {
    await setPendingEdit(person.uid, approvalId);
    await post(job.chatId, SUPERVISOR_NAME, "Send me the new text and I'll send that version instead.");
    return "awaiting edit";
  }
  try {
    // resolveApproval checks the approval belongs to this account.
    const res = await resolveApproval(person.accountId, approvalId, { action: choice === "a" ? "approve" : "skip" });
    if (job.messageId) await clearButtons(job.chatId, job.messageId);
    await post(job.chatId, SUPERVISOR_NAME, res.status === "delivered" ? `Approved. ${res.delivery?.summary ?? ""}`.trim() : "Skipped. Nothing was sent.");
    return res.status;
  } catch (err) {
    if (isGatewayError(err) && err.code === "ALREADY_SETTLED") {
      if (job.messageId) await clearButtons(job.chatId, job.messageId);
      await post(job.chatId, SUPERVISOR_NAME, "Someone already decided on that one.");
      return "already settled";
    }
    throw err;
  }
}
