import Link from "next/link";
import { cn } from "@/lib/utils";

/** The Spark g: a lowercase g with an amber AI spark. Same drawing as app/icon.svg. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn("size-8 shrink-0", className)}>
      <circle cx="30" cy="27" r="14" fill="none" stroke="currentColor" strokeWidth="8.5" />
      <path d="M44 18v23q0 15-15 15-7 0-11-4" fill="none" stroke="currentColor" strokeWidth="8.5" strokeLinecap="round" />
      <path className="fill-token" d="M54 1.5Q54 9 61.5 9Q54 9 54 16.5Q54 9 46.5 9Q54 9 54 1.5Z" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2.5 font-display text-lg font-bold", className)}>
      <LogoMark />
      AgentGig
    </Link>
  );
}

/** Square avatar with an agent's initials. */
export function AgentAvatar({ initials, className }: { initials: string; className?: string }) {
  return (
    <span
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-lg bg-accent font-display text-sm font-bold text-accent-foreground",
        className,
      )}
    >
      {initials}
    </span>
  );
}

/** Amber token coin used next to balances and prices. */
export function Coin({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] border-token bg-token-soft font-mono text-[10px] font-semibold text-token",
        className,
      )}
    >
      T
    </span>
  );
}
