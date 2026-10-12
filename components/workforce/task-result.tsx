"use client";
import { AlertTriangle, CheckCircle2, ChevronDown, Info, XCircle } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  BookingResult,
  BookkeeperResult,
  DeliveryLinks,
  InventoryResult,
  LeadResult,
  NewsletterResult,
  OnboardingResult,
  ReplyResult,
  RevenueResult,
  RotaResult,
  WinbackResult,
} from "./agent-results";

const NATIVE_VIEWS = new Set([
  "echosocial",
  "receipthero",
  "dm-concierge",
  "reviewpulse",
  "inventory-guardian",
  "rotabuilder",
  "onboarding-buddy",
  "order-desk",
  "winback",
  "revenue-pulse",
  "newsletter-writer",
  "lead-followup",
  "bookkeeper",
  "booking-prep",
]);
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { money, STATUS, TONE_CLASSES } from "@/lib/client/format";
import type { WithId } from "@/lib/client/firestore";
import { cn } from "@/lib/utils";
import type { TaskDoc } from "@/types/firestore";

type Task = WithId<TaskDoc> & { delivery?: Record<string, unknown> };

export function TaskResult({ task, businessName }: { task: Task | null; businessName: string }) {
  if (!task) return <p className="p-8 text-center text-sm text-muted-foreground">Run a task to see the agent&apos;s work here.</p>;
  const status = STATUS[task.status];

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE_CLASSES[status.tone])}>{status.label}</span>
        {task.settlement === "charged" && <span className="text-muted-foreground">{task.cost} tokens charged</span>}
        {task.settlement === "released" && <span className="text-muted-foreground">{task.cost} tokens returned to your balance</span>}
        {task.dlpFindings.length > 0 && (
          <span className="text-muted-foreground">
            · removed {task.dlpFindings.map((f) => `${f.count} ${f.infoType.toLowerCase().replace(/_/g, " ")}`).join(", ")}
          </span>
        )}
      </div>

      {task.error && (
        <div className="flex gap-3 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          <p>{task.error.message}</p>
        </div>
      )}

      {task.output && task.agentId === "echosocial" && <LinkedInPreview task={task} businessName={businessName} />}
      {task.output && task.agentId === "receipthero" && <InvoiceAudit output={task.output as unknown as Invoice} />}
      {task.output && !NATIVE_VIEWS.has(task.agentId) && Array.isArray(task.output.heldBack) && <VatSummary output={task.output as unknown as Vat} />}
      {task.output && task.agentId === "dm-concierge" && <ReplyResult o={task.output} kind="dm" />}
      {task.output && task.agentId === "reviewpulse" && <ReplyResult o={task.output} kind="review" />}
      {task.output && task.agentId === "inventory-guardian" && <InventoryResult o={task.output} />}
      {task.output && task.agentId === "rotabuilder" && <RotaResult o={task.output} />}
      {task.output && task.agentId === "onboarding-buddy" && <OnboardingResult o={task.output} />}
      {task.output && task.agentId === "order-desk" && <ReplyResult o={task.output} kind="order" />}
      {task.output && task.agentId === "winback" && <WinbackResult o={task.output} />}
      {task.output && task.agentId === "revenue-pulse" && <RevenueResult o={task.output} />}
      {task.output && task.agentId === "newsletter-writer" && <NewsletterResult o={task.output} />}
      {task.output && task.agentId === "lead-followup" && <LeadResult o={task.output} />}
      {task.output && task.agentId === "bookkeeper" && <BookkeeperResult o={task.output} />}
      {task.output && task.agentId === "booking-prep" && <BookingResult o={task.output} />}
      <DeliveryLinks delivery={task.delivery} />
      {task.output && !NATIVE_VIEWS.has(task.agentId) && !Array.isArray(task.output.heldBack) && typeof task.output.summary === "string" && (
        <p className="rounded-lg border bg-background p-4 text-sm whitespace-pre-line">{task.output.summary}</p>
      )}

      {task.output && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
            <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" /> Structured output (JSON)
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-secondary p-3 font-mono text-xs">{JSON.stringify(task.output, null, 2)}</pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function LinkedInPreview({ task, businessName }: { task: Task; businessName: string }) {
  const o = task.output as { text: string; characterCount: number; scheduledFor: string; timeZone?: string; editedByOwner?: boolean };
  const when = new Date(o.scheduledFor).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: o.timeZone });
  const state =
    task.status === "awaiting_approval" ? "Waiting for your approval" : task.status === "delivered" ? `Scheduled ${when}` : task.status === "discarded" ? "Skipped" : "";
  const [body, tagLine] = splitHashtags(o.text);
  const initials = businessName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <article className="max-w-xl rounded-xl border bg-background p-4 text-sm">
      <header className="mb-3 flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-md bg-foreground font-display text-xs font-bold text-background">{initials}</span>
        <div>
          <p className="font-semibold">{businessName}</p>
          <p className="text-xs text-muted-foreground">Company page · {state}</p>
        </div>
      </header>
      <p className="whitespace-pre-line">{body}</p>
      {tagLine && <p className="mt-3 font-medium text-primary">{tagLine}</p>}
      <footer className="mt-3 flex flex-wrap gap-3 border-t pt-2 text-xs text-muted-foreground">
        <span>{o.characterCount} characters</span>
        {o.editedByOwner && <span>Edited by you · EchoSocial will learn from it</span>}
      </footer>
    </article>
  );
}

