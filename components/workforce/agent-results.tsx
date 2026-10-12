"use client";
import { useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { money } from "@/lib/client/format";
import { cn } from "@/lib/utils";

type Out = Record<string, unknown>;

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          /* clipboard blocked; the text is still selectable */
        }
      }}
    >
      {done ? <Check /> : <Copy />} {done ? "Copied" : label}
    </Button>
  );
}

/** Links and summary from the Deliver step, e.g. "Open Gmail draft". */
export function DeliveryLinks({ delivery }: { delivery?: Out }) {
  if (!delivery) return null;
  const links = (delivery.links as { label: string; url: string }[] | undefined) ?? [];
  const summary = delivery.summary as string | undefined;
  if (!summary && !links.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm", delivery.delivered === false || delivery.simulated === true ? "bg-token-soft text-token" : "bg-accent text-accent-foreground")}>
      <span>{summary}</span>
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline">
          {l.label} <ExternalLink className="size-3.5" />
        </a>
      ))}
    </div>
  );
}

export function ReplyResult({ o, kind }: { o: Out; kind: "dm" | "review" | "order" }) {
  const reply = String(o.reply ?? "");
  const flagged = kind === "review" ? !!o.urgent : !!o.needsHuman;
  return (
    <div className="grid gap-3">
      {flagged && (
        <div className="flex gap-2 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{kind === "review" ? String(o.internalNote ?? "") : `Needs you: ${String(o.reason ?? "")}`}</span>
        </div>
      )}
      {kind === "order" && (
        <p className="whitespace-pre-line rounded-lg bg-secondary px-3 py-2 font-mono text-xs">{o.orderSummary ? String(o.orderSummary) : "No matching order found."}</p>
      )}
      <blockquote className="whitespace-pre-line rounded-lg border bg-background p-4 text-sm">{reply}</blockquote>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <CopyButton text={reply} label="Copy reply" />
        {kind === "dm" && <span>Confidence {Math.round(Number(o.confidence ?? 0) * 100)}% · {String(o.category ?? "").replace(/_/g, " ")}</span>}
        {kind === "review" && (
          <span>
            {String(o.sentiment)} · {(o.themes as string[] | undefined)?.join(", ")}
          </span>
        )}
        {kind === "review" && !o.urgent && !!o.internalNote && <span>Note: {String(o.internalNote)}</span>}
      </div>
    </div>
  );
}

interface Stock {
  sku: string;
  name: string;
  onHand: number;
  perDay: number;
  daysOfCover: number | null;
  reorderQty: number;
  reorderCost: number | null;
  supplier: string;
}

