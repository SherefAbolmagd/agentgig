import { z } from "zod";
import { gmailCreateDraft, notDelivered, type Delivery } from "@/lib/connectors";
import { companyFilings, type CompanyFilings } from "@/lib/connectors/companies-house";
import { googleSelf } from "@/lib/connectors/google";
import { GatewayError } from "@/lib/errors";
import { defineAgent } from "./types";

/**
 * Deadline Keeper: UK filing and payment deadlines worked out by rules (no AI):
 * Companies House accounts and confirmation statement (live from the public
 * API), Corporation Tax, VAT returns, PAYE, plus the owner's own dates.
 */

export const DeadlineInput = z.object({
  /** Falls back to the company number in the business profile. */
  companyNumber: z.string().trim().toUpperCase().regex(/^([0-9]{8}|[A-Z]{2}[0-9]{6})$/).optional(),
  vatQuarters: z.enum(["none", "jan-apr-jul-oct", "feb-may-aug-nov", "mar-jun-sep-dec", "monthly"]).default("none"),
  payroll: z.boolean().default(false),
  /** One per line: "Insurance renewal, 2026-12-01". */
  otherDates: z.string().trim().max(3000).default(""),
  lookAheadDays: z.number().int().min(7).max(365).default(90),
});
export type DeadlineInput = z.infer<typeof DeadlineInput>;

