import { gmailCreateDraft, notDelivered, type Delivery } from "@/lib/connectors";

export interface DraftEmail {
  to: string | null;
  subject: string;
  body: string;
  /** Who it's for, shown in the result and links. */
  label: string;
}

/** Saves emails as Gmail drafts (never sends). Not delivered if Google isn't connected. */
export async function deliverDrafts(userId: string, emails: DraftEmail[], what: string): Promise<Delivery> {
  if (!emails.length) return { delivered: true, summary: `No ${what} needed` };
  const links: { label: string; url: string }[] = [];
  for (const e of emails) {
    const draft = await gmailCreateDraft(userId, { to: e.to, subject: e.subject, body: e.body });
    if (!draft) return notDelivered(`${emails.length} ${what} ready. Connect Google to save them as Gmail drafts.`);
    links.push({ label: `Draft · ${e.label}`, url: draft.url });
  }
  return { delivered: true, summary: `${links.length} ${what} saved as Gmail drafts. Nothing was sent.`, links };
}
