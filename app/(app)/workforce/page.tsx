"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { HireDialog } from "@/components/marketplace/hire-dialog";
import { ApprovalInbox } from "@/components/workforce/approval-inbox";
import { RecentTasks, TokenHistory } from "@/components/workforce/history";
import { Overview } from "@/components/workforce/overview";
import { TaskConsole } from "@/components/workforce/task-console";
import { TaskResult } from "@/components/workforce/task-result";
import { TaskRunner } from "@/components/workforce/task-runner";
import { useAuth } from "@/lib/client/auth";
import { useAgents, useConnections, useHires, useMe, useOpenApprovals, useRecentTasks, useTask } from "@/lib/client/firestore";
import { PROVIDER_INFO, providerForTool, type Provider } from "@/lib/client/integrations";
import { greeting } from "@/lib/client/format";
import { cn } from "@/lib/utils";
import type { AgentDoc } from "@/types/firestore";

export default function WorkforcePage() {
  return (
    <Suspense>
      <Workforce />
    </Suspense>
  );
}

function Workforce() {
  const params = useSearchParams();
  const { user } = useAuth();
  const me = useMe();
  const agentsQ = useAgents();
  const hires = useHires();
  const tasks = useRecentTasks(30);
  const approvals = useOpenApprovals();

  const agents = useMemo(() => new Map(agentsQ.data.map((a) => [a.slug, a])), [agentsQ.data]);
  const team = hires.data.flatMap((h) => {
    const a = agents.get(h.agentId);
    return a ? [{ hire: h, agent: { ...a, id: a.slug } }] : [];
  });

  const [picked, setPicked] = useState<string | null>(params.get("agent"));
  const selected = team.find((m) => m.agent.slug === picked) ?? team[0];
  const [taskId, setTaskId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [settingsFor, setSettingsFor] = useState<typeof selected | null>(null);
  const shownTaskId = taskId ?? tasks.data.find((t) => t.agentId === selected?.agent.slug)?.id ?? null;
  const task = useTask(shownTaskId);

  const name = me.data?.displayName?.split(" ")[0];
  const conns = useConnections();
  const providers = [...new Set(team.flatMap((m) => m.agent.tools.map(providerForTool)).filter((p): p is Provider => !!p))];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">My workforce · {me.data?.businessName}</p>
        <h1 className="mt-1 text-3xl font-extrabold sm:text-4xl">
          {greeting()}
          {name ? `, ${name}` : ""}
        </h1>
        <p className="mt-1 text-muted-foreground">Here&apos;s what your AI team did and what needs you.</p>
      </div>

      <Overview me={me.data} hires={hires.data} tasks={tasks.data} openApprovals={approvals.data.length} />
      <ApprovalInbox agents={agents} onOpenTask={setTaskId} />

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <aside className="grid grid-cols-[minmax(0,1fr)] gap-6">
          <section className="rounded-xl border bg-card">
            <header className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="font-display text-base font-bold">Your AI employees</h2>
              <span className="text-xs text-muted-foreground">{team.length} working</span>
            </header>
            <ul className="p-1.5">
              {team.map(({ agent, hire }) => (
                <li key={agent.slug}>
                  <button
                    aria-pressed={selected?.agent.slug === agent.slug}
                    onClick={() => {
                      setPicked(agent.slug);
                      setTaskId(null);
                    }}
                    className={cn("flex w-full items-center gap-3 rounded-lg p-2.5 text-left hover:bg-secondary", selected?.agent.slug === agent.slug && "bg-accent hover:bg-accent")}
                  >
                    <AgentAvatar initials={agent.initials} className="size-9 text-xs" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{agent.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {hire.trigger.label} · {hire.approvalMode === "ask" ? "asks first" : "acts alone"}
                      </span>
                    </span>
                    <span className="font-mono text-xs text-token">{agent.tokensPerTask}T</span>
                  </button>
                </li>
              ))}
              <li>
                <Link href="/marketplace" className="flex items-center justify-center gap-1.5 rounded-lg p-2.5 text-sm font-medium text-primary hover:bg-secondary">
                  <Plus className="size-4" /> Hire another
                </Link>
              </li>
            </ul>
            {providers.length > 0 && (
              <div className="grid gap-1.5 border-t px-4 py-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tools</p>
                {providers.map((p) => {
                  const c = conns.data.find((x) => x.provider === p && x.status === "active");
                  const state = !c ? "Not connected" : c.secretRef === "simulated" ? "Demo" : "Connected";
                  return (
                    <p key={p} className="flex justify-between">
                      {PROVIDER_INFO[p].name}
                      <span className={cn("font-medium", state === "Connected" ? "text-primary" : state === "Demo" ? "text-token" : "text-muted-foreground")}>{state}</span>
                    </p>
                  );
                })}
                <Link href="/knowledge" className="text-xs font-medium text-primary hover:underline">
                  Manage connections
                </Link>
              </div>
            )}
          </section>
          <RecentTasks tasks={tasks.data} agents={agents} activeId={shownTaskId} onOpen={setTaskId} />
        </aside>

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
          {selected ? (
            <section className="rounded-xl border bg-card">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                <h2 className="font-display text-base font-bold">Give {selected.agent.name} a task</h2>
                <span className="text-xs text-muted-foreground">
                  {selected.agent.model && <span className="font-mono">gemini-2.5-{selected.agent.model} · </span>}
                  {selected.agent.tokensPerTask} tokens per task
                </span>
              </header>
              <TaskRunner
                key={selected.agent.slug}
                agent={selected.agent}
                hire={selected.hire}
                profile={me.data?.businessProfile}
                uid={user!.uid}
                busy={starting}
                onStart={(id) => {
                  setTaskId(id);
                  setStarting(true);
                }}
                onFinish={() => setStarting(false)}
                onSettings={() => setSettingsFor(selected)}
              />
            </section>
          ) : (
            !hires.loading && (
              <section className="rounded-xl border border-dashed bg-card p-10 text-center">
                <h2 className="font-display text-xl font-bold">Your team is empty</h2>
                <p className="mt-1 text-muted-foreground">Hire your first AI employee from the marketplace. It takes about a minute.</p>
                <Link href="/marketplace" className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
                  Browse the marketplace
                </Link>
              </section>
            )
          )}

          <TaskConsole task={task.data} agentName={task.data ? agents.get(task.data.agentId)?.name : selected?.agent.name} starting={starting && !task.data} />

          <section className="rounded-xl border bg-card">
            <header className="border-b px-4 py-3">
              <h2 className="font-display text-base font-bold">Result</h2>
            </header>
            <TaskResult task={task.data} businessName={me.data?.businessName ?? "Your business"} />
          </section>

          <TokenHistory agents={agents} />
        </div>
      </div>

      {settingsFor && <HireDialog agent={settingsFor.agent as AgentDoc & { id: string }} existing={settingsFor.hire} onClose={() => setSettingsFor(null)} />}
    </div>
  );
}