export interface Deadline {
  date: string;
  what: string;
  detail: string;
  daysLeft: number;
  source: "Companies House" | "HMRC" | "You";
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const lastDay = (y: number, m: number) => utc(y, m + 1, 0);

const QUARTER_ENDS: Record<string, number[]> = {
  "jan-apr-jul-oct": [0, 3, 6, 9],
  "feb-may-aug-nov": [1, 4, 7, 10],
  "mar-jun-sep-dec": [2, 5, 8, 11],
  monthly: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** All deadlines from `today` to `today + days`, soonest first. */
export function ukDeadlines(today: Date, days: number, opts: { company?: CompanyFilings | null; vatQuarters: string; payroll: boolean; otherDates: string }): { deadlines: Deadline[]; skipped: string[] } {
  const start = utc(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const end = new Date(start.getTime() + days * 86_400_000);
  const out: Omit<Deadline, "daysLeft">[] = [];
  const c = opts.company;
  if (c?.accountsDue) out.push({ date: c.accountsDue, what: "File annual accounts", detail: `${c.name} at Companies House`, source: "Companies House" });
  if (c?.confirmationDue) out.push({ date: c.confirmationDue, what: "File confirmation statement", detail: `${c.name} at Companies House (£50 fee online)`, source: "Companies House" });
  if (c?.accountsMadeUpTo) {
    const [y, m, d] = c.accountsMadeUpTo.split("-").map(Number);
    // Corporation Tax: pay 9 months and 1 day after the period ends; file the CT600 within 12 months.
    out.push({ date: iso(utc(y, m - 1 + 9, d + 1)), what: "Pay Corporation Tax", detail: `For the period ending ${c.accountsMadeUpTo}`, source: "HMRC" });
    out.push({ date: iso(utc(y + 1, m - 1, d)), what: "File Corporation Tax return (CT600)", detail: `For the period ending ${c.accountsMadeUpTo}`, source: "HMRC" });
  }
  if (opts.vatQuarters !== "none") {
    // VAT return and payment: 1 calendar month and 7 days after the period ends.
    for (let y = start.getUTCFullYear() - 1; y <= end.getUTCFullYear(); y++) {
      for (const m of QUARTER_ENDS[opts.vatQuarters]) {
        const periodEnd = lastDay(y, m);
        const due = lastDay(y, m + 1);
        due.setUTCDate(due.getUTCDate() + 7);
        out.push({ date: iso(due), what: "Submit VAT return and pay", detail: `Period ending ${iso(periodEnd)}`, source: "HMRC" });
      }
    }
  }
  if (opts.payroll) {
    // PAYE and NI paid electronically: by the 22nd of the following tax month.
    for (let i = -1; i <= Math.ceil(days / 28) + 1; i++) {
      const d = utc(start.getUTCFullYear(), start.getUTCMonth() + i, 22);
      out.push({ date: iso(d), what: "Pay PAYE and National Insurance", detail: "For the tax month ending on the 5th", source: "HMRC" });
    }
  }
  const skipped: string[] = [];
  for (const line of opts.otherDates.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(.+?),\s*(\d{4}-\d{2}-\d{2})$/);
    if (m && !Number.isNaN(Date.parse(m[2]))) out.push({ date: m[2], what: m[1], detail: "Your own reminder", source: "You" });
    else skipped.push(line);
  }
  const deadlines = out
    .map((d) => ({ ...d, daysLeft: Math.round((Date.parse(d.date) - start.getTime()) / 86_400_000) }))
    .filter((d) => d.daysLeft >= 0 && Date.parse(d.date) <= end.getTime())
    .sort((a, b) => a.date.localeCompare(b.date) || a.what.localeCompare(b.what));
  return { deadlines, skipped };
}

export type DeadlineOutput = { company: string | null; lookAheadDays: number; deadlines: Deadline[]; urgent: number; skippedLines: string[] };

export const deadlineKeeper = defineAgent<DeadlineInput, DeadlineOutput>({
  slug: "deadline-keeper",
  skillId: "deadlines.track",
  tier: "flash",
  inputSchema: DeadlineInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding }) {
    const number = input.companyNumber ?? grounding.profile?.companyNumber;
    const company = number ? await companyFilings(number) : null;
    if (!company && input.vatQuarters === "none" && !input.payroll && !input.otherDates) {
      throw new GatewayError("INVALID_INPUT", "Add your Companies House number, VAT quarters, payroll or your own dates so there's something to track.");
    }
    const { deadlines, skipped } = ukDeadlines(new Date(), input.lookAheadDays, { company, vatQuarters: input.vatQuarters, payroll: input.payroll, otherDates: input.otherDates });
    return {
      output: { company: company ? `${company.name} (${company.status})` : null, lookAheadDays: input.lookAheadDays, deadlines, urgent: deadlines.filter((d) => d.daysLeft <= 14).length, skippedLines: skipped },
      model: "rules",
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      notes: [company ? `Read ${company.name} from Companies House` : "No company number, so Companies House dates were skipped"],
    };
  },

  approval(o) {
    const next = o.deadlines[0];
    return {
      title: o.urgent ? `${o.urgent} deadline${o.urgent > 1 ? "s" : ""} in the next 2 weeks` : next ? `Next deadline: ${next.what} on ${next.date}` : `Nothing due in the next ${o.lookAheadDays} days`,
      preview: o.deadlines.slice(0, 3).map((d) => `${d.date} ${d.what}`).join(" · "),
      severity: o.urgent ? "check" : "info",
      actions: [
        { id: "approve", label: "Email me the list", kind: "approve" },
        { id: "skip", label: "Not needed", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    if (!o.deadlines.length) return { delivered: true, summary: "Nothing due" };
    const body = [
      `Deadlines in the next ${o.lookAheadDays} days${o.company ? ` for ${o.company}` : ""}:`,
      "",
      ...o.deadlines.map((d) => `${d.date} (${d.daysLeft} days) — ${d.what}. ${d.detail}. [${d.source}]`),
      "",
      "Worked out from Companies House records and standard HMRC rules. Check HMRC or your accountant if your circumstances are unusual.",
    ].join("\n");
    const draft = await gmailCreateDraft(userId, { to: await googleSelf(userId), subject: o.urgent ? `${o.urgent} deadline(s) in the next 2 weeks` : "Upcoming business deadlines", body });
    if (!draft) return notDelivered("Deadlines listed in AgentGig. Connect Google to get them by email.");
    return { delivered: true, summary: "Deadline list saved as a Gmail draft to yourself", links: [{ label: "Open draft", url: draft.url }] };
  },
});
