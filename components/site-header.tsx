"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { LogOut, Plus, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Coin, Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, ApiError } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth";
import { useMe, useOpenApprovals } from "@/lib/client/firestore";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/marketplace", label: "Marketplace" },
  { href: "/workforce", label: "My workforce" },
  { href: "/knowledge", label: "Company knowledge" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const approvals = useOpenApprovals();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
        <Logo />
        <nav aria-label="Main" className="-mx-1 flex max-w-full gap-1 overflow-x-auto rounded-xl bg-secondary p-1">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                  active && "bg-card text-foreground shadow-sm",
                )}
              >
                {item.label}
                {item.href === "/workforce" && approvals.data.length > 0 && (
                  <span className="rounded-full bg-destructive px-1.5 font-mono text-[11px] leading-[18px] text-white">
                    {approvals.data.length}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Wallet />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

function Wallet() {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const balance = me.data?.tokenBalance;

  async function buy() {
    setBusy(true);
    try {
      const res = await api<{ balance: number }>("/api/tokens/topup");
      toast.success(`Added 500 tokens. Your balance is ${res.balance}.`, { description: "Payment of $49 simulated for the demo." });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Top-up failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-card py-1 pl-3 pr-1" aria-live="polite">
      <Coin />
      <div className="leading-tight">
        <div className="font-mono text-lg font-medium tabular-nums">{balance ?? "–"}</div>
        <div className="text-[11px] text-muted-foreground">tokens</div>
      </div>
      <Button size="sm" variant="ghost" className="bg-token-soft text-token hover:bg-token-soft/80 hover:text-token" onClick={buy} disabled={busy || balance === undefined}>
        <Plus /> 500 · $49
      </Button>
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const me = useMe();
  if (!user) return null;
  const demo = user.isAnonymous;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Account">
          <UserRound />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="font-medium">{me.data?.businessName ?? "Your business"}</div>
          <div className="text-xs text-muted-foreground">{demo ? "Demo sandbox · not saved to an account" : user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/knowledge">Business profile</Link>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => signOut()}>
          <LogOut /> {demo ? "Leave the demo" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
