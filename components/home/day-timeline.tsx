"use client";
import { useState } from "react";
import { cn } from "@/lib/utils";

const START = 7;
const END = 19;
const pos = (h: number) => ((h - START) / (END - START)) * 100;

type Ev = { from: number; to?: number; label?: string; tip: string; kind?: "flag" | "you" };
type Lane = { who: string; ini: string; sub: string; you?: boolean; events: Ev[] };

const LANES: Lane[] = [
  { who: "Inventory Guardian", ini: "IG", sub: "Shopify", events: [
    { from: 7, to: 7.4, label: "Stock check", tip: "Checked 42 products. Oat milk will sell out Saturday." },
    { from: 16.7, to: 17.2, label: "Reorder", tip: "Drafted 4 cases of oat milk (£38.40) and sent it to your inbox." },
  ] },
  { who: "ReceiptHero", ini: "RH", sub: "Drive /Invoices", events: [
    { from: 7.4, to: 8.1, label: "6 invoices", tip: "Read and filed 6 invoices that arrived overnight." },
    { from: 12, to: 12.4, label: "£2", tip: "INV-20931's total is £2.00 more than its items plus VAT.", kind: "flag" },
    { from: 18, to: 18.6, label: "Log", tip: "Wrote today's spending into your Google Sheet." },
  ] },
  { who: "EchoSocial", ini: "ES", sub: "LinkedIn", events: [
    { from: 8.5, to: 8.9, label: "Post", tip: "Published the Tuesday post. 214 views by noon." },
    { from: 15, to: 15.6, label: "Draft", tip: "Drafted Thursday's post and asked you to approve it." },
  ] },
  { who: "DM Concierge", ini: "DC", sub: "Slack · Discord", events: [
    ...[9.2, 9.9, 10.5, 11.2, 11.7, 14.3, 15.2, 16.2, 17.5].map((h) => ({ from: h, tip: "Answered a customer question from your FAQ." })),
    { from: 13.1, to: 13.6, label: "Refund", tip: "A refund request needed a human, so it went to your inbox.", kind: "flag" as const },
  ] },
  { who: "You (Sam)", ini: "SP", sub: "3 approvals", you: true, events: [
    { from: 8.1, to: 8.45, label: "OK", tip: "Approved the LinkedIn post from your phone. 1 minute.", kind: "you" },
    { from: 13.6, to: 14.05, label: "Refund", tip: "Chose a full refund for order #1182. 3 minutes.", kind: "you" },
    { from: 17.2, to: 17.6, label: "OK", tip: "Approved the oat milk reorder. 2 minutes.", kind: "you" },
  ] },
];

const fmt = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

export function DayTimeline() {
  const [tip, setTip] = useState<string>("Tap any block to see what happened.");
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="overflow-x-auto">
        <div className="min-w-[760px] px-5 pb-2 pt-5">
          <div className="grid grid-cols-[150px_1fr] font-mono text-xs text-muted-foreground">
            <span />
            <div className="relative h-5">
              {Array.from({ length: 7 }, (_, i) => START + i * 2).map((h) => (
                <span key={h} className="absolute -translate-x-1/2" style={{ left: `${pos(h)}%` }}>
                  {fmt(h)}
                </span>
              ))}
            </div>
          </div>
          {LANES.map((lane) => (
            <div key={lane.who} className={cn("grid min-h-13 grid-cols-[150px_1fr] items-center border-t", lane.you && "bg-you-soft/50")}>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className={cn("grid size-7 place-items-center rounded-md font-display text-[11px] font-bold", lane.you ? "bg-you-soft text-you" : "bg-accent text-accent-foreground")}>{lane.ini}</span>
                <span>
                  {lane.who}
                  <span className="block text-[11px] font-normal text-muted-foreground">{lane.sub}</span>
                </span>
              </div>
              <div className="relative h-13 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px)] bg-[length:calc(100%/12)_100%]">
                {lane.events.map((e, i) => {
                  const text = `${fmt(e.from)} · ${lane.who}: ${e.tip}`;
                  const show = () => setTip(text);
                  return e.to ? (
                    <button
                      key={i}
                      onMouseEnter={show}
                      onFocus={show}
                      onClick={show}
                      className={cn(
                        "absolute top-3 flex h-7 items-center overflow-hidden whitespace-nowrap rounded-md border px-2 text-xs font-semibold",
                        "border-primary/30 bg-accent text-accent-foreground",
                        e.kind === "flag" && "border-destructive/40 bg-destructive-soft text-destructive",
                        e.kind === "you" && "border-you/40 bg-you-soft text-you",
                      )}
                      style={{ left: `${pos(e.from)}%`, width: `${pos(e.to) - pos(e.from)}%` }}
                    >
                      {e.label}
                    </button>
                  ) : (
                    <button key={i} aria-label={text} onMouseEnter={show} onFocus={show} onClick={show} className="absolute top-[21px] size-2.5 -translate-x-1/2 rounded-full bg-primary" style={{ left: `${pos(e.from)}%` }} />
                  );
                })}
                <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-destructive/70" style={{ left: `${pos(14.6)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="min-h-11 border-t px-5 py-3 text-sm text-muted-foreground" aria-live="polite">
        {tip}
      </p>
      <div className="grid grid-cols-2 border-t md:grid-cols-4 md:divide-x">
        <Sum value="41" label="tasks done by agents" />
        <Sum value="~4.5 h" label="of manual work saved" />
        <Sum value="78" label="tokens spent (≈ $7.64)" className="text-token" />
        <Sum value="6 min" label="owner's time, 3 approvals" className="text-you" />
      </div>
    </div>
  );
}

function Sum({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div className="px-5 py-4">
      <b className={cn("block font-mono text-2xl font-medium", className)}>{value}</b>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}
