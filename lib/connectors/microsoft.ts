import "server-only";
import { getConnection } from "./index";
import { vendorFetch } from "./keys";
import { accessToken } from "./tokens";
import type { CalendarEvent } from "./google";

/** Microsoft Graph for Microsoft 365 owners: Outlook drafts and calendar. */

async function graph(userId: string) {
  const conn = await getConnection(userId, "microsoft");
  if (!conn) return null;
  return { conn, token: await accessToken(conn) };
}

/** Saves a draft in Outlook (never sends). Null if Microsoft 365 isn't connected. */
export async function outlookCreateDraft(userId: string, mail: { to?: string | null; subject: string; body: string }): Promise<{ draftId: string; url: string } | null> {
  const g = await graph(userId);
  if (!g) return null;
  const msg = await vendorFetch<{ id: string; webLink: string }>("Outlook", "https://graph.microsoft.com/v1.0/me/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subject: mail.subject,
      body: { contentType: "Text", content: mail.body },
      toRecipients: mail.to ? [{ emailAddress: { address: mail.to } }] : [],
    }),
  });
  return { draftId: msg.id, url: msg.webLink };
}

/** The connected Microsoft account's address. */
export async function microsoftSelf(userId: string): Promise<string | null> {
  const conn = await getConnection(userId, "microsoft");
  return (conn?.meta?.email as string | undefined) ?? null;
}

/** Meetings with at least one attendee outside the owner's email domain. */
export async function outlookEvents(userId: string, from: Date, to: Date): Promise<CalendarEvent[] | null> {
  const g = await graph(userId);
  if (!g) return null;
  const own = String(g.conn.meta?.email ?? "").split("@")[1]?.toLowerCase();
  const params = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $select: "id,subject,start,end,location,attendees,bodyPreview,onlineMeeting,isCancelled",
    $orderby: "start/dateTime",
    $top: "50",
  });
  const res = await vendorFetch<{
    value: {
      id: string;
      location: { displayName?: string } | null;
      subject: string;
      start: { dateTime: string };
      end: { dateTime: string };
      isCancelled: boolean;
      bodyPreview: string;
      onlineMeeting: { joinUrl?: string } | null;
      attendees: { emailAddress: { name?: string; address?: string } }[];
    }[];
  }>("Outlook", `https://graph.microsoft.com/v1.0/me/calendarView?${params}`, {
    headers: { authorization: `Bearer ${g.token}`, prefer: 'outlook.timezone="UTC"' },
  });
  return res.value
    .filter((e) => !e.isCancelled)
    .map((e) => ({
      id: e.id,
      title: e.subject || "(no title)",
      location: e.location?.displayName || null,
      start: `${e.start.dateTime.slice(0, 19)}Z`,
      end: `${e.end.dateTime.slice(0, 19)}Z`,
      description: e.bodyPreview || null,
      meetLink: e.onlineMeeting?.joinUrl ?? null,
      attendees: e.attendees
        .map((a) => ({ email: (a.emailAddress.address ?? "").toLowerCase(), name: a.emailAddress.name ?? null }))
        .filter((a) => a.email && a.email.split("@")[1] !== own),
    }))
    .filter((e) => e.attendees.length > 0);
}
