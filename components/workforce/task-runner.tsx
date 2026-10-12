"use client";
import { useRef, useState } from "react";
import { Clock, FileText, Loader2, Play, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/client/api";
import { DmConciergeForm, InventoryForm, OnboardingForm, ReviewForm, RotaForm } from "./agent-forms";
import type { WithId } from "@/lib/client/firestore";
import { TOOL_LABELS } from "@/lib/tools";
import { cn } from "@/lib/utils";
import type { AgentDoc, BusinessProfile, HireDoc } from "@/types/firestore";

const SAMPLE_INVOICE = "/samples/invoice-lumen-supplies.pdf";

interface Props {
  agent: WithId<AgentDoc>;
  hire: HireDoc;
  profile?: BusinessProfile;
  uid: string;
  busy: boolean;
  /** Called with the task ID before the request goes out, so the console can subscribe. */
  onStart(taskId: string): void;
  onFinish(): void;
  onSettings(): void;
}

export function TaskRunner({ agent, hire, profile, uid, busy, onStart, onFinish, onSettings }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const runnable = agent.source === "native" || !!agent.endpointUrl;
  const skillId = agent.skills[0]?.id;

  async function run(input: Record<string, unknown>, upload?: File) {
    const key = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    onStart(`${uid}_${key}`);
    try {
      let form: FormData | undefined;
      if (upload) {
        form = new FormData();
        form.set("agentId", agent.slug);
        form.set("input", JSON.stringify(input));
        form.set("file", upload);
      }
      const res = await api<{ status: string }>("/api/agents/execute", {
        headers: { "Idempotency-Key": key },
        ...(form ? { form } : { json: { agentId: agent.slug, input } }),
      });
      toast.success(res.status === "awaiting_approval" ? `${agent.name} finished. The draft is in your approval inbox.` : `${agent.name} finished the task.`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_TOKENS") {
        toast.error(err.message, { description: "Use “+ 500” in the top bar to top up." });
      } else {
        toast.error(err instanceof ApiError ? err.message : "The task didn't go through. Try again.");
      }
    } finally {
      onFinish();
    }
  }

  function submitEchoSocial(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run({
      brandUrl: String(f.get("brandUrl")),
      audience: String(f.get("audience")),
      tone: String(f.get("tone")),
      ...(String(f.get("topic")).trim() && { topic: String(f.get("topic")) }),
    });
  }

  const inboxInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);

  async function dropInInbox(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setDropping(true);
    try {
      const form = new FormData();
      list.forEach((f) => form.append("file", f));
      const res = await api<{ queued: number }>("/api/inbox", { form });
      toast.success(`${res.queued} invoice${res.queued > 1 ? "s" : ""} dropped in your inbox.`, {
        description: "ReceiptHero is working through them. Watch Recent tasks.",
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Upload failed. Try again.");
    } finally {
      setDropping(false);
      if (inboxInput.current) inboxInput.current.value = "";
    }
  }

  async function useSample() {
    const blob = await (await fetch(SAMPLE_INVOICE)).blob();
    setFile(new File([blob], "invoice-lumen-supplies.pdf", { type: "application/pdf" }));
  }

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
        <p className="min-w-0 flex-1">
          <Clock className="mr-1.5 inline size-4 -translate-y-px" />
          Works in {agent.tools.map((t) => TOOL_LABELS[t]).join(" and ")}: <b className="font-medium text-foreground">{hire.trigger.label}</b>, and{" "}
          {hire.approvalMode === "ask" ? "asks you first" : "acts on its own"}.
        </p>
        <button className="text-xs font-medium text-primary hover:underline" onClick={onSettings}>
          Change
        </button>
      </div>

      {!runnable && <p className="text-sm text-muted-foreground">{agent.name} is a preview listing. Its developer hasn&apos;t connected it yet.</p>}

      {runnable && agent.source === "a2a" && skillId === "vat.summary" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run({ period: String(new FormData(e.currentTarget).get("period")) });
          }}
          className="grid gap-3"
        >
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="period">Period</Label>
            <Select name="period" defaultValue="this-month">
              <SelectTrigger id="period" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="this-month">This month</SelectItem>
                <SelectItem value="last-month">Last month</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            <b className="font-medium text-foreground">Agent-to-agent handoff:</b> the invoices ReceiptHero audited in this period are sent to {agent.provider.name}&apos;s agent over
            A2A, with personal data removed. Invoices ReceiptHero flagged are held back.
          </p>
          <RunRow agent={agent} busy={busy} />
        </form>
      )}

      {runnable && agent.source === "a2a" && skillId !== "vat.summary" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run({ request: String(new FormData(e.currentTarget).get("request")) });
          }}
          className="grid gap-3"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="request">What should {agent.name} do?</Label>
            <Textarea id="request" name="request" rows={3} required maxLength={2000} placeholder={agent.skills[0]?.examples?.[0] ?? agent.skills[0]?.description} />
          </div>
          <RunRow agent={agent} busy={busy} />
        </form>
      )}

      {agent.slug === "dm-concierge" && <DmConciergeForm agent={agent} busy={busy} run={run} />}
      {agent.slug === "inventory-guardian" && <InventoryForm agent={agent} busy={busy} run={run} />}
      {agent.slug === "reviewpulse" && <ReviewForm agent={agent} busy={busy} run={run} />}
      {agent.slug === "rotabuilder" && <RotaForm agent={agent} busy={busy} run={run} />}
      {agent.slug === "onboarding-buddy" && <OnboardingForm agent={agent} busy={busy} run={run} />}

      {agent.slug === "echosocial" && (
        <form onSubmit={submitEchoSocial} className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="brandUrl">Your website</Label>
              <Input id="brandUrl" name="brandUrl" type="url" required defaultValue={profile?.website || "https://"} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="audience">Who should see it</Label>
              <Input id="audience" name="audience" required minLength={3} defaultValue={profile?.audience ?? ""} placeholder="e.g. Office managers in Leeds" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tone">Tone</Label>
              <Select name="tone" defaultValue="Friendly">
                <SelectTrigger id="tone" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["Friendly", "Confident", "Expert", "Playful"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="topic">
              What&apos;s it about? <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea id="topic" name="topic" rows={2} maxLength={300} placeholder="Leave empty and EchoSocial picks your most compelling offer" />
          </div>
          <RunRow agent={agent} busy={busy} />
        </form>
      )}

      {agent.slug === "receipthero" && hire.trigger.event === "inbox.file_created" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-accent/40 px-4 py-3">
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">Your invoice inbox</p>
            <p className="text-muted-foreground">Drop up to 10 invoices. Each one triggers ReceiptHero in the background, no clicks needed.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => inboxInput.current?.click()} disabled={dropping}>
            {dropping ? <Loader2 className="animate-spin" /> : <Upload />} Drop invoices
          </Button>
          <input
            ref={inboxInput}
            type="file"
            multiple
            hidden
            accept="application/pdf,image/jpeg,image/png,image/webp"
            aria-label="Drop invoices in your inbox"
            onChange={(e) => e.target.files && dropInInbox(e.target.files)}
          />
        </div>
      )}

      {agent.slug === "receipthero" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (file) run({}, file);
          }}
          className="grid gap-3"
        >
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) setFile(f);
            }}
            className={cn("flex flex-wrap items-center gap-4 rounded-lg border-2 border-dashed p-4", dragging && "border-primary bg-accent")}
          >
            <FileText className="size-8 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{file ? file.name : "Drop a receipt or invoice here"}</p>
              <p className="text-xs text-muted-foreground">{file ? `${Math.ceil(file.size / 1024)} KB` : "PDF, JPEG, PNG or WebP, up to 10 MB"}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <Upload /> Choose file
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={useSample}>
                Use sample invoice
              </Button>
            </div>
            <input ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <RunRow agent={agent} busy={busy} disabled={!file} />
        </form>
      )}
    </div>
  );
}

export function RunRow({ agent, busy, disabled }: { agent: AgentDoc; busy: boolean; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">You&apos;re only charged if the task succeeds.</p>
      <Button type="submit" disabled={busy || disabled}>
        {busy ? <Loader2 className="animate-spin" /> : <Play />} Run now · {agent.tokensPerTask} tokens
      </Button>
    </div>
  );
}
