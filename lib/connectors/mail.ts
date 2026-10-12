import "server-only";
import { calendarEvents, gmailCreateDraft, googleSelf, type CalendarEvent } from "./google";
import { microsoftSelf, outlookCreateDraft, outlookEvents } from "./microsoft";

/**
 * Email and calendar wherever the owner works: Gmail/Google Calendar if Google
 * is connected, otherwise Outlook through Microsoft 365.
 */

export const EMAIL_TOOLS = "Google or Microsoft 365";

/** Saves a draft (never sends) in Gmail or Outlook. Null if neither is connected. */
export async function createEmailDraft(userId: string, mail: { to?: string | null; subject: string; body: string }): Promise<{ draftId: string; url: string; app: "Gmail" | "Outlook" } | null> {
  const gmail = await gmailCreateDraft(userId, mail);
  if (gmail) return { ...gmail, app: "Gmail" };
  const outlook = await outlookCreateDraft(userId, mail);
  return outlook ? { ...outlook, app: "Outlook" } : null;
}

/** The owner's own address on whichever email account is connected. */
export async function selfAddress(userId: string): Promise<string | null> {
  return (await googleSelf(userId)) ?? (await microsoftSelf(userId));
}

/** External meetings from Google Calendar or Outlook. Null if neither is connected. */
export async function meetings(userId: string, from: Date, to: Date): Promise<CalendarEvent[] | null> {
  return (await calendarEvents(userId, from, to)) ?? (await outlookEvents(userId, from, to));
}
