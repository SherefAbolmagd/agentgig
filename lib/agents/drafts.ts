import { createEmailDraft, notDelivered, type Delivery } from "@/lib/connectors";
import { createTasks, type NewTask } from "@/lib/connectors/tasks";
import { z } from "zod";

/** The email a task came from (email trigger), so the answer is drafted as a reply in its thread. */
export const EmailSource = z.object({
  threadId: z.string().max(64),
  messageId: z.string().max(300),
  subject: z.string().max(300),
  fromName: z.string().max(120),
});
export type EmailSource = z.infer<typeof EmailSource>;

export const reSubject = (subject: string) => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`);

export interface DraftEmail {
  to: string | null;
  subject: string;
  body: string;
  /** Who it's for, shown in the result and links. */
  label: string;
}

/** Saves emails as Gmail or Outlook drafts (never sends). Not delivered if neither is connected. */
export async function deliverDrafts(userId: string, emails: DraftEmail[], what: string): Promise<Delivery> {
  if (!emails.length) return { delivered: true, summary: `No ${what} needed` };
  const links: { label: string; url: string }[] = [];
  let app = "email";
  for (const e of emails) {
    const draft = await createEmailDraft(userId, { to: e.to, subject: e.subject, body: e.body });
    if (!draft) return notDelivered(`${emails.length} ${what} ready. Connect Google or Microsoft 365 to save them as email drafts.`);
    app = draft.app;
    links.push({ label: `Draft · ${e.label}`, url: draft.url });
  }
  return { delivered: true, summary: `${links.length} ${what} saved as ${app} drafts. Nothing was sent.`, links };
}

/** Adds tasks to the owner's board (Trello, Asana or Notion), or null if none is connected. */
export async function deliverTasks(userId: string, tasks: NewTask[]): Promise<Delivery | null> {
  const made = await createTasks(userId, tasks);
  if (!made) return null;
  return { delivered: true, summary: `${made.count} task${made.count === 1 ? "" : "s"} added to ${made.tool}`, links: made.url ? [{ label: `Open ${made.tool}`, url: made.url }] : [] };
}

/** Merges several deliveries into one: delivered if any part was. */
export function combine(parts: (Delivery | null)[]): Delivery {
  const real = parts.filter((p): p is Delivery => p !== null);
  const done = real.filter((p) => p.delivered);
  if (!done.length) return real[0] ?? notDelivered("Nothing to deliver");
  return { delivered: true, summary: done.map((p) => p.summary).join(" "), links: done.flatMap((p) => (p.links as { label: string; url: string }[] | undefined) ?? []) };
}
