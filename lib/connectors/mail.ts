import "server-only";
import { db } from "@/lib/firebase-admin";
import { COLLECTIONS, type UserDoc } from "@/types/firestore";
import { calendarEvents, gmailCreateDraft, gmailSend, googleSelf, type CalendarEvent, type GmailReplyTo } from "./google";
import { microsoftSelf, outlookCreateDraft, outlookEvents } from "./microsoft";

/**
 * Email and calendar wherever the owner works: Gmail/Google Calendar if Google
 * is connected, otherwise Outlook through Microsoft 365.
 */

export const EMAIL_TOOLS = "Google or Microsoft 365";

/** Saves a draft (never sends) in Gmail or Outlook. Null if neither is connected. */
export async function createEmailDraft(userId: string, mail: { to?: string | null; subject: string; body: string; replyTo?: GmailReplyTo | null }): Promise<{ draftId: string; url: string; app: "Gmail" | "Outlook" } | null> {
  const gmail = await gmailCreateDraft(userId, mail);
  if (gmail) return { ...gmail, app: "Gmail" };
  const outlook = await outlookCreateDraft(userId, { to: mail.to, subject: mail.subject, body: mail.body });
  return outlook ? { ...outlook, app: "Outlook" } : null;
}

export interface EmailOutcome {
  url: string;
  app: "Gmail" | "Outlook";
  /** True when it went out; false when it's waiting as a draft. */
  sent: boolean;
}

/**
 * Delivers an email the owner approved: sent from Gmail when the account's
 * setting says "send it" (Company knowledge → Connections), otherwise saved
 * as a draft. Emails with no recipient, and Outlook ones, are always drafts.
 * Null if no email account is connected.
 */
export async function deliverEmail(userId: string, mail: { to?: string | null; subject: string; body: string; replyTo?: GmailReplyTo | null }): Promise<EmailOutcome | null> {
  const user = (await db().collection(COLLECTIONS.users).doc(userId).get()).data() as UserDoc | undefined;
  const fromName = user?.businessName ?? null;
  if (user?.emailOnApprove === "send" && mail.to) {
    const sent = await gmailSend(userId, { ...mail, to: mail.to, fromName });
    if (sent) return { url: sent.url, app: "Gmail", sent: true };
  }
  const gmail = await gmailCreateDraft(userId, { ...mail, fromName });
  if (gmail) return { url: gmail.url, app: "Gmail", sent: false };
  const outlook = await outlookCreateDraft(userId, { to: mail.to, subject: mail.subject, body: mail.body });
  return outlook ? { url: outlook.url, app: "Outlook", sent: false } : null;
}

/** "Sent from Gmail" or "Saved as a draft in Gmail. Nothing was sent." for a delivery summary. */
export function emailSummary(results: EmailOutcome[], what: string): string {
  const sent = results.filter((r) => r.sent).length;
  const app = results[0]?.app ?? "email";
  if (sent === results.length) return `${capital(what)} sent from ${app}.`;
  if (!sent) return `${capital(what)} saved as ${results.length > 1 ? "drafts" : "a draft"} in ${app}. Nothing was sent.`;
  return `${sent} sent from ${app}, ${results.length - sent} saved as drafts.`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The owner's own address on whichever email account is connected. */
export async function selfAddress(userId: string): Promise<string | null> {
  return (await googleSelf(userId)) ?? (await microsoftSelf(userId));
}

/** External meetings from Google Calendar or Outlook. Null if neither is connected. */
export async function meetings(userId: string, from: Date, to: Date): Promise<CalendarEvent[] | null> {
  return (await calendarEvents(userId, from, to)) ?? (await outlookEvents(userId, from, to));
}
