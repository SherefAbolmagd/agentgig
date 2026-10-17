import { deliverEmail, emailSummary, notDelivered, type Delivery, type EmailOutcome } from "@/lib/connectors";
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

/**
 * Delivers approved emails: sent, or saved as Gmail or Outlook drafts,
 * depending on the account's setting. Not delivered if no email is connected.
 */
export async function deliverDrafts(userId: string, emails: DraftEmail[], what: string): Promise<Delivery> {
  if (!emails.length) return { delivered: true, summary: `No ${what} needed` };
  const links: { label: string; url: string }[] = [];
  const results: EmailOutcome[] = [];
  for (const e of emails) {
    const r = await deliverEmail(userId, { to: e.to, subject: e.subject, body: e.body });
    if (!r) return notDelivered(`${emails.length} ${what} ready. Connect Google or Microsoft 365 to save them as email drafts.`);
    results.push(r);
    links.push({ label: `${r.sent ? "Sent" : "Draft"} · ${e.label}`, url: r.url });
  }
  return { delivered: true, summary: emailSummary(results, `${links.length} ${what}`), links };
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
