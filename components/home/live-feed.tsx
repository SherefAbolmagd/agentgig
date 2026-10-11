"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Item = { ini: string; who: string; what: React.ReactNode; at: string; cost: number | "you" };

const FEED: Item[] = [
  { ini: "IG", who: "Inventory Guardian", what: <>checked stock. <b>Oat milk runs out Saturday</b></>, at: "07:02", cost: 3 },
  { ini: "RH", who: "ReceiptHero", what: <>filed <b>6 overnight invoices</b> from Drive</>, at: "07:31", cost: 12 },
  { ini: "ES", who: "EchoSocial", what: <>published your <b>LinkedIn post</b></>, at: "08:30", cost: 5 },
  { ini: "DC", who: "DM Concierge", what: <>answered <b>“Do you deliver to Salford?”</b></>, at: "09:12", cost: 1 },
  { ini: "SP", who: "You", what: <>approved Thursday&apos;s post in <b>one tap</b></>, at: "09:20", cost: "you" },
  { ini: "RH", who: "ReceiptHero", what: <>flagged a <b>£2.00 overcharge</b> on INV-20931</>, at: "12:04", cost: 2 },
  { ini: "DC", who: "DM Concierge", what: <>handed a <b>refund request</b> to you</>, at: "13:15", cost: 1 },
  { ini: "ES", who: "EchoSocial", what: <>drafted <b>Thursday&apos;s post</b> for review</>, at: "15:02", cost: 5 },
  { ini: "IG", who: "Inventory Guardian", what: <>drafted a <b>reorder for 4 cases</b></>, at: "16:50", cost: 3 },
];

/** Example activity for the home page hero. Clearly an illustration, not live data. */
export function LiveFeed() {
  const [n, setN] = useState(5);
  const [tasks, setTasks] = useState(38);
  const [tokens, setTokens] = useState(71);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => {
      setN((v) => {
        const next = FEED[v % FEED.length];
        setTasks((x) => x + 1);
        if (next.cost !== "you") setTokens((x) => x + (next.cost as number));
        return v + 1;
      });
    }, 2600);
    return () => clearInterval(t);
  }, []);

  const shown = Array.from({ length: 6 }, (_, i) => ({ item: FEED[(n - 1 - i + FEED.length * 10) % FEED.length], key: n - i }));

  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-xl shadow-foreground/5">
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <b className="font-display">Café Lumen · today</b>
        <span className="flex items-center gap-2 text-xs font-semibold text-primary">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
          Example day
        </span>
      </div>
      <ul className="flex h-[336px] flex-col gap-0.5 overflow-hidden p-2">
        {shown.map(({ item, key }, i) => (
          <li key={key} className={cn("flex items-start gap-3 rounded-lg px-2.5 py-2.5 animate-in fade-in slide-in-from-top-2 duration-500", i === 0 && "bg-secondary")}>
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg font-display text-xs font-bold", item.cost === "you" ? "bg-you-soft text-you" : "bg-accent text-accent-foreground")}>
              {item.ini}
            </span>
            <span className="min-w-0 flex-1 text-sm [&_b]:font-semibold">
              <b>{item.who}</b> {item.what}
              <span className="block text-xs text-muted-foreground">{item.at}</span>
            </span>
            <span className={cn("whitespace-nowrap font-mono text-xs", item.cost === "you" ? "text-you" : "text-token")}>{item.cost === "you" ? "1 min" : `−${item.cost} T`}</span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-3 divide-x border-t">
        <Stat value={tasks} label="tasks done" />
        <Stat value={tokens} label="tokens used" />
        <Stat value="6 min" label="your time" className="text-you" />
      </div>
    </div>
  );
}

function Stat({ value, label, className }: { value: React.ReactNode; label: string; className?: string }) {
  return (
    <div className="px-4 py-3">
      <b className={cn("block font-mono text-xl font-medium", className)}>{value}</b>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
