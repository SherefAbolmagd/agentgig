"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Loader2, LogOut, Plus, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Coin, Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { useMe, useMemory, useOpenApprovals } from "@/lib/client/firestore";
import { useIntegrationStatus } from "@/lib/client/integrations";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/marketplace", label: "Marketplace" },
  { href: "/workforce", label: "My workforce" },
  { href: "/memory", label: "Memory" },
  { href: "/knowledge", label: "Company knowledge" },
  { href: "/team", label: "Team" },
  { href: "/developers", label: "Developers" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const approvals = useOpenApprovals();
  const memory = useMemory();
  const pendingFacts = memory.data.filter((m) => m.status === "pending").length;
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
                {item.href === "/memory" && pendingFacts > 0 && (
                  <span className="rounded-full bg-token px-1.5 font-mono text-[11px] leading-[18px] text-white" aria-label={`${pendingFacts} facts waiting`}>
                    {pendingFacts}
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

const BUNDLES = [
  { id: "starter", tokens: 500, price: "$49", note: "About 100 LinkedIn posts or 250 receipts" },
  { id: "growth", tokens: 1500, price: "$129", note: "Best value for a busy team" },
] as const;

function Wallet() {
  const me = useMe();
  const { user } = useAuth();
  const status = useIntegrationStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const balance = me.data?.tokenBalance;
  const card = !!status?.payments && !!user && !user.isAnonymous;

  async function demoTopUp() {
    setBusy("demo");
    try {
      const res = await api<{ balance: number }>("/api/tokens/topup");
      toast.success(`Added 500 demo tokens. Your balance is ${res.balance}.`, { description: "Free in the demo; create an account to buy real tokens." });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Top-up failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function checkout(bundle: string) {
    setBusy(bundle);
    try {
      const { url } = await api<{ url: string }>("/api/billing/checkout", { json: { bundle } });
      window.location.assign(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't open checkout. Try again.");
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-card py-1 pl-3 pr-1" aria-live="polite">
      <Coin />
      <div className="leading-tight">
        <div className={cn("font-mono text-lg font-medium tabular-nums", balance !== undefined && balance < 20 && "text-destructive")}>{balance ?? "–"}</div>
        <div className="text-[11px] text-muted-foreground">tokens</div>
      </div>
      {card ? (
        <Button size="sm" variant="ghost" className="bg-token-soft text-token hover:bg-token-soft/80 hover:text-token" onClick={() => setOpen(true)} disabled={balance === undefined}>
          <Plus /> Buy tokens
        </Button>
      ) : (
        <Button size="sm" variant="ghost" className="bg-token-soft text-token hover:bg-token-soft/80 hover:text-token" onClick={demoTopUp} disabled={!!busy || balance === undefined}>
          {busy === "demo" ? <Loader2 className="animate-spin" /> : <Plus />} 500 free (demo)
        </Button>
      )}
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Buy tokens</DialogTitle>
            <DialogDescription>Pay by card with Stripe. Tokens never expire, and you&apos;re only charged for tasks that finish.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {BUNDLES.map((b) => (
              <button
                key={b.id}
                onClick={() => checkout(b.id)}
                disabled={!!busy}
                className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left hover:border-primary disabled:opacity-60"
              >
                <span>
                  <span className="block font-mono text-lg font-medium">{b.tokens.toLocaleString()} tokens</span>
                  <span className="text-xs text-muted-foreground">{b.note}</span>
                </span>
                <span className="flex items-center gap-2 font-semibold">
                  {busy === b.id && <Loader2 className="size-4 animate-spin" />}
                  {b.price}
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const me = useMe();
  const [confirming, setConfirming] = useState(false);
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
        <DropdownMenuItem asChild>
          <Link href="/team">Team and roles</Link>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => signOut()}>
          <LogOut /> {demo ? "Leave the demo" : "Sign out"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
          <Trash2 /> {demo ? "Delete this sandbox" : "Delete my account"}
        </DropdownMenuItem>
      </DropdownMenuContent>
      <DeleteAccountDialog open={confirming} demo={demo} onClose={() => setConfirming(false)} onDeleted={signOut} />
    </DropdownMenu>
  );
}

function DeleteAccountDialog({ open, demo, onClose, onDeleted }: { open: boolean; demo: boolean; onClose(): void; onDeleted(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await api("/api/me", { method: "DELETE" });
      toast.success(demo ? "Sandbox deleted." : "Your account and data are deleted.");
      await onDeleted();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Deletion failed. Try again.");
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">{demo ? "Delete this sandbox?" : "Delete your account?"}</DialogTitle>
          <DialogDescription>
            This permanently removes your tasks, token history, hired agents, company knowledge files and sign-in. It can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
