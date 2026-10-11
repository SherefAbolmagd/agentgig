"use client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS, TONE_CLASSES, when } from "@/lib/client/format";
import { useTransactions, type WithId } from "@/lib/client/firestore";
import { cn } from "@/lib/utils";
import type { AgentDoc, TaskDoc } from "@/types/firestore";

export function RecentTasks({
  tasks,
  agents,
  activeId,
  onOpen,
}: {
  tasks: WithId<TaskDoc>[];
  agents: Map<string, AgentDoc>;
  activeId: string | null;
  onOpen(id: string): void;
}) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="border-b px-4 py-3">
        <h2 className="font-display text-base font-bold">Recent tasks</h2>
      </header>
      {tasks.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">No tasks yet. Your agents&apos; work will be listed here.</p>
      ) : (
        <ul className="max-h-96 overflow-y-auto">
          {tasks.map((t) => {
            const s = STATUS[t.status];
            return (
              <li key={t.id}>
                <button
                  onClick={() => onOpen(t.id)}
                  className={cn("flex w-full items-center gap-3 border-t px-4 py-2.5 text-left text-sm first:border-t-0 hover:bg-secondary", activeId === t.id && "bg-accent")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{agents.get(t.agentId)?.name ?? t.agentId}</span>
                    <span className="text-xs text-muted-foreground">
                      {when(t.createdAt)}
                      {t.origin === "event" && " · from inbox"}
                      {t.origin === "schedule" && " · scheduled"}
                    </span>
                  </span>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", TONE_CLASSES[s.tone])}>{s.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const TYPE_LABEL = { topup: "Top-up", hold: "Held", charge: "Charged", release: "Returned" } as const;

export function TokenHistory({ agents }: { agents: Map<string, AgentDoc> }) {
  const txns = useTransactions(25);
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-display text-base font-bold">Token history</h2>
        <span className="text-xs text-muted-foreground">Tokens are held when a task starts and charged only when it finishes</span>
      </header>
      <div className="max-h-96 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>What</TableHead>
              <TableHead className="text-right">Change</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {txns.data.map((x) => (
              <TableRow key={x.id}>
                <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{when(x.createdAt)}</TableCell>
                <TableCell className="text-sm">
                  <span className="font-medium">{TYPE_LABEL[x.type]}</span>{" "}
                  <span className="text-muted-foreground">· {x.agentId ? agents.get(x.agentId)?.name ?? x.agentId : x.description}</span>
                </TableCell>
                <TableCell className={cn("text-right font-mono text-sm", x.amount > 0 ? "text-primary" : x.amount < 0 ? "text-destructive" : "text-muted-foreground")}>
                  {x.type === "charge" ? <span title="Already taken from your balance when it was held">settled</span> : x.amount > 0 ? `+${x.amount}` : `−${-x.amount}`}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">{x.balanceAfter}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
