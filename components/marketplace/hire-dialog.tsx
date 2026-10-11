"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { api, ApiError } from "@/lib/client/api";
import { useKnowledge, useMe, type WithId } from "@/lib/client/firestore";
import { TOOL_LABELS } from "@/lib/tools";
import type { AgentDoc, HireDoc } from "@/types/firestore";

interface Props {
  agent: WithId<AgentDoc> | null;
  existing?: HireDoc;
  onClose(): void;
}

export function HireDialog({ agent, existing, onClose }: Props) {
  const router = useRouter();
  const me = useMe();
  const knowledge = useKnowledge();
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [triggerId, setTriggerId] = useState("");
  const [approvalMode, setApprovalMode] = useState<"ask" | "auto">("ask");
  const [access, setAccess] = useState<Set<string>>(new Set(["profile"]));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!agent) return;
    setTriggerId(existing?.trigger.id ?? agent.triggers[0]?.id ?? "");
    setApprovalMode(existing?.approvalMode ?? (agent.category === "Finance" ? "auto" : "ask"));
    setAccess(new Set(existing?.knowledgeAccess ?? ["profile"]));
    setConnected(new Set(existing ? agent.tools : []));
  }, [agent, existing]);

  if (!agent) return null;
  const allConnected = agent.tools.every((t) => connected.has(t));
  const hasProfile = !!me.data?.businessProfile;

  async function connect(tool: string) {
    setConnecting(tool);
    await new Promise((r) => setTimeout(r, 700)); // stands in for the OAuth consent screen
    setConnected((s) => new Set(s).add(tool));
    setConnecting(null);
  }

  async function save() {
    if (!agent) return;
    setSaving(true);
    try {
      await api("/api/hires", { json: { agentId: agent.slug, triggerId, approvalMode, knowledgeAccess: [...access] } });
      toast.success(existing ? `${agent.name}'s settings are saved.` : `${agent.name} joined your team.`, {
        action: { label: "Give it a task", onClick: () => router.push(`/workforce?agent=${agent.slug}`) },
      });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const toggle = (id: string, on: boolean) =>
    setAccess((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <AgentAvatar initials={agent.initials} />
          <div>
            <DialogTitle className="font-display text-xl">{existing ? `${agent.name} settings` : `Hire ${agent.name}`}</DialogTitle>
            <DialogDescription>{agent.tokensPerTask} tokens per finished task</DialogDescription>
          </div>
        </DialogHeader>

        <div className="grid gap-6 py-2">
          <Step n={1} title={`Connect ${agent.tools.map((t) => TOOL_LABELS[t]).join(" and ")}`}>
            <p className="text-sm text-muted-foreground">
              {agent.name} works inside your accounts. We keep the sign-in, never your password, and the agent itself never sees it.
            </p>
            {agent.tools.map((tool) => (
              <div key={tool} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                <span>{TOOL_LABELS[tool]}</span>
                {connected.has(tool) ? (
                  <span className="flex items-center gap-1 font-medium text-primary">
                    <Check className="size-4" /> Connected
                  </span>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => connect(tool)} disabled={!!connecting}>
                    {connecting === tool ? <Loader2 className="animate-spin" /> : <PlugZap />} Sign in
                  </Button>
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">Demo connections are simulated; no real account is linked.</p>
          </Step>

          <Step n={2} title="When should it work?">
            <RadioGroup value={triggerId} onValueChange={setTriggerId} className="gap-2">
              {agent.triggers.map((t) => (
                <Option key={t.id} id={`trigger-${t.id}`} value={t.id} label={t.label} />
              ))}
            </RadioGroup>
          </Step>

          <Step n={3} title="Before it acts">
            <RadioGroup value={approvalMode} onValueChange={(v) => setApprovalMode(v as "ask" | "auto")} className="gap-2">
              <Option id="mode-ask" value="ask" label="Ask me first" hint="Drafts wait in your approval inbox. Best for anything customers see." />
              <Option id="mode-auto" value="auto" label="Act on its own" hint="Everything it does shows in your task history." />
            </RadioGroup>
          </Step>

          <Step n={4} title="What can it see?">
            <label htmlFor="access-profile" className="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm">
              <Checkbox id="access-profile" checked={access.has("profile")} onCheckedChange={(v) => toggle("profile", v === true)} />
              <span>
                Business profile
                <span className="block text-xs text-muted-foreground">{hasProfile ? "What you sell, your audience and tone of voice" : "Not filled in yet. Add it under Company knowledge."}</span>
              </span>
            </label>
            {knowledge.data.map((k) => (
              <label key={k.id} htmlFor={`access-${k.id}`} className="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm">
                <Checkbox id={`access-${k.id}`} checked={access.has(k.id)} onCheckedChange={(v) => toggle(k.id, v === true)} />
                <span>
                  {k.name}
                  <span className="block text-xs text-muted-foreground">Company file · about {Math.round(k.approxTokens * 0.75).toLocaleString()} words</span>
                </span>
              </label>
            ))}
          </Step>

          <div className="flex flex-wrap justify-between gap-2 rounded-lg bg-token-soft px-4 py-3 text-sm text-token">
            <span>Estimate: about {agent.estTasksPerWeek} tasks a week</span>
            <span className="font-mono font-medium">≈ {agent.estTasksPerWeek * agent.tokensPerTask} tokens/week</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!allConnected || !triggerId || saving}>
            {saving && <Loader2 className="animate-spin" />}
            {existing ? "Save settings" : `Hire ${agent.name}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2.5">
      <h3 className="flex items-center gap-2 font-sans text-sm font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-accent font-mono text-xs text-accent-foreground">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Option({ id, value, label, hint }: { id: string; value: string; label: string; hint?: string }) {
  return (
    <Label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent">
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="text-sm">
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </Label>
  );
}
