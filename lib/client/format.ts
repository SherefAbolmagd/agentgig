import type { TaskStatus, Ts } from "@/types/firestore";

export const STATUS: Record<TaskStatus, { label: string; tone: "neutral" | "busy" | "good" | "attention" | "bad" }> = {
  requested: { label: "Requested", tone: "busy" },
  reserved: { label: "Starting", tone: "busy" },
  running: { label: "Working", tone: "busy" },
  awaiting_approval: { label: "Needs your OK", tone: "attention" },
  delivered: { label: "Done", tone: "good" },
  rejected: { label: "Not enough tokens", tone: "bad" },
  failed: { label: "Failed · refunded", tone: "bad" },
  discarded: { label: "Skipped", tone: "neutral" },
};

export const TONE_CLASSES = {
  neutral: "bg-secondary text-muted-foreground",
  busy: "bg-you-soft text-you",
  good: "bg-accent text-accent-foreground",
  attention: "bg-token-soft text-token",
  bad: "bg-destructive-soft text-destructive",
} as const;

export function toDate(ts: Ts | null | undefined): Date | null {
  return ts && typeof ts.toDate === "function" ? ts.toDate() : null;
}

/** "Today 14:05", "Yesterday 09:12" or "8 Oct 17:03". */
export function when(ts: Ts | null | undefined): string {
  const d = toDate(ts);
  if (!d) return "just now";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const days = Math.floor((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function money(n: number, currency = "GBP"): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
