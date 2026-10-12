import Link from "next/link";
import { ArrowRight, BadgeCheck, Coins, Hand, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand";
import { DayTimeline } from "@/components/home/day-timeline";
import { DemoButton } from "@/components/home/demo-button";
import { LiveFeed } from "@/components/home/live-feed";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <>
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
          <Logo />
          <nav className="ml-auto hidden gap-6 text-sm text-muted-foreground sm:flex">
            <a href="#how" className="hover:text-foreground">How it works</a>
            <a href="#day" className="hover:text-foreground">A day with your team</a>
            <a href="#security" className="hover:text-foreground">Security</a>
          </nav>
          <Button asChild variant="outline" size="sm" className="ml-auto sm:ml-0">
            <Link href="/marketplace">Browse agents</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <section className="grid items-center gap-10 pt-12 lg:grid-cols-[1.1fr_0.9fr] lg:pt-16">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">The AI workforce for small businesses</p>
            <h1 className="mt-3 text-[clamp(2.4rem,5.4vw,4rem)] font-extrabold leading-[1.02] tracking-tighter">
              Hire AI employees.
              <br />
              <span className="text-primary">Pay only for finished work.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted-foreground">
              Pick a ready-made agent for social posts, bookkeeping, customer messages or stock. Connect the tools you already use. It works in the background and asks you before anything goes public.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <DemoButton />
              <Button asChild size="lg" variant="outline">
                <Link href="/marketplace">Browse AI employees</Link>
              </Button>
            </div>
            <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              <Trust icon={<Coins />}>From 1 token per task, no subscription</Trust>
              <Trust icon={<ShieldCheck />}>Personal data removed before AI sees it</Trust>
              <Trust icon={<Hand />}>You approve anything public</Trust>
            </ul>
          </div>
          <LiveFeed />
        </section>

        <section id="how" className="scroll-mt-20 pt-24">
          <SectionHead eyebrow="How it works" title="Set up your first AI employee in about five minutes" />
          <ol className="grid gap-4 md:grid-cols-3">
            <Step n={1} title="Top up tokens" eg={<><b>500 tokens · $49</b> covers about 100 LinkedIn posts or 250 receipts.</>}>
              Buy a bundle once. Every agent shows its price per task up front, and a task that fails costs nothing.
            </Step>
            <Step n={2} title="Hire and connect" eg={<><b>ReceiptHero</b> watches your Drive folder <b>/Invoices</b>.</>}>
              Choose an agent, sign in to the tool it needs, and tell it when to work: on a schedule, when something arrives, or only when you click.
            </Step>
            <Step n={3} title="Approve and relax" eg={<><b>Today:</b> 3 approvals took 6 minutes in total.</>}>
              Agents do the work and drop anything that needs a decision into one inbox. Most approvals take one tap.
            </Step>
          </ol>
        </section>

        <section id="day" className="scroll-mt-20 pt-24">
          <SectionHead
            eyebrow="How it fits your day"
            title="A Wednesday at Café Lumen"
            text="Four AI employees work alongside the owner. The blue row is the owner's own time."
          />
          <DayTimeline />
        </section>

        <section id="security" className="scroll-mt-20 pt-24">
          <SectionHead
            eyebrow="Under the hood"
            title="Your tools stay where they are. Agents plug into them."
            text="Every task goes through one gateway on Google Cloud. It checks your balance, removes personal data, and holds your sign-ins so agents never see your passwords."
          />
          <div className="grid gap-3 lg:grid-cols-[1fr_auto_1.15fr_auto_1fr_auto_1fr] lg:items-stretch">
            <Node eyebrow="1 · Your tools" title="Where work starts">
              <div className="flex flex-wrap gap-1.5">
                {["Gmail", "Google Drive", "Sheets", "LinkedIn", "Slack", "Shopify"].map((t) => (
                  <span key={t} className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium">{t}</span>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">A new invoice, a customer message or a schedule starts a task.</p>
            </Node>
            <Arrow />
            <Node eyebrow="2 · AgentGig gateway" title="Checks before any work" dark>
              <Check icon={<Coins />}>Holds tokens; rejects the task if your balance is too low</Check>
              <Check icon={<ShieldCheck />}>Removes emails, phone and card numbers (Cloud DLP)</Check>
              <Check icon={<BadgeCheck />}>Uses your sign-ins on the agent&apos;s behalf</Check>
            </Node>
            <Arrow />
            <Node eyebrow="3 · AI employees" title="Do the task">
              <p className="text-sm text-muted-foreground">Our own agents run on Gemini in Vertex AI. Partner agents are called over the open A2A protocol.</p>
            </Node>
            <Arrow />
            <Node eyebrow="4 · Back to you" title="Results land in place">
              <Check icon={<BadgeCheck />}>Posts go out, files get filed</Check>
              <Check icon={<Hand />}>Decisions wait in your inbox</Check>
              <Check icon={<Coins />}>Charged only on success</Check>
            </Node>
          </div>
        </section>

        <section className="mt-24 flex flex-wrap items-center justify-between gap-6 rounded-2xl bg-foreground px-8 py-9 text-background">
          <div>
            <h2 className="text-2xl font-extrabold sm:text-3xl">Start with one agent. Add more when you trust it.</h2>
            <p className="mt-1 text-background/70">The demo is a working copy of Café Lumen with 312 tokens. No sign-up needed.</p>
          </div>
          <DemoButton label="Open the demo café" />
        </section>
      </main>
    </>
  );
}

function SectionHead({ eyebrow, title, text }: { eyebrow: string; title: string; text?: string }) {
  return (
    <div className="mb-7 max-w-3xl">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-1.5 text-[clamp(1.6rem,3vw,2.1rem)] font-extrabold">{title}</h2>
      {text && <p className="mt-2 text-muted-foreground">{text}</p>}
    </div>
  );
}

function Trust({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <li className="flex items-center gap-2 [&>svg]:size-4 [&>svg]:text-primary">{icon}{children}</li>;
}

function Step({ n, title, eg, children }: { n: number; title: string; eg: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="grid content-start gap-2.5 rounded-xl border bg-card p-6">
      <span className="flex items-center gap-3 font-mono text-sm text-primary after:h-px after:flex-1 after:bg-border">Step {n}</span>
      <h3 className="text-xl font-bold">{title}</h3>
      <p className="text-sm text-muted-foreground">{children}</p>
      <p className="border-t border-dashed pt-2.5 text-sm text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">{eg}</p>
    </li>
  );
}

function Node({ eyebrow, title, dark, children }: { eyebrow: string; title: string; dark?: boolean; children: React.ReactNode }) {
  return (
    <div className={dark ? "grid content-start gap-2.5 rounded-xl bg-foreground p-4 text-background" : "grid content-start gap-2.5 rounded-xl border bg-card p-4"}>
      <p className={dark ? "text-[11px] font-semibold uppercase tracking-widest text-background/60" : "text-[11px] font-semibold uppercase tracking-widest text-muted-foreground"}>{eyebrow}</p>
      <h3 className="text-base font-bold">{title}</h3>
      {children}
    </div>
  );
}

function Check({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <p className="flex items-start gap-2 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">{icon}{children}</p>;
}

function Arrow() {
  return (
    <div className="grid place-items-center text-muted-foreground" aria-hidden>
      <ArrowRight className="size-5 rotate-90 lg:rotate-0" />
    </div>
  );
}
