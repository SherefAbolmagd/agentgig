"use client";
import { Suspense } from "react";
import { Brain, Coins, Loader2, MessageCircle } from "lucide-react";
import { RedirectFeedback } from "@/components/connect-feedback";
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
      <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SignInStory />
        <div className="flex flex-col items-center justify-center gap-8 px-4 py-10 sm:px-8">
          <Logo className="lg:hidden" />
          <SignInCard />
        </div>
      </div>
    );
  }

  return (
    <>
      <SiteHeader />
      <Suspense>
        <RedirectFeedback />
      </Suspense>
      <main className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6">{children}</main>
    </>
  );
}

/** The left half of the sign-in screen on wide screens: what AgentGig is, in three lines. */
function SignInStory() {
  const points = [
    { icon: <Brain className="size-5" />, title: "One shared memory", text: "What one agent or teammate learns, the whole team can use." },
    { icon: <MessageCircle className="size-5" />, title: "Text your team", text: "Ask Ada on Telegram and she hands the job to the right agent." },
    { icon: <Coins className="size-5" />, title: "Pay per finished task", text: "Tokens are only charged when an agent delivers." },
  ];
  return (
    <aside className="hidden flex-col justify-between gap-12 bg-console p-12 text-console-foreground lg:flex xl:p-16">
      <Logo className="text-white" />
      <div className="grid max-w-lg gap-8">
        <div className="grid gap-4">
          <p className="font-mono text-xs uppercase tracking-widest text-amber-300">The AI workforce for your business</p>
          <h2 className="font-display text-5xl font-extrabold leading-[1.05] tracking-tight text-white">AI employees that work as one team</h2>
        </div>
        <ul className="grid gap-5">
          {points.map((p) => (
            <li key={p.title} className="flex gap-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/10 text-emerald-300">{p.icon}</span>
              <span>
                <span className="block font-semibold text-white">{p.title}</span>
                <span className="text-sm text-console-foreground/80">{p.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="max-w-lg border-t border-white/10 pt-6 text-sm text-console-foreground/80">
        You used to hire people and pay them a salary. <span className="text-white">Now you hire AI and pay it in tokens.</span>
      </p>
    </aside>
  );
}
