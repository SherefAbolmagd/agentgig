import Link from "next/link";
import { BriefcaseBusiness } from "lucide-react";
import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2.5 font-display text-lg font-bold", className)}>
      <span className="grid size-8 place-items-center rounded-lg bg-foreground text-background">
        <BriefcaseBusiness className="size-4" strokeWidth={2.4} />
      </span>
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
