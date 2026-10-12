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

interface Channel {
  source: string;
  currency: string;
  gross: number;
  refunds: number;
  count: number;
  disputes: number;
  changePct: number | null;
}

export function RevenueResult({ o }: { o: Out }) {
  // Results from before Square and PayPal were added held Stripe figures at the top level.
  const channels: Channel[] =
    (o.channels as Channel[] | undefined) ??
    [{ source: "Stripe", currency: String(o.currency ?? ""), gross: Number(o.grossThisPeriod ?? 0), refunds: Number(o.refunds ?? 0), count: Number(o.chargeCount ?? 0), disputes: 0, changePct: (o.changePct as number | null) ?? null }];
  const stripe = (o.stripe as { overdueInvoices: unknown[]; failedPayments: unknown[]; activeSubscriptions: number; mrr: number; currency: string } | null | undefined) ??
    (Array.isArray(o.overdueInvoices) ? { overdueInvoices: o.overdueInvoices as unknown[], failedPayments: (o.failedPayments as unknown[]) ?? [], activeSubscriptions: Number(o.activeSubscriptions ?? 0), mrr: Number(o.mrr ?? 0), currency: String(o.currency) } : null);
  return (
    <div className="grid gap-3">
      <p className="text-sm font-medium">{String(o.headline ?? "")}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {channels.map((c) => (
          <div key={c.source} className="rounded-lg border bg-background p-3">
            <p className="text-xs text-muted-foreground">{c.source}</p>
            <p className="font-display text-lg font-bold">{amount(c.gross, c.currency)}</p>
            <p className="text-xs text-muted-foreground">
              {c.count} payments{c.changePct !== null && ` · ${c.changePct > 0 ? "+" : ""}${c.changePct}%`}
              {c.refunds > 0 && ` · ${amount(c.refunds, c.currency)} refunded`}
              {c.disputes > 0 && ` · ${c.disputes} open dispute${c.disputes > 1 ? "s" : ""}`}
            </p>
          </div>
        ))}
        {stripe && (
          <div className="rounded-lg border bg-background p-3">
            <p className="text-xs text-muted-foreground">Needs chasing</p>
            <p className="font-display text-lg font-bold">{stripe.overdueInvoices.length + stripe.failedPayments.length}</p>
            <p className="text-xs text-muted-foreground">
              MRR {amount(stripe.mrr, stripe.currency)} · {stripe.activeSubscriptions} subscriptions
            </p>
          </div>
        )}
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
  const system = ({ xero: "Xero", quickbooks: "QuickBooks", freshbooks: "FreshBooks", sage: "Sage" } as Record<string, string>)[String(o.system)] ?? "your accounting software";
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

const STAGE_TONE: Record<string, string> = { friendly: "text-muted-foreground", firm: "text-token", final: "font-semibold text-destructive" };

export function InvoiceChaserResult({ o }: { o: Out }) {
  const chasing = (o.chasing as { key: string; number: string | null; customer: string; amountDue: number; currency: string; daysOverdue: number; stage: string; url: string }[]) ?? [];
  const noEmail = (o.noEmail as { key: string; customer: string; number: string | null }[]) ?? [];
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        {o.currency ? `${amount(o.totalOverdue, o.currency)} overdue in total.` : "Nothing overdue."}
        {Number(o.recentlyChased) > 0 && ` ${o.recentlyChased} invoice(s) were chased in the last week and are left alone.`}
      </p>
      {chasing.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Owed</TableHead>
                <TableHead className="text-right">Days late</TableHead>
                <TableHead>Tone</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chasing.map((c) => (
                <TableRow key={c.key}>
                  <TableCell>
                    {c.customer}
                    <a href={c.url} target="_blank" rel="noreferrer" className="block text-xs text-primary hover:underline">
                      {c.number ? `Invoice ${c.number}` : "Open invoice"}
                    </a>
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{amount(c.amountDue, c.currency)}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{c.daysOverdue}</TableCell>
                  <TableCell className={cn("text-xs capitalize", STAGE_TONE[c.stage])}>{c.stage}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {noEmail.length > 0 && <p className="text-xs text-muted-foreground">No email in your books for: {noEmail.map((n) => n.customer).join(", ")}. Add one to chase them.</p>}
      <EmailsResult emails={(o.emails as Email[]) ?? []} empty="No reminders needed today." />
    </div>
  );
}

export function QuoteResult({ o }: { o: Out }) {
  const lines = (o.lines as { description: string; quantity: number; unitPrice: number; amount: number; fromPriceList: boolean }[]) ?? [];
  const cur = o.currency;
  const text = [
    String(o.intro ?? ""),
    "",
    ...lines.map((l) => `• ${l.description}: ${l.quantity} × ${amount(l.unitPrice, cur)} = ${amount(l.amount, cur)}`),
    "",
    `Subtotal ${amount(o.subtotal, cur)} · VAT (${o.vatRate}%) ${amount(o.vat, cur)} · Total ${amount(o.total, cur)}`,
  ].join("\n");
  return (
    <div className="grid gap-3">
      <p className="text-sm">{String(o.intro ?? "")}</p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Each</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="font-mono text-[13px]">
            {lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell className="font-sans">
                  {l.description}
                  {!l.fromPriceList && <span className="ml-2 rounded bg-token-soft px-1.5 py-0.5 text-[10px] font-semibold text-token">Estimate</span>}
                </TableCell>
                <TableCell className="text-right">{l.quantity}</TableCell>
                <TableCell className="text-right">{amount(l.unitPrice, cur)}</TableCell>
                <TableCell className="text-right">{amount(l.amount, cur)}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell colSpan={3} className="text-right font-sans text-muted-foreground">Subtotal · VAT {String(o.vatRate)}%</TableCell>
              <TableCell className="text-right">{amount(o.subtotal, cur)} · {amount(o.vat, cur)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell colSpan={3} className="text-right font-sans font-semibold">Total</TableCell>
              <TableCell className="text-right font-semibold">{amount(o.total, cur)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      {((o.assumptions as string[]) ?? []).length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Assumes</p>
          <ul className="list-disc pl-5 text-muted-foreground">{(o.assumptions as string[]).map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
      {((o.questions as string[]) ?? []).length > 0 && (
        <div className="text-sm">
          <p className="font-medium">To confirm with the customer</p>
          <ul className="list-disc pl-5 text-muted-foreground">{(o.questions as string[]).map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <CopyButton text={text} label="Copy quote" /> Ref {String(o.reference)} · valid until {String(o.validUntil)}
      </div>
    </div>
  );
}

export function CashflowResult({ o }: { o: Out }) {
  const weeks = (o.weeks as { weekStart: string; moneyIn: number; moneyOut: number; closing: number; notes: string[] }[]) ?? [];
  const cur = o.currency;
  const max = Math.max(1, ...weeks.map((w) => Math.abs(w.closing)));
  return (
    <div className="grid gap-3">
      <p className="text-sm font-medium">{String(o.headline ?? "")}</p>
      <p className="text-sm text-muted-foreground">{String(o.explanation ?? "")}</p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Week of</TableHead>
              <TableHead className="text-right">In</TableHead>
              <TableHead className="text-right">Out</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="w-32" aria-label="Balance bar" />
            </TableRow>
          </TableHeader>
          <TableBody className="font-mono text-[13px]">
            {weeks.map((w) => (
              <TableRow key={w.weekStart} className={cn(w.closing < 0 && "bg-destructive-soft/60")}>
                <TableCell className="font-sans text-xs">
                  {w.weekStart}
                  {w.notes.length > 0 && <span className="block text-muted-foreground">{w.notes.join(", ")}</span>}
                </TableCell>
                <TableCell className="text-right">{amount(w.moneyIn, cur)}</TableCell>
                <TableCell className="text-right">{amount(w.moneyOut, cur)}</TableCell>
                <TableCell className={cn("text-right", w.closing < 0 && "font-semibold text-destructive")}>{amount(w.closing, cur)}</TableCell>
                <TableCell>
                  <span className={cn("block h-2 rounded-full", w.closing < 0 ? "bg-destructive" : "bg-primary")} style={{ width: `${Math.max(4, (Math.abs(w.closing) / max) * 100)}%` }} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="grid list-disc gap-1 pl-5 text-sm">{((o.suggestions as string[]) ?? []).map((x) => <li key={x}>{x}</li>)}</ul>
      <p className="text-xs text-muted-foreground">
        Based on: {((o.sources as string[]) ?? []).join("; ") || "the figures you entered"}.
        {((o.skippedCostLines as string[]) ?? []).length > 0 && ` Couldn't read: ${(o.skippedCostLines as string[]).join(" | ")}`}
      </p>
    </div>
  );
}

const REQ_TONE: Record<string, string> = { covered: "bg-accent text-accent-foreground", partly: "bg-token-soft text-token", gap: "bg-destructive-soft text-destructive" };

export function ProposalResult({ o }: { o: Out }) {
  const reqs = (o.requirements as { requirement: string; status: string; answeredIn: string }[]) ?? [];
  const sections = (o.sections as { heading: string; body: string }[]) ?? [];
  const questions = (o.questionsForOwner as string[]) ?? [];
  return (
    <div className="grid gap-4">
      <p className="text-sm">
        <b className="font-medium">{String(o.title)}</b> · {String(o.wordCount)} words{o.wordLimit ? ` of ${o.wordLimit}` : ""}
      </p>
      <ul className="grid gap-1.5 text-sm">
        {reqs.map((r, i) => (
          <li key={i} className="flex gap-2">
            <span className={cn("h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", REQ_TONE[r.status])}>{r.status}</span>
            <span className="min-w-0">
              {r.requirement}
              {r.answeredIn && <span className="text-muted-foreground"> → {r.answeredIn}</span>}
            </span>
          </li>
        ))}
      </ul>
      {questions.length > 0 && (
        <div className="rounded-lg bg-token-soft/60 p-3 text-sm">
          <p className="font-medium">Needed from you</p>
          <ul className="list-disc pl-5">{questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </div>
      )}
      <article className="grid gap-3 rounded-xl border bg-background p-4 text-sm">
        {sections.map((s) => (
          <section key={s.heading} className="grid gap-1">
            <h4 className="font-display font-bold">{s.heading}</h4>
            <p className="whitespace-pre-line text-muted-foreground">{s.body}</p>
          </section>
        ))}
      </article>
    </div>
  );
}

export function ReviewRequestResult({ o }: { o: Out }) {
  const s = (o.skipped as { refunded: number; noConsent: number; askedRecently: number }) ?? { refunded: 0, noConsent: 0, askedRecently: 0 };
  const parts = [s.refunded && `${s.refunded} refunded`, s.noConsent && `${s.noConsent} without marketing consent`, s.askedRecently && `${s.askedRecently} asked in the last 90 days`].filter(Boolean);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        From {String(o.source)}, linking to {String(o.reviewUrl)}.{parts.length > 0 && ` Skipped: ${parts.join(", ")}.`}
      </p>
      <EmailsResult emails={(o.emails as Email[]) ?? []} empty="No delivered orders to ask about in this window." />
    </div>
  );
}

const MET_TONE: Record<string, string> = { yes: "text-primary", partly: "text-token", no: "text-destructive", unclear: "text-muted-foreground" };

export function HiringResult({ o }: { o: Out }) {
  if (o.mode === "advert") {
    const list = (title: string, items: unknown) =>
      (items as string[])?.length ? (
        <div>
          <p className="font-medium">{title}</p>
          <ul className="list-disc pl-5 text-muted-foreground">{(items as string[]).map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      ) : null;
    const text = [o.title, "", o.summary, "", "What you'll do:", ...(o.responsibilities as string[]).map((x) => `• ${x}`), "", "What you need:", ...(o.requirements as string[]).map((x) => `• ${x}`), ...((o.niceToHave as string[]).length ? ["", "Nice to have:", ...(o.niceToHave as string[]).map((x) => `• ${x}`)] : []), ...((o.offer as string[]).length ? ["", "What we offer:", ...(o.offer as string[]).map((x) => `• ${x}`)] : []), "", o.howToApply].join("\n");
    return (
      <div className="grid gap-3">
        <article className="grid gap-3 rounded-xl border bg-background p-4 text-sm">
          <h4 className="font-display text-lg font-bold">{String(o.title)}</h4>
          <p>{String(o.summary)}</p>
          {list("What you'll do", o.responsibilities)}
          {list("What you need", o.requirements)}
          {list("Nice to have", o.niceToHave)}
          {list("What we offer", o.offer)}
          <p>{String(o.howToApply)}</p>
        </article>
        {((o.languageNotes as string[]) ?? []).length > 0 && <p className="text-xs text-muted-foreground">Wording changes: {(o.languageNotes as string[]).join(" · ")}</p>}
        <CopyButton text={text} label="Copy advert" />
      </div>
    );
  }
  const criteria = (o.criteria as { criterion: string; mustHave: boolean; met: string; evidence: string }[]) ?? [];
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        <b className="font-medium">{String(o.candidateLabel)}</b> · {String(o.mustHavesMet)} of {String(o.mustHavesTotal)} must-haves clearly met · {String(o.suggestion)}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Criterion</TableHead>
              <TableHead>Met</TableHead>
              <TableHead>Evidence from the CV</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {criteria.map((c, i) => (
              <TableRow key={i}>
                <TableCell className="text-sm">
                  {c.criterion}
                  <span className="block text-xs text-muted-foreground">{c.mustHave ? "Must-have" : "Nice to have"}</span>
                </TableCell>
                <TableCell className={cn("text-xs font-semibold capitalize", MET_TONE[c.met])}>{c.met}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{c.evidence}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="text-sm">
        <p className="font-medium">Ask at interview</p>
        <ul className="list-disc pl-5 text-muted-foreground">{((o.interviewQuestions as string[]) ?? []).map((q) => <li key={q}>{q}</li>)}</ul>
      </div>
    </div>
  );
}

export function DeadlineResult({ o }: { o: Out }) {
  const items = (o.deadlines as { date: string; what: string; detail: string; daysLeft: number; source: string }[]) ?? [];
  if (!items.length) return <p className="text-sm text-muted-foreground">Nothing due in the next {String(o.lookAheadDays)} days.</p>;
  return (
    <div className="grid gap-2">
      {!!o.company && <p className="text-sm text-muted-foreground">Company: {String(o.company)}</p>}
      <ul className="grid gap-1.5">
        {items.map((d, i) => (
          <li key={i} className={cn("flex flex-wrap items-baseline gap-x-3 rounded-lg border bg-background px-3 py-2 text-sm", d.daysLeft <= 14 && "border-destructive/40")}>
            <span className="w-24 shrink-0 font-mono text-[13px]">{d.date}</span>
            <span className="min-w-0 flex-1">
              <b className="font-medium">{d.what}</b> <span className="text-muted-foreground">· {d.detail}</span>
            </span>
            <span className={cn("text-xs", d.daysLeft <= 14 ? "font-semibold text-destructive" : "text-muted-foreground")}>
              {d.daysLeft === 0 ? "today" : `${d.daysLeft} days`} · {d.source}
            </span>
          </li>
        ))}
      </ul>
      {((o.skippedLines as string[]) ?? []).length > 0 && <p className="text-xs text-muted-foreground">Couldn&apos;t read: {(o.skippedLines as string[]).join(" | ")}</p>}
    </div>
  );
}

export function MeetingResult({ o }: { o: Out }) {
  const actions = (o.actions as { owner: string; task: string; due: string }[]) ?? [];
  return (
    <div className="grid gap-3">
      <p className="text-sm">{String(o.summary ?? "")}</p>
      {((o.decisions as string[]) ?? []).length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Decided</p>
          <ul className="list-disc pl-5 text-muted-foreground">{(o.decisions as string[]).map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
      )}
      {actions.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Who</TableHead>
                <TableHead>Does what</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.map((a, i) => (
                <TableRow key={i}>
                  <TableCell className="text-sm font-medium">{a.owner}</TableCell>
                  <TableCell className="text-sm">{a.task}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{a.due}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {((o.openQuestions as string[]) ?? []).length > 0 && <p className="text-sm text-muted-foreground">Still open: {(o.openQuestions as string[]).join(" · ")}</p>}
      <EmailsResult emails={((o.followUps as { to: string; subject: string; body: string }[]) ?? []).map((f) => ({ label: f.to, subject: f.subject, body: f.body }))} empty="No follow-ups needed." />
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { reminder: "Reminders", thank_you: "Thank-yous", missed: "Missed", cancelled: "Cancelled" };

export function BookingAssistantResult({ o }: { o: Out }) {
  const counts = (o.counts as Record<string, number>) ?? {};
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        From {((o.sources as string[]) ?? []).join(", ")}: {Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${KIND_LABEL[k].toLowerCase()}`).join(", ") || "nothing new"}.
        {Number(o.alreadySent) > 0 && ` ${o.alreadySent} already handled.`}
        {Number(o.noEmail) > 0 && ` ${o.noEmail} without a customer email.`}
      </p>
      <EmailsResult emails={(o.emails as Email[]) ?? []} empty="No booking emails needed today." />
    </div>
  );
}

export function DealNudgerResult({ o }: { o: Out }) {
  const deals = (o.deals as { id: string; title: string; stage: string | null; value: number | null; currency: string | null; company: string | null; daysQuiet: number; url: string; nextStep: string | null; hasEmail: boolean }[]) ?? [];
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {deals.length} of {String(o.totalOpen)} open deals in {String(o.system)} have gone quiet.
      </p>
      {deals.length > 0 && (
        <ul className="grid gap-1.5">
          {deals.map((d) => (
            <li key={d.id} className="grid gap-0.5 rounded-lg border bg-background px-3 py-2 text-sm">
              <p className="flex flex-wrap items-baseline justify-between gap-2">
                <a href={d.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                  {d.title}
                </a>
                <span className="text-xs text-muted-foreground">
                  {d.stage ?? "No stage"} · {d.daysQuiet} days quiet{d.value ? ` · ${d.currency ? amount(d.value, d.currency) : d.value}` : ""}
                </span>
              </p>
              {d.nextStep && <p className="text-muted-foreground">Next: {d.nextStep}</p>}
              {!d.hasEmail && <p className="text-xs text-muted-foreground">No contact email in your CRM, so no draft.</p>}
            </li>
          ))}
        </ul>
      )}
      <EmailsResult emails={(o.emails as Email[]) ?? []} empty="No nudges needed." />
    </div>
  );
}

const CATEGORY_LABEL: Record<string, string> = { quote_request: "Quote request", question: "Question", booking: "Booking", complaint: "Complaint", job_application: "Job application", supplier_pitch: "Supplier pitch", spam: "Spam", other: "Other" };

export function EnquiryResult({ o }: { o: Out }) {
  const entries = (o.entries as { key: string; form: string; name: string | null; category: string; urgent: boolean; summary: string; hasEmail: boolean }[]) ?? [];
  return (
    <div className="grid gap-3">
      {entries.length > 0 && (
        <ul className="grid gap-1.5">
          {entries.map((e) => (
            <li key={e.key} className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border bg-background px-3 py-2 text-sm", e.urgent && "border-destructive/40")}>
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", e.urgent ? "bg-destructive-soft text-destructive" : "bg-secondary text-muted-foreground")}>{CATEGORY_LABEL[e.category] ?? e.category}</span>
              <span className="min-w-0 flex-1">{e.summary}</span>
              <span className="text-xs text-muted-foreground">
                {e.name ?? "Anonymous"} · {e.form}
              </span>
            </li>
          ))}
        </ul>
      )}
      <EmailsResult emails={(o.emails as Email[]) ?? []} empty="No new enquiries." />
    </div>
  );
}
