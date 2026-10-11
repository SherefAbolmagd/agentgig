"use client";
import { Loader2 } from "lucide-react";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { SignInCard } from "@/components/sign-in-card";
import { SiteHeader } from "@/components/site-header";
import { useAuth } from "@/lib/client/auth";

/** Every app page requires a signed-in user whose account exists. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, ready, accountReady, accountError, signOut } = useAuth();

  if (user && accountError) {
    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <div className="grid max-w-md justify-items-center gap-4 text-center">
          <Logo />
          <p role="alert" className="rounded-lg bg-destructive-soft px-4 py-3 text-sm text-destructive">
            {accountError}
          </p>
          <Button variant="outline" onClick={() => signOut()}>
            Back to sign-in
          </Button>
        </div>
      </div>
    );
  }

  if (!ready || (user && !accountReady)) {
    return (
      <div className="grid min-h-dvh place-items-center text-muted-foreground">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> {user ? "Setting up your workspace…" : "Loading…"}
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="grid min-h-dvh place-items-center gap-6 px-4 py-10">
        <div className="grid justify-items-center gap-8">
          <Logo />
          <SignInCard />
        </div>
      </div>
    );
  }

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6">{children}</main>
    </>
  );
}