function splitHashtags(text: string): [string, string] {
  const lines = text.trimEnd().split("\n");
  const last = lines.at(-1) ?? "";
  return /^(#\w+\s*)+$/.test(last.trim()) ? [lines.slice(0, -1).join("\n").trimEnd(), last] : [text, ""];
}

interface Invoice {
  vendor: { name: string; taxId: string | null };
  invoiceNumber: string | null;
  currency: string;
  lineItems: { description: string; quantity: number; unitPrice: number; amount: number }[];
  subtotal: number | null;
  taxRate: number | null;
  taxAmount: number | null;
  totalPrinted: number;
  calculatedTotal: number;
  flags: { code: string; severity: "high" | "medium" | "low"; message: string }[];
}

function InvoiceAudit({ output: o }: { output: Invoice }) {
  const c = o.currency;
  const serious = o.flags.filter((f) => f.severity !== "low");
  return (
    <div className="grid gap-3">
      {serious.length === 0 && (
        <Flag tone="good" icon={<CheckCircle2 />} title={`${o.invoiceNumber ?? "Receipt"} from ${o.vendor.name} adds up`} text={`Total ${money(o.totalPrinted, c)} matches the items${o.taxAmount ? " and tax" : ""}.`} />
      )}
      {o.flags.map((f) => (
        <Flag
          key={f.code + f.message}
          tone={f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "info"}
          icon={f.severity === "low" ? <Info /> : <AlertTriangle />}
          title={FLAG_TITLES[f.code] ?? f.code}
          text={f.message}
        />
      ))}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="font-mono text-[13px]">
            {o.lineItems.map((l, i) => (
              <TableRow key={i}>
                <TableCell className="font-sans">{l.description}</TableCell>
                <TableCell className="text-right">{l.quantity}</TableCell>
                <TableCell className="text-right">{money(l.unitPrice, c)}</TableCell>
                <TableCell className="text-right">{money(l.amount, c)}</TableCell>
              </TableRow>
            ))}
            {o.taxAmount !== null && (
              <TableRow>
                <TableCell className="font-sans" colSpan={3}>
                  Tax{o.taxRate ? ` ${Math.round(o.taxRate * 100)}%` : ""}
                </TableCell>
                <TableCell className="text-right">{money(o.taxAmount, c)}</TableCell>
              </TableRow>
            )}
            <TableRow>
              <TableCell className="font-sans font-semibold" colSpan={3}>
                Should be
              </TableCell>
              <TableCell className="text-right font-semibold">{money(o.calculatedTotal, c)}</TableCell>
            </TableRow>
            <TableRow className={cn(o.calculatedTotal !== o.totalPrinted && "text-destructive")}>
              <TableCell className="font-sans" colSpan={3}>
                Invoice says
              </TableCell>
              <TableCell className="text-right">{money(o.totalPrinted, c)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

const FLAG_TITLES: Record<string, string> = {
  TOTAL_MISMATCH: "The total doesn't add up",
  SUBTOTAL_MISMATCH: "The subtotal doesn't match the items",
  LINE_MATH: "A line is miscalculated",
  TAX_MISMATCH: "The tax looks wrong",
  DUPLICATE_INVOICE: "You may have seen this invoice before",
  MISSING_INVOICE_NUMBER: "No invoice number",
  MISSING_TAX_ID: "No VAT number",
  LOW_CONFIDENCE: "Hard to read",
};

function Flag({ tone, icon, title, text }: { tone: "good" | "bad" | "warn" | "info"; icon: React.ReactNode; title: string; text: string }) {
  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg p-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
        tone === "good" && "bg-accent text-accent-foreground",
        tone === "bad" && "bg-destructive-soft text-destructive",
        tone === "warn" && "bg-token-soft text-token",
        tone === "info" && "bg-secondary text-muted-foreground",
      )}
    >
      {icon}
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-foreground/80">{text}</p>
      </div>
    </div>
  );
}

interface VatRow {
  vendor: string;
  invoiceNumber: string | null;
  net: number;
  vat: number;
  gross: number;
  reason: string | null;
}
interface Vat {
  period: string;
  currency: string;
  invoiceCount: number;
  totals: { net: number; vat: number; gross: number };
  reclaimableVat: number;
  heldBackVat: number;
  included: VatRow[];
  heldBack: VatRow[];
  accountantNote: string;
}

function VatSummary({ output: o }: { output: Vat }) {
  const c = o.currency;
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Figure label="VAT to reclaim" value={money(o.reclaimableVat, c)} tone="good" />
        <Figure label="VAT held back" value={money(o.heldBackVat, c)} tone={o.heldBack.length ? "bad" : "neutral"} />
        <Figure label="Invoices" value={`${o.included.length} in · ${o.heldBack.length} held`} tone="neutral" />
      </div>
      <blockquote className="rounded-lg border-l-4 border-primary bg-secondary px-4 py-3 text-sm">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Note for your accountant · {o.period}</p>
        {o.accountantNote}
      </blockquote>
      {o.invoiceCount > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">VAT</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...o.included, ...o.heldBack].map((r, i) => (
                <TableRow key={i}>
                  <TableCell>
                    {r.vendor}
                    {r.invoiceNumber && <span className="block font-mono text-xs text-muted-foreground">{r.invoiceNumber}</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{money(r.net, c)}</TableCell>
                  <TableCell className="text-right font-mono text-[13px]">{money(r.vat, c)}</TableCell>
                  <TableCell className={cn("max-w-64 whitespace-normal text-xs", r.reason ? "text-destructive" : "text-primary")}>{r.reason ?? "Ready to claim"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone: "good" | "bad" | "neutral" }) {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("font-mono text-lg font-medium", tone === "good" && "text-primary", tone === "bad" && "text-destructive")}>{value}</p>
    </div>
  );
}