export function InventoryResult({ o }: { o: Out }) {
  const products = (o.products as Stock[]) ?? [];
  const emails = (o.emails as { supplier: string; to: string | null; subject: string; body: string }[]) ?? [];
  return (
    <div className="grid gap-3">
      <p className="text-sm">{String(o.summary ?? "")}</p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Per day</TableHead>
              <TableHead className="text-right">Days left</TableHead>
              <TableHead className="text-right">Order</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="font-mono text-[13px]">
            {products.map((p) => (
              <TableRow key={p.sku} className={cn(p.reorderQty > 0 && "bg-token-soft/50")}>
                <TableCell className="font-sans">
                  {p.name}
                  <span className="block text-xs text-muted-foreground">{p.supplier}</span>
                </TableCell>
                <TableCell className="text-right">{p.onHand}</TableCell>
                <TableCell className="text-right">{p.perDay}</TableCell>
                <TableCell className={cn("text-right", p.reorderQty > 0 && "font-semibold text-destructive")}>{p.daysOfCover ?? "–"}</TableCell>
                <TableCell className="text-right">{p.reorderQty ? `${p.reorderQty}${p.reorderCost !== null ? ` · ${money(p.reorderCost)}` : ""}` : "–"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {emails.map((e) => (
        <details key={e.supplier} className="rounded-lg border bg-background p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Order email · {e.supplier}
            {e.to && <span className="font-normal text-muted-foreground"> · {e.to}</span>}
          </summary>
          <p className="mt-2 font-medium">{e.subject}</p>
          <p className="mt-1 whitespace-pre-line text-muted-foreground">{e.body}</p>
        </details>
      ))}
    </div>
  );
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function RotaResult({ o }: { o: Out }) {
  const assignments = (o.assignments as { day: string; shift: string; start: string; end: string; staff: string[] }[]) ?? [];
  const violations = (o.violations as string[]) ?? [];
  const hours = (o.hoursByPerson as Record<string, number>) ?? {};
  const shifts = [...new Set(assignments.map((a) => `${a.shift}|${a.start}–${a.end}`))];
  const days = DAYS.filter((d) => assignments.some((a) => a.day === d));
  return (
    <div className="grid gap-3">
      {violations.length > 0 ? (
        <ul className="grid gap-1 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          {violations.map((v) => (
            <li key={v} className="flex gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {v}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
          <Check className="size-4" /> Every shift is covered and nobody is over their hours or on a day off.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shift</TableHead>
              {days.map((d) => (
                <TableHead key={d}>{d}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shifts.map((key) => {
              const [name, time] = key.split("|");
              return (
                <TableRow key={key}>
                  <TableCell className="whitespace-nowrap text-sm font-medium">
                    {name}
                    <span className="block font-mono text-xs text-muted-foreground">{time}</span>
                  </TableCell>
                  {days.map((d) => (
                    <TableCell key={d} className="text-sm">
                      {assignments.find((a) => a.day === d && a.shift === name)?.staff.join(", ") ?? "–"}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Hours: {Object.entries(hours).map(([n, h]) => `${n} ${h}h`).join(" · ")}. {String(o.notes ?? "")}
      </p>
    </div>
  );
}

export function OnboardingResult({ o }: { o: Out }) {
  const email = o.welcomeEmail as { subject: string; body: string } | undefined;
  const week = (o.firstWeek as { day: string; task: string; owner: string }[]) ?? [];
  const docs = (o.documentsToCollect as string[]) ?? [];
  const faq = (o.policyAnswers as { question: string; answer: string }[]) ?? [];
  return (
    <div className="grid gap-3 text-sm">
      {email && (
        <div className="rounded-lg border bg-background p-4">
          <p className="font-semibold">{email.subject}</p>
          <p className="mt-2 whitespace-pre-line">{email.body}</p>
          <div className="mt-3">
            <CopyButton text={`${email.subject}\n\n${email.body}`} label="Copy email" />
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">First week</p>
          <ul className="grid gap-1.5">
            {week.map((w, i) => (
              <li key={i}>
                <span className="font-medium">{w.day}:</span> {w.task} <span className="text-xs text-muted-foreground">({w.owner})</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Documents to collect</p>
          <ul className="grid list-disc gap-1 pl-4">
            {docs.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      </div>
      {faq.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">From your handbook</p>
          {faq.map((f) => (
            <p key={f.question} className="mb-1.5">
              <span className="font-medium">{f.question}</span> {f.answer}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

const amount = (n: unknown, currency: unknown) => {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: String(currency || "GBP").toUpperCase() }).format(Number(n ?? 0));
  } catch {
    return `${Number(n ?? 0).toFixed(2)} ${String(currency ?? "")}`;
  }
};

interface Email {
  label: string;
  subject: string;
  body: string;
}

/** Drafted emails, one card each, with copy buttons. */
export function EmailsResult({ emails, empty }: { emails: Email[]; empty: string }) {
  if (!emails.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="grid gap-2">
      {emails.map((e, i) => (
        <li key={i} className="grid gap-2 rounded-lg border bg-background p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0">
              <span className="text-muted-foreground">To {e.label}: </span>
              <b className="font-medium">{e.subject}</b>
            </p>
            <CopyButton text={`${e.subject}\n\n${e.body}`} label="Copy" />
          </div>
          <p className="whitespace-pre-line text-muted-foreground">{e.body}</p>
        </li>
      ))}
    </ul>
  );
}

export function WinbackResult({ o }: { o: Out }) {
  const skipped = Number(o.skippedNoConsent ?? 0);
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        From {String(o.source ?? "your store")}: {(o.customers as unknown[] | undefined)?.length ?? 0} lapsed customers chosen
        {skipped > 0 && `, ${skipped} skipped because they didn't agree to marketing emails`}.
      </p>
      <EmailsResult emails={(o.emails as Email[]) ?? []} empty="Nobody matched, so no emails were drafted." />
    </div>
  );
}

export function RevenueResult({ o }: { o: Out }) {
  const cur = o.currency;
  const change = o.changePct as number | null;
  const tiles: [string, string, string?][] = [
    [`Last ${o.periodDays} days`, amount(o.grossThisPeriod, cur), change === null ? undefined : `${change > 0 ? "+" : ""}${change}% on the period before`],
    ["Refunds", amount(o.refunds, cur)],
    ["MRR", amount(o.mrr, cur), `${o.activeSubscriptions} active subscriptions`],
    ["Needs chasing", `${(o.overdueInvoices as unknown[]).length + (o.failedPayments as unknown[]).length}`, "overdue invoices and failed payments"],
  ];
  return (
    <div className="grid gap-3">
      <p className="text-sm font-medium">{String(o.headline ?? "")}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([label, value, hint]) => (
          <div key={label} className="rounded-lg border bg-background p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="font-display text-lg font-bold">{value}</p>
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          </div>
        ))}
      </div>
      <ul className="grid list-disc gap-1 pl-5 text-sm">
        {((o.observations as string[]) ?? []).map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <EmailsResult emails={(o.reminders as Email[]) ?? []} empty="Nobody to remind this time." />
    </div>
  );
}

export function NewsletterResult({ o }: { o: Out }) {
  const sections = (o.sections as { heading: string; body: string }[]) ?? [];
  return (
    <article className="grid max-w-xl gap-3 rounded-xl border bg-background p-4 text-sm">
      <header>
        <p className="font-semibold">{String(o.subject ?? "")}</p>
        <p className="text-xs text-muted-foreground">{String(o.previewText ?? "")}</p>
      </header>
      {sections.map((s) => (
        <section key={s.heading} className="grid gap-1">
          <h4 className="font-display font-bold">{s.heading}</h4>
          <p className="whitespace-pre-line text-muted-foreground">{s.body}</p>
        </section>
      ))}
      {!!o.ctaUrl && <span className="justify-self-start rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">{String(o.ctaLabel ?? "")}</span>}
    </article>
  );
}

export function LeadResult({ o }: { o: Out }) {
  return <EmailsResult emails={(o.emails as Email[]) ?? []} empty="No new leads with an email address in this period." />;
}

interface Bill {
  key: string;
  supplier: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  currency: string;
  total: number;
  problem: string | null;
}

export function BookkeeperResult({ o }: { o: Out }) {
  const toBook = (o.toBook as Bill[]) ?? [];
  const held = (o.heldBack as Bill[]) ?? [];
  const system = o.system === "xero" ? "Xero" : "QuickBooks";
  const rows = [...toBook.map((b) => ({ ...b, held: false })), ...held.map((b) => ({ ...b, held: true }))];
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        {toBook.length} to book in {system}
        {held.length > 0 && `, ${held.length} held back`}
        {Number(o.alreadyBooked) > 0 && `, ${o.alreadyBooked} already booked earlier`}.
      </p>
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.key}>
                  <TableCell>
                    {b.supplier}
                    {b.invoiceNumber && <span className="block text-xs text-muted-foreground">#{b.invoiceNumber}</span>}
                  </TableCell>
                  <TableCell className="text-xs">{b.issueDate ?? "–"}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{amount(b.total, b.currency)}</TableCell>
                  <TableCell className={cn("text-xs", b.held && "text-destructive")}>{b.held ? `Held back: ${b.problem}` : "Ready"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function BookingResult({ o }: { o: Out }) {
  const meetings = (o.meetings as { title: string; start: string; who: string; purpose: string; talkingPoints: string[]; ask: string; link: string | null }[]) ?? [];
  if (!meetings.length) return <p className="text-sm text-muted-foreground">No meetings with outside people on {String(o.day)}.</p>;
  return (
    <ul className="grid gap-2">
      {meetings.map((m, i) => (
        <li key={i} className="grid gap-1.5 rounded-lg border bg-background p-3 text-sm">
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <b className="font-medium">{m.title}</b>
            <span className="text-xs text-muted-foreground">{new Date(m.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
          </p>
          <p className="text-xs text-muted-foreground">With {m.who}</p>
          <p>{m.purpose}</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {m.talkingPoints.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p>
            <span className="text-muted-foreground">Ask: </span>
            {m.ask}
          </p>
          {m.link && (
            <a href={m.link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              <ExternalLink className="size-3" /> Join link
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
