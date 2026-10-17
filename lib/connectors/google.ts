import "server-only";
import { db } from "@/lib/firebase-admin";
import { COLLECTIONS } from "@/types/firestore";
import { getConnection } from "./index";
import { accessToken } from "./tokens";

const SHEET_TITLE = "AgentGig spend log";

async function google(userId: string) {
  const conn = await getConnection(userId, "google");
  if (!conn) return null;
  return { conn, token: await accessToken(conn) };
}

async function call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Where a reply belongs: the Gmail thread and the Message-ID header of the email being answered. */
export interface GmailReplyTo {
  threadId: string;
  messageId: string;
}

export interface GmailOutgoing {
  to?: string | null;
  subject: string;
  body: string;
  replyTo?: GmailReplyTo | null;
  /** Display name on the From line (the connected address stays the sender). */
  fromName?: string | null;
}

const encodeWord = (s: string) => `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;

function rawMessage(mail: GmailOutgoing, fromAddress: string | null) {
  const r = mail.replyTo;
  const headers = [
    mail.fromName && fromAddress ? `From: ${encodeWord(mail.fromName)} <${fromAddress}>` : null,
    mail.to ? `To: ${mail.to}` : null,
    r ? `In-Reply-To: ${r.messageId}` : null,
    r ? `References: ${r.messageId}` : null,
    `Subject: ${encodeWord(mail.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ]
    .filter(Boolean)
    .join("\r\n");
  return Buffer.from(`${headers}\r\n\r\n${Buffer.from(mail.body).toString("base64")}`).toString("base64url");
}

/** Creates a Gmail draft (never sends), threaded under the email it answers when given. Null if Google isn't connected. */
export async function gmailCreateDraft(userId: string, mail: GmailOutgoing) {
  const g = await google(userId);
  if (!g) return null;
  const raw = rawMessage(mail, mail.fromName ? await googleSelf(userId) : null);
  const draft = await call<{ id: string; message: { id: string } }>(g.token, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw, ...(mail.replyTo && { threadId: mail.replyTo.threadId }) } }),
  });
  return { draftId: draft.id, url: `https://mail.google.com/mail/u/0/#drafts?compose=${draft.message.id}` };
}

/** Sends an email from the connected Gmail, in the thread it answers when given. Only after the owner approved it. */
export async function gmailSend(userId: string, mail: GmailOutgoing & { to: string }) {
  const g = await google(userId);
  if (!g) return null;
  const raw = rawMessage(mail, mail.fromName ? await googleSelf(userId) : null);
  const sent = await call<{ id: string; threadId: string }>(g.token, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, ...(mail.replyTo && { threadId: mail.replyTo.threadId }) }),
  });
  return { messageId: sent.id, url: `https://mail.google.com/mail/u/0/#sent/${sent.id}` };
}

/* ---------- Gmail inbox ---------- */

