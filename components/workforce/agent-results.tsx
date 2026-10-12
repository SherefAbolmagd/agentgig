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

export function ReplyResult({ o, kind }: { o: Out; kind: "dm" | "review" }) {
  const reply = String(o.reply ?? "");
  const flagged = kind === "dm" ? !!o.needsHuman : !!o.urgent;
  return (
    <div className="grid gap-3">
      {flagged && (
        <div className="flex gap-2 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{kind === "dm" ? `Needs you: ${String(o.reason ?? "")}` : String(o.internalNote ?? "")}</span>
        </div>
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
