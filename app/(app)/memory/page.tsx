"use client";
import { useMemo, useState } from "react";
import { Check, Loader2, Pencil, Pin, PinOff, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/brand";
import { ShelfBadge } from "@/components/memory/shelf-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth";
import { useAgents, useHires, useMe, useMemory, type WithId } from "@/lib/client/firestore";
import { toDate, when } from "@/lib/client/format";
import { DEFAULT_MEMORY_SETTINGS, SHELF_INFO } from "@/lib/shelves";
import { cn } from "@/lib/utils";
import { SHELVES, type MemoryDoc, type Shelf } from "@/types/firestore";

type Fact = WithId<MemoryDoc>;

export default function MemoryPage() {
  const { role } = useAuth();
  const me = useMe();
  const memory = useMemory();
  const agents = useAgents();
  const hires = useHires();
  const [shelf, setShelf] = useState<Shelf | "all">("all");
  const canEdit = role === "owner" || role === "manager";
  const settings = { ...DEFAULT_MEMORY_SETTINGS, ...me.data?.memory };

  const names = useMemo(() => Object.fromEntries(agents.data.map((a) => [a.slug, a])), [agents.data]);
  const now = Date.now();
  const pending = memory.data.filter((m) => m.status === "pending");
  const saved = memory.data
    .filter((m) => m.status === "saved" && (!m.expiresAt || (toDate(m.expiresAt)?.getTime() ?? 0) > now))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const counts = Object.fromEntries(SHELVES.map((s) => [s, saved.filter((m) => m.shelf === s).length])) as Record<Shelf, number>;
  const shown = shelf === "all" ? saved : saved.filter((m) => m.shelf === shelf);
  const readers = hires.data.filter((h) => (h.memory?.read.length ?? 1) > 0).length;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Company memory</p>
        <h1 className="mt-1 text-3xl font-extrabold sm:text-4xl">What your agents know</h1>
        <p className="mt-2 text-muted-foreground">
          When one agent learns something, the others use it on their next task. Each agent only reads the shelves you chose when you hired it, and
          personal details are removed before anything is saved.
        </p>
        {!settings.enabled && (
          <p className="mt-3 rounded-lg bg-token-soft px-3 py-2 text-sm text-token">Company memory is switched off. Agents don&apos;t read or add facts until the owner turns it back on under Team.</p>
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          {pending.length > 0 && (
            <section className="grid gap-2 rounded-xl border border-token/40 bg-token-soft/60 p-4" aria-label="Waiting for your OK">
              <h2 className="font-sans text-sm font-semibold">Waiting for your OK · {pending.length}</h2>
              <p className="text-xs text-muted-foreground">Facts for {settings.approveShelves.map((s) => SHELF_INFO[s].label).join(" and ") || "these shelves"} are checked by a person before any agent sees them.</p>
              <ul className="grid gap-2">
                {pending.map((f) => (
                  <PendingRow key={f.id} fact={f} canEdit={canEdit} />
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by shelf">
              <Chip on={shelf === "all"} onClick={() => setShelf("all")}>
                All {saved.length}
              </Chip>
              {SHELVES.map((s) => (
                <Chip key={s} on={shelf === s} onClick={() => setShelf(s)}>
                  {SHELF_INFO[s].label} {counts[s]}
                </Chip>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">Read by {readers} agent{readers === 1 ? "" : "s"} on your team</span>
          </div>

          {memory.loading ? (
            <Skeleton className="h-72 rounded-xl" />
          ) : shown.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              {saved.length === 0
                ? "Nothing here yet. Facts appear after your agents finish tasks, or add one yourself, like this month's promotion."
                : `No facts on the ${SHELF_INFO[shelf as Shelf].label} shelf yet.`}
            </p>
          ) : (
            <ul className="grid overflow-hidden rounded-xl border bg-card">
              {shown.map((f) => (
                <FactRow key={f.id} fact={f} canEdit={canEdit} agentName={(slug) => names[slug]?.name ?? slug} />
              ))}
            </ul>
          )}
        </div>

        <div className="grid gap-6">
          {canEdit ? <AddFact /> : <p className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">You can read company memory. An owner or manager can add, edit or forget facts.</p>}
          <section className="grid gap-3 rounded-xl border bg-card p-5">
            <h2 className="font-display text-lg font-bold">Shelves</h2>
            <ul className="grid gap-2.5">
              {SHELVES.map((s) => (
                <li key={s} className="grid gap-1">
                  <span className="flex items-center gap-2">
                    <ShelfBadge shelf={s} />
                    {settings.approveShelves.includes(s) && <span className="text-xs text-token">needs approval</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">{SHELF_INFO[s].hint}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("rounded-full border px-3 py-1 text-xs font-medium tabular-nums text-muted-foreground hover:text-foreground", on && "border-foreground bg-foreground text-background hover:text-background")}
    >
      {children}
    </button>
  );
}

function sourceLabel(f: Fact, agentName?: (slug: string) => string) {
  return f.source.kind === "agent" ? (agentName?.(f.source.agentId) ?? f.source.agentName) : f.source.name;
}

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

async function call(path: string, init: Parameters<typeof api>[1], done: string) {
  try {
    await api(path, init);
    toast.success(done);
    return true;
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    return false;
  }
}

function PendingRow({ fact, canEdit }: { fact: Fact; canEdit: boolean }) {
  const [busy, setBusy] = useState<"approve" | "discard" | null>(null);
  async function act(kind: "approve" | "discard") {
    setBusy(kind);
    const ok =
      kind === "approve"
        ? await call(`/api/memory/${fact.id}`, { method: "PATCH", json: { action: "approve" } }, "Saved. Agents will use it from their next task.")
        : await call(`/api/memory/${fact.id}`, { method: "DELETE" }, "Discarded.");
    if (!ok) setBusy(null);
  }
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{fact.fact}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <ShelfBadge shelf={fact.shelf} /> {sourceLabel(fact)} · {when(fact.createdAt)}
        </p>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => act("discard")} disabled={!!busy}>
            {busy === "discard" ? <Loader2 className="animate-spin" /> : <X />} Discard
          </Button>
          <Button size="sm" onClick={() => act("approve")} disabled={!!busy}>
            {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Remember it
          </Button>
        </div>
      )}
    </li>
  );
}

function FactRow({ fact, canEdit, agentName }: { fact: Fact; canEdit: boolean; agentName(slug: string): string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.fact);
  const [busy, setBusy] = useState<string | null>(null);
  const who = sourceLabel(fact, agentName);
  const expires = toDate(fact.expiresAt);
  const usedBy = (fact.usedBy ?? []).map(agentName);

  async function run(kind: string, path: string, init: Parameters<typeof api>[1], done: string) {
    setBusy(kind);
    const ok = await call(path, init, done);
    setBusy(null);
    return ok;
  }

  return (
    <li className="grid gap-2 border-t px-4 py-3 first:border-t-0">
      {editing ? (
        <div className="grid gap-2">
          <Label htmlFor={`edit-${fact.id}`} className="sr-only">
            Edit fact
          </Label>
          <Textarea id={`edit-${fact.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={300} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setText(fact.fact))}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy === "edit" || text.trim().length < 8}
              onClick={async () => (await run("edit", `/api/memory/${fact.id}`, { method: "PATCH", json: { action: "edit", fact: text } }, "Fact updated.")) && setEditing(false)}
            >
              {busy === "edit" && <Loader2 className="animate-spin" />} Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-[15px] font-medium">
            {fact.pinned && <span className="mr-1.5 font-mono text-[11px] font-medium text-token">Pinned ·</span>}
            {fact.fact}
          </p>
          {canEdit && (
            <div className="-mr-2 -mt-1 flex shrink-0">
              <Button
                size="icon"
                variant="ghost"
                aria-label={fact.pinned ? "Unpin" : "Pin: every agent reading this shelf always gets it"}
                title={fact.pinned ? "Unpin" : "Pin: always given to agents reading this shelf"}
                disabled={busy === "pin"}
                onClick={() => run("pin", `/api/memory/${fact.id}`, { method: "PATCH", json: { action: "pin", pinned: !fact.pinned } }, fact.pinned ? "Unpinned." : "Pinned.")}
              >
                {fact.pinned ? <PinOff /> : <Pin />}
              </Button>
              <Button size="icon" variant="ghost" aria-label="Edit" title="Edit" onClick={() => setEditing(true)}>
                <Pencil />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Forget"
                title="Forget"
                disabled={busy === "forget"}
                onClick={() => run("forget", `/api/memory/${fact.id}`, { method: "DELETE" }, "Forgotten. No agent will see it again.")}
              >
                {busy === "forget" ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <ShelfBadge shelf={fact.shelf} />
        <span className="inline-flex items-center gap-1.5">
          <AgentAvatar initials={initialsOf(who)} className={cn("size-5 rounded-[5px] text-[9px]", fact.source.kind === "person" && "bg-you-soft text-you")} />
          {who} · {when(fact.updatedAt)}
        </span>
        {usedBy.length > 0 && <span>Used by {usedBy.join(", ")}</span>}
        {expires && <span>Forgets after {expires.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</span>}
      </div>
    </li>
  );
}

function AddFact() {
  const [shelf, setShelf] = useState<Shelf>("brand");
  const [fact, setFact] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await call("/api/memory", { json: { shelf, fact, expiresOn: until || null } }, "Added. Agents reading that shelf will use it from their next task.");
    setBusy(false);
    if (ok) {
      setFact("");
      setUntil("");
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-xl border bg-card p-5">
      <div>
        <h2 className="font-display text-lg font-bold">Add a fact</h2>
        <p className="mt-1 text-sm text-muted-foreground">Tell every agent something at once, like a promotion, a supplier change or who&apos;s on holiday.</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="fact-text">Fact</Label>
        <Textarea id="fact-text" rows={3} value={fact} onChange={(e) => setFact(e.target.value)} maxLength={300} placeholder="October promotion: autumn spiced latte, £3.60, any milk." />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="fact-shelf">Shelf</Label>
          <Select value={shelf} onValueChange={(v) => setShelf(v as Shelf)}>
            <SelectTrigger id="fact-shelf" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHELVES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SHELF_INFO[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="fact-until">True until (optional)</Label>
          <Input id="fact-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} min={new Date().toISOString().slice(0, 10)} />
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || fact.trim().length < 8}>
          {busy && <Loader2 className="animate-spin" />} Add to memory
        </Button>
      </div>
    </form>
  );
}