/** Asks Gmail to publish inbox changes to our Pub/Sub topic. Lasts 7 days; renewed daily. */
export async function gmailWatch(userId: string, topicName: string): Promise<{ email: string; historyId: string; expiration: number } | null> {
  const g = await google(userId);
  if (!g) return null;
  const w = await call<{ historyId: string; expiration: string }>(g.token, "https://gmail.googleapis.com/gmail/v1/users/me/watch", {
    method: "POST",
    body: JSON.stringify({ topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" }),
  });
  const me = await call<{ emailAddress: string }>(g.token, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
  return { email: me.emailAddress.toLowerCase(), historyId: w.historyId, expiration: Number(w.expiration) };
}

/** IDs of messages added to the inbox since a history ID, and the mailbox's latest history ID. */
export async function gmailInboxSince(userId: string, startHistoryId: string): Promise<{ messageIds: string[]; historyId: string } | null> {
  const g = await google(userId);
  if (!g) return null;
  const ids = new Set<string>();
  let historyId = startHistoryId;
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", labelId: "INBOX", ...(pageToken && { pageToken }) });
    const page = await call<{ history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId: string; nextPageToken?: string }>(
      g.token,
      `https://gmail.googleapis.com/gmail/v1/users/me/history?${q}`,
    );
    for (const h of page.history ?? []) for (const m of h.messagesAdded ?? []) if (m.message.labelIds?.includes("INBOX")) ids.add(m.message.id);
    historyId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { messageIds: [...ids], historyId };
}

export interface GmailMessage {
  id: string;
  threadId: string;
  /** The Message-ID header, for threading a reply. */
  messageId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  text: string;
  labelIds: string[];
}

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };

function plainText(part: GmailPart): string {
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  }
  return "";
}

export async function gmailRead(userId: string, id: string): Promise<GmailMessage | null> {
  const g = await google(userId);
  if (!g) return null;
  const m = await call<{ id: string; threadId: string; labelIds?: string[]; payload: GmailPart & { headers?: { name: string; value: string }[] } }>(
    g.token,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
  );
  const header = (n: string) => m.payload.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  const from = header("from");
  const fromEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  return {
    id: m.id,
    threadId: m.threadId,
    messageId: header("message-id"),
    fromName: from.replace(/<[^>]+>/, "").replace(/"/g, "").trim(),
    fromEmail,
    subject: header("subject"),
    text: plainText(m.payload).trim(),
    labelIds: m.labelIds ?? [],
  };
}

export const GMAIL_LABEL = "AgentGig";

/** Labels an email "AgentGig" so the owner can see which emails an agent picked up. */
export async function gmailLabelHandled(userId: string, id: string): Promise<void> {
  const g = await google(userId);
  if (!g) return;
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";
  const { labels } = await call<{ labels: { id: string; name: string }[] }>(g.token, `${base}/labels`);
  const label =
    labels.find((l) => l.name === GMAIL_LABEL) ??
    (await call<{ id: string; name: string }>(g.token, `${base}/labels`, { method: "POST", body: JSON.stringify({ name: GMAIL_LABEL }) }));
  await call(g.token, `${base}/messages/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [label.id] }) });
}

/** Appends a row to the owner's spend log sheet, creating the sheet on first use. */
export async function sheetsAppendRow(userId: string, row: (string | number)[]) {
  const g = await google(userId);
  if (!g) return null;
  let sheetId = g.conn.meta?.spendSheetId as string | undefined;
  if (!sheetId) {
    const created = await call<{ spreadsheetId: string }>(g.token, "https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      body: JSON.stringify({ properties: { title: SHEET_TITLE }, sheets: [{ properties: { title: "Invoices" } }] }),
    });
    sheetId = created.spreadsheetId;
    await call(g.token, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Invoices!A1:append?valueInputOption=RAW`, {
      method: "POST",
      body: JSON.stringify({ values: [["Date", "Supplier", "Invoice", "Net", "VAT", "Total", "Currency", "Status", "Logged"]] }),
    });
    await db().collection(COLLECTIONS.connections).doc(g.conn.id).set({ meta: { spendSheetId: sheetId } }, { merge: true });
  }
  await call(g.token, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Invoices!A1:append?valueInputOption=USER_ENTERED`, {
    method: "POST",
    body: JSON.stringify({ values: [row] }),
  });
  return { url: `https://docs.google.com/spreadsheets/d/${sheetId}` };
}

/* ---------- Drive (invoice folder trigger) ---------- */

export const DRIVE_FOLDER = "AgentGig Invoices";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
}

/** Finds (or creates) the owner's invoice folder and lists files in it. */
export async function driveListInvoices(userId: string): Promise<{ folderId: string; files: DriveFile[] } | null> {
  const g = await google(userId);
  if (!g) return null;
  let folderId = g.conn.meta?.invoiceFolderId as string | undefined;
  if (!folderId) {
    const q = encodeURIComponent(`name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await call<{ files: { id: string }[] }>(g.token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
    folderId =
      found.files[0]?.id ??
      (
        await call<{ id: string }>(g.token, "https://www.googleapis.com/drive/v3/files", {
          method: "POST",
          body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: "application/vnd.google-apps.folder" }),
        })
      ).id;
    await db().collection(COLLECTIONS.connections).doc(g.conn.id).set({ meta: { invoiceFolderId: folderId } }, { merge: true });
  }
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and (mimeType='application/pdf' or mimeType contains 'image/')`);
  const list = await call<{ files: DriveFile[] }>(
    g.token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=50&fields=files(id,name,mimeType,createdTime)`,
  );
  return { folderId, files: list.files };
}

export async function driveDownload(userId: string, fileId: string): Promise<Buffer | null> {
  const g = await google(userId);
  if (!g) return null;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { authorization: `Bearer ${g.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Drive download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ---------- Calendar ---------- */

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  description: string | null;
  attendees: { email: string; name: string | null }[];
  meetLink: string | null;
}

/** Events on the owner's primary calendar between two instants, external meetings only (with attendees). */
export async function calendarEvents(userId: string, from: Date, to: Date): Promise<CalendarEvent[] | null> {
  const g = await google(userId);
  if (!g) return null;
  const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "25" });
  const data = await call<{
    items: {
      id: string;
      summary?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      location?: string;
      description?: string;
      hangoutLink?: string;
      attendees?: { email: string; displayName?: string; self?: boolean; resource?: boolean }[];
    }[];
  }>(g.token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  return data.items
    .filter((e) => e.start.dateTime && (e.attendees ?? []).some((a) => !a.self && !a.resource))
    .map((e) => ({
      id: e.id,
      title: e.summary ?? "(no title)",
      start: e.start.dateTime!,
      end: e.end.dateTime ?? e.start.dateTime!,
      location: e.location ?? null,
      description: e.description?.slice(0, 2000) ?? null,
      attendees: (e.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => ({ email: a.email, name: a.displayName ?? null })),
      meetLink: e.hangoutLink ?? null,
    }));
}

/**
 * Creates a Google Doc from simple HTML (Drive converts it on upload). Uses the
 * drive.file scope, so AgentGig can only see files it created.
 */
export async function docsCreate(userId: string, title: string, html: string): Promise<{ id: string; url: string } | null> {
  const g = await google(userId);
  if (!g) return null;
  const boundary = `agentgig${Date.now().toString(36)}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name: title, mimeType: "application/vnd.google-apps.document" }),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    `--${boundary}--`,
  ].join("\r\n");
  const file = await call<{ id: string; webViewLink: string }>(g.token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return { id: file.id, url: file.webViewLink };
}

/** The connected Google account's address, for drafts the owner sends to themselves. */
export async function googleSelf(userId: string): Promise<string | null> {
  const conn = await getConnection(userId, "google");
  return conn?.accountLabel.split("·").pop()?.trim() || null;
}
