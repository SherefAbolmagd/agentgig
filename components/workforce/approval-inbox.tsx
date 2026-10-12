"use client";
import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/client/api";
import { useOpenApprovals, useTask, type WithId } from "@/lib/client/firestore";
import { when } from "@/lib/client/format";
import { cn } from "@/lib/utils";
import type { AgentDoc, ApprovalDoc } from "@/types/firestore";

export function ApprovalInbox({ agents, onOpenTask }: { agents: Map<string, AgentDoc>; onOpenTask(taskId: string): void }) {
  const approvals = useOpenApprovals();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<WithId<ApprovalDoc> | null>(null);

  async function decide(a: WithId<ApprovalDoc>, action: "approve" | "skip", editedText?: string, postNow?: boolean) {
    setBusy(a.id);
    try {
      await api(`/api/approvals/${a.id}`, { json: { action, editedText, postNow } });
      const name = agents.get(a.agentId)?.name ?? "The agent";
      toast.success(action === "approve" ? `Done. ${name} is carrying it out.` : "Skipped. Nothing was sent.");
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save your decision. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-display text-base font-bold">Needs your approval</h2>
        <span className="text-xs text-muted-foreground">Agents pause here until you decide</span>
      </header>
      {approvals.data.length === 0 ? (
        <p className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-primary" /> You&apos;re all caught up. New drafts and decisions appear here.
        </p>
      ) : (
        <ul>
          {approvals.data.map((a) => {
            const agent = agents.get(a.agentId);
            return (
              <li key={a.id} className="grid gap-3 border-t px-4 py-3.5 first:border-t-0 sm:grid-cols-[auto_1fr_auto] sm:items-center">
                <AgentAvatar initials={agent?.initials ?? "?"} className="size-9 text-xs" />
                <button className="min-w-0 text-left" onClick={() => onOpenTask(a.taskId)}>
                  <p className="text-sm font-semibold">
                    <span className={cn("mr-1.5 text-[11px] uppercase tracking-wide", a.severity === "check" ? "text-destructive" : "text-primary")}>
                      {a.severity === "check" ? "Check" : "Ready"}
                    </span>
                    {a.title}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {agent?.name} · {when(a.createdAt)} · {a.preview}
                  </p>
                </button>
                <div className="flex flex-wrap gap-1.5">
                  {a.actions.map((act, i) => (
                    <Button
                      key={act.id}
                      size="sm"
                      variant={i === 0 ? "default" : "outline"}
                      disabled={busy === a.id}
                      onClick={() => (act.kind === "edit" ? setEditing(a) : decide(a, act.kind === "skip" ? "skip" : "approve", undefined, act.id === "post_now"))}
                    >
                      {busy === a.id && i === 0 && <Loader2 className="animate-spin" />}
                      {act.label}
                    </Button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && <EditDialog approval={editing} busy={busy === editing.id} onCancel={() => setEditing(null)} onSave={(text) => decide(editing, "approve", text)} />}
    </section>
  );
}

function EditDialog({ approval, busy, onCancel, onSave }: { approval: WithId<ApprovalDoc>; busy: boolean; onCancel(): void; onSave(text: string): void }) {
  const task = useTask(approval.taskId);
  const field = approval.editField ?? "text";
  const original = (task.data?.output?.[field] as string | undefined) ?? "";
  const [text, setText] = useState<string | null>(null);
  const value = text ?? original;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display">Edit before approving</DialogTitle>
          <DialogDescription>Your edits are kept as examples, so this agent writes closer to your style next time.</DialogDescription>
        </DialogHeader>
        <Textarea value={value} onChange={(e) => setText(e.target.value)} rows={14} className="font-sans text-sm" aria-label="Text to approve" />
        <p className="text-right font-mono text-xs text-muted-foreground">{value.length} / 3000</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onSave(value)} disabled={busy || !value.trim() || value.length > 3000}>
            {busy && <Loader2 className="animate-spin" />} Approve my version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
