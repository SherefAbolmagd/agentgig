"use client";
import Link from "next/link";
import { Check } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { toDate } from "@/lib/client/format";
import type { WithId } from "@/lib/client/firestore";
import { cn } from "@/lib/utils";
import type { HireDoc, TaskDoc, UserDoc } from "@/types/firestore";

interface Props {
  me: UserDoc | null;
  hires: HireDoc[];
  tasks: WithId<TaskDoc>[];
  openApprovals: number;
}

export function Overview({ me, hires, tasks, openApprovals }: Props) {
  const weekAgo = Date.now() - 7 * 86_400_000;
  const thisWeek = tasks.filter((t) => t.settlement === "charged" && (toDate(t.createdAt)?.getTime() ?? Date.now()) > weekAgo);
  const reviewed = tasks.some((t) => t.steps?.some((s) => s.step === "deliver" && /^You (approved|skipped)/.test(s.message)));

  const steps = [
    { label: "Top up tokens", done: (me?.tokenBalance ?? 0) > 0 || (me?.tokensSpent ?? 0) > 0, href: undefined },
    { label: "Hire an AI employee", done: hires.length > 0, href: "/marketplace" },
    { label: "Add your business profile", done: !!me?.businessProfile, href: "/knowledge" },
    { label: "Run your first task", done: tasks.some((t) => t.settlement === "charged"), href: undefined },
    { label: "Review a draft", done: reviewed, href: undefined },
  ];
  const done = steps.filter((s) => s.done).length;

  return (
    <div className="grid gap-4">
      {done < steps.length && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-4 py-3">
          <div className="min-w-36">
            <p className="text-sm font-semibold">Getting started</p>
            <p className="text-xs text-muted-foreground">
              {done} of {steps.length} done
            </p>
          </div>
          <Progress value={(done / steps.length) * 100} className="w-32" />
          <ol className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {steps.map((s) => {
              const label = (
                <span className={cn("flex items-center gap-1.5", s.done ? "text-foreground" : "text-muted-foreground")}>
                  <span className={cn("grid size-4 place-items-center rounded-full border", s.done && "border-primary bg-primary text-primary-foreground")}>
                    {s.done && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  {s.label}
                </span>
              );
              return <li key={s.label}>{s.href && !s.done ? <Link href={s.href} className="hover:underline">{label}</Link> : label}</li>;
            })}
          </ol>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Tasks done this week" value={thisWeek.length} />
        <Kpi label="Tokens spent this week" value={thisWeek.reduce((n, t) => n + t.cost, 0)} className="text-token" />
        <Kpi label="AI employees" value={hires.length} />
        <Kpi label="Waiting for you" value={openApprovals} className={openApprovals ? "text-destructive" : undefined} highlight={openApprovals > 0} />
      </div>
    </div>
  );
}

function Kpi({ label, value, className, highlight }: { label: string; value: number; className?: string; highlight?: boolean }) {
  return (
    <div className={cn("rounded-xl border bg-card px-4 py-3", highlight && "border-destructive/40")}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("font-mono text-2xl font-medium tabular-nums", className)}>{value}</p>
    </div>
  );
}
