import "server-only";
import { db } from "@/lib/firebase-admin";
import { COLLECTIONS } from "@/types/firestore";
import { getConnection } from "./index";
import { accessToken } from "./tokens";

const SHEET_TITLE = "AgentExchange spend log";

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

/** Creates a Gmail draft (never sends). Returns null if Google isn't connected. */
export async function gmailCreateDraft(userId: string, mail: { to?: string | null; subject: string; body: string }) {
  const g = await google(userId);
  if (!g) return null;
  const headers = [mail.to ? `To: ${mail.to}` : null, `Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString("base64")}?=`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"]
    .filter(Boolean)
    .join("\r\n");
  const raw = Buffer.from(`${headers}\r\n\r\n${Buffer.from(mail.body).toString("base64")}`).toString("base64url");
  const draft = await call<{ id: string; message: { id: string } }>(g.token, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw } }),
  });
  return { draftId: draft.id, url: `https://mail.google.com/mail/u/0/#drafts?compose=${draft.message.id}` };
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

export const DRIVE_FOLDER = "AgentExchange Invoices";

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
