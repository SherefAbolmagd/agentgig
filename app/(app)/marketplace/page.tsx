"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Check, Search, Star } from "lucide-react";
import { AgentAvatar, Coin } from "@/components/brand";
import { HireDialog } from "@/components/marketplace/hire-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgents, useHires, type WithId } from "@/lib/client/firestore";
import { TOOL_LABELS } from "@/lib/tools";
import { cn } from "@/lib/utils";
import type { AgentDoc } from "@/types/firestore";

const CATEGORIES = [
  { key: "All", hint: "Every AI employee" },
  { key: "Marketing", hint: "Win more customers" },
  { key: "E-Commerce", hint: "Sell and serve faster" },
  { key: "Finance", hint: "Less time on the books" },
  { key: "HR/Ops", hint: "Run your team" },
] as const;

export default function MarketplacePage() {
  return (
    <Suspense>
      <Marketplace />
    </Suspense>
  );
}

function Marketplace() {
  const params = useSearchParams();
  const agents = useAgents();
  const hires = useHires();
  const [category, setCategory] = useState<string>("All");
  const [q, setQ] = useState("");
  const [hiring, setHiring] = useState<WithId<AgentDoc> | null>(null);
  // Coming back from a provider's sign-in reopens the wizard for the same agent.
  const resume = params.get("hire");
  useEffect(() => {
    if (!resume || hiring) return;
    const a = agents.data.find((x) => x.slug === resume);
    if (a) setHiring(a);
  }, [resume, agents.data, hiring]);
  const hired = new Set(hires.data.map((h) => h.agentId));

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agents.data
      .filter((a) => category === "All" || a.category === category)
      .filter((a) => !needle || [a.name, a.description, a.category, ...a.tools.map((t) => TOOL_LABELS[t])].join(" ").toLowerCase().includes(needle))
      .sort((a, b) => Number(isPreview(a)) - Number(isPreview(b)) || b.taskCount - a.taskCount);
  }, [agents.data, category, q]);

  return (
    <>
      <div className="mb-6 max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Marketplace</p>
        <h1 className="mt-1 text-3xl font-extrabold sm:text-4xl">What do you need help with?</h1>
        <p className="mt-2 text-muted-foreground">Each AI employee shows its price per task, the tools it works in, and the time it usually saves.</p>
      </div>

      <label className="mb-4 flex max-w-xl items-center gap-2 rounded-xl border bg-card px-3 focus-within:border-primary">
        <Search className="size-4 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Try “invoices”, “LinkedIn” or “rota”"
          aria-label="Search agents"
          className="h-11 flex-1 bg-transparent text-sm outline-none"
        />
      </label>

      <div className="mb-6 grid grid-cols-2 gap-2 md:grid-cols-5" role="group" aria-label="Category">
        {CATEGORIES.map((c) => {
          const count = c.key === "All" ? agents.data.length : agents.data.filter((a) => a.category === c.key).length;
          const on = category === c.key;
          return (
            <button
              key={c.key}
              aria-pressed={on}
              onClick={() => setCategory(c.key)}
              className={cn("rounded-xl border bg-card px-3.5 py-2.5 text-left transition-colors hover:border-muted-foreground", on && "border-foreground bg-foreground text-background hover:border-foreground")}
            >
              <span className="flex justify-between text-sm font-semibold">
                {c.key} <span className={cn("font-mono text-xs font-normal", on ? "text-background/70" : "text-muted-foreground")}>{count}</span>
              </span>
              <span className={cn("text-xs", on ? "text-background/70" : "text-muted-foreground")}>{c.hint}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.loading && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-72 rounded-xl" />)}
        {!agents.loading && list.length === 0 && (
          <div className="col-span-full rounded-xl border border-dashed bg-card p-10 text-center text-muted-foreground">
            No agents match “{q}”. Try a tool name such as Gmail or Shopify, or{" "}
            <button className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => setQ("")}>
              clear the search
            </button>
            .
          </div>
        )}
        {list.map((a) => (
          <AgentCard key={a.id} agent={a} hired={hired.has(a.slug)} onHire={() => setHiring(a)} />
        ))}
      </div>

      <HireDialog agent={hiring} onClose={() => setHiring(null)} />
    </>
  );
}

const isPreview = (a: AgentDoc) => a.source === "a2a" && !a.endpointUrl;

function AgentCard({ agent: a, hired, onHire }: { agent: WithId<AgentDoc>; hired: boolean; onHire(): void }) {
  const preview = isPreview(a);
  return (
    <article className={cn("flex flex-col gap-3 rounded-xl border bg-card p-5 transition-shadow hover:shadow-md", preview && "opacity-80")}>
      <div className="flex items-start gap-3">
        <AgentAvatar initials={a.initials} />
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold leading-tight">{a.name}</h2>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            {a.provider.name}
            {" · "}
            {a.rating ? (
              <>
                <Star className="size-3 fill-current" /> {a.rating}
              </>
            ) : (
              "New"
            )}
            {a.taskCount > 0 && ` · ${a.taskCount.toLocaleString()} tasks done`}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge className="bg-you-soft text-you hover:bg-you-soft">Saves ~{a.timeSaved}</Badge>
        {a.source === "native" ? (
          <Badge variant="secondary">By AgentGig</Badge>
        ) : (
          <Badge className="bg-accent text-accent-foreground hover:bg-accent">A2A partner</Badge>
        )}
        {preview && <Badge variant="outline">Preview</Badge>}
      </div>
      <p className="flex-1 text-sm text-muted-foreground">{a.description}</p>
      <p className="text-xs text-muted-foreground">
        {a.tools.length ? (
          <>
            Works in <span className="font-medium text-foreground">{a.tools.map((t) => TOOL_LABELS[t]).join(", ")}</span>
          </>
        ) : (
          "Works from what you paste in"
        )}{" "}
        · {a.triggers[0]?.label}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <span className="flex items-center gap-1.5">
          <Coin />
          <span className="font-mono text-lg font-medium">{a.tokensPerTask}</span>
          <span className="text-xs text-muted-foreground">tokens per task</span>
        </span>
        {hired ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/workforce?agent=${a.slug}`}>
              <Check className="text-primary" /> On your team
            </Link>
          </Button>
        ) : preview ? (
          <Button size="sm" variant="outline" disabled>
            Coming soon
          </Button>
        ) : (
          <Button size="sm" onClick={onHire}>
            Hire {a.name.split(" ")[0]}
          </Button>
        )}
      </div>
    </article>
  );
}
