"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Link2, Loader2, LogOut, MessageCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ShelfBadge } from "@/components/memory/shelf-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth";
import { useMe, useMembers, useOpenInvites, useTelegramLinks } from "@/lib/client/firestore";
import { toDate, when } from "@/lib/client/format";
import { DEFAULT_MEMORY_SETTINGS } from "@/lib/shelves";
import { SHELVES, type Role, type Shelf } from "@/types/firestore";

const ROLE_INFO: Record<Role, { label: string; can: string }> = {
  owner: { label: "Owner", can: "Everything, including tokens, roles and deleting the account" },
  manager: { label: "Manager", can: "Hire agents, approve drafts, connect tools, edit memory, invite members" },
  member: { label: "Member", can: "Give agents tasks and read everything" },
};

async function call(path: string, init: Parameters<typeof api>[1], done?: string) {
  try {
    const res = await api(path, init);
    if (done) toast.success(done);
    return res;
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    return null;
  }
}

export default function TeamPage() {
  const { role, user } = useAuth();
  const me = useMe();
  const isOwner = role === "owner";
  const canInvite = role === "owner" || role === "manager";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Team</p>
        <h1 className="mt-1 text-3xl font-extrabold sm:text-4xl">{me.data?.businessName ?? "Your business"}</h1>
        <p className="mt-2 text-muted-foreground">
          Everyone here shares one token wallet, the same hired agents and one company memory. Each person signs in with their own login.
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="grid gap-6">
          <Members isOwner={isOwner} />
          {!isOwner && role && <LeaveTeam />}
        </div>
        <div className="grid gap-6">
          {role && <TelegramCard />}
          {canInvite && (user?.isAnonymous ? <DemoNote /> : <Invites isOwner={isOwner} />)}
          {isOwner && <MemorySettings key={JSON.stringify(me.data?.memory ?? null)} />}
        </div>
      </div>
    </div>
  );
}

function Members({ isOwner }: { isOwner: boolean }) {
  const me = useMe();
  const members = useMembers();
  const { user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const ownerIsMe = me.data && user && me.data.id === user.uid;

  async function change(uid: string, role: "manager" | "member") {
    setBusy(uid);
    await call(`/api/team/members/${uid}`, { method: "PATCH", json: { role } }, "Role changed.");
    setBusy(null);
  }
  async function remove(uid: string, name: string) {
    setBusy(uid);
    await call(`/api/team/members/${uid}`, { method: "DELETE" }, `${name} was removed. They're back on their own account.`);
    setBusy(null);
  }

  return (
    <section className="grid gap-3 rounded-xl border bg-card p-5">
      <h2 className="font-display text-lg font-bold">People · {members.data.length + 1}</h2>
      <ul className="grid">
        <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t py-3 first:border-t-0">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">
              {me.data?.displayName ?? "Owner"} {ownerIsMe && <span className="text-muted-foreground">(you)</span>}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{me.data?.email || "Demo sandbox"}</span>
          </span>
          <RoleTag role="owner" />
        </li>
        {members.data.map((m) => (
          <li key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t py-3">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {m.displayName} {m.id === user?.uid && <span className="text-muted-foreground">(you)</span>}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {m.email} · joined {when(m.joinedAt)}
              </span>
            </span>
            {isOwner ? (
              <span className="flex items-center gap-1">
                <Select value={m.role} onValueChange={(v) => change(m.id, v as "manager" | "member")} disabled={busy === m.id}>
                  <SelectTrigger size="sm" aria-label={`${m.displayName}'s role`} className="w-[118px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="icon" variant="ghost" aria-label={`Remove ${m.displayName}`} onClick={() => remove(m.id, m.displayName)} disabled={busy === m.id}>
                  {busy === m.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                </Button>
              </span>
            ) : (
              <RoleTag role={m.role} />
            )}
          </li>
        ))}
      </ul>
      <dl className="grid gap-1.5 rounded-lg bg-secondary px-3 py-2.5 text-xs">
        {(Object.keys(ROLE_INFO) as Role[]).map((r) => (
          <div key={r} className="flex gap-2">
            <dt className="w-16 shrink-0 font-medium">{ROLE_INFO[r].label}</dt>
            <dd className="text-muted-foreground">{ROLE_INFO[r].can}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RoleTag({ role }: { role: Role }) {
  return <span className={role === "owner" ? "rounded-md bg-accent px-2 py-0.5 font-mono text-xs text-accent-foreground" : "rounded-md bg-secondary px-2 py-0.5 font-mono text-xs"}>{ROLE_INFO[role].label}</span>;
}

function Invites({ isOwner }: { isOwner: boolean }) {
  const invites = useOpenInvites();
  const [role, setRole] = useState<"manager" | "member">("member");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const linkFor = (token: string) => `${window.location.origin}/join/${token}`;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = (await call("/api/team/invites", { json: { role, label } })) as { token: string } | null;
    setBusy(false);
    if (res) {
      setLink(linkFor(res.token));
      setLabel("");
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Link copied. Send it to them; it works once, for 7 days.");
    } catch {
      toast.message("Select the link and copy it.");
    }
  }

  const open = invites.data.filter((i) => (toDate(i.expiresAt)?.getTime() ?? 0) > Date.now());

  return (
    <section className="grid gap-3 rounded-xl border bg-card p-5">
      <div>
        <h2 className="font-display text-lg font-bold">Invite someone</h2>
        <p className="mt-1 text-sm text-muted-foreground">Create a link and send it however you like. It works once and expires after 7 days.</p>
      </div>
      <form onSubmit={create} className="grid gap-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-label">Who is it for? (optional)</Label>
            <Input id="invite-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Priya, weekend barista" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "manager" | "member")}>
              <SelectTrigger id="invite-role" className="w-[118px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                {isOwner && <SelectItem value="manager">Manager</SelectItem>}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Link2 />} Create invite link
        </Button>
      </form>
      {link && (
        <div className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2">
          <Input readOnly value={link} aria-label="Invite link" className="h-8 bg-card font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button size="sm" onClick={() => copy(link)}>
            <Copy /> Copy
          </Button>
        </div>
      )}
      {open.length > 0 && (
        <ul className="grid gap-1.5">
          <li className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Unused links</li>
          {open.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {i.label || "Invite"} · {ROLE_INFO[i.role].label}
                <span className="text-xs text-muted-foreground"> · expires {toDate(i.expiresAt)?.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
              </span>
              <span className="flex shrink-0">
                <Button size="sm" variant="ghost" onClick={() => copy(linkFor(i.id))}>
                  Copy
                </Button>
                <Button size="sm" variant="ghost" onClick={() => call(`/api/team/invites/${i.id}`, { method: "DELETE" }, "Invite cancelled.")}>
                  Cancel
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TelegramCard() {
  const { user } = useAuth();
  const links = useTelegramLinks();
  const members = useMembers();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const mine = links.data.find((l) => l.uid === user?.uid);
  const names = Object.fromEntries([[me.data?.id ?? "", me.data?.displayName ?? "Owner"], ...members.data.map((m) => [m.id, m.displayName])]);

  async function connect() {
    setBusy(true);
    const res = (await call("/api/telegram/link", {})) as { url: string; expiresAt: string } | null;
    setBusy(false);
    if (res) {
      setLink(res);
      window.open(res.url, "_blank", "noopener");
    }
  }
  async function disconnect() {
    setBusy(true);
    await call("/api/telegram/link", { method: "DELETE" }, "Telegram disconnected.");
    setBusy(false);
  }

  return (
    <section className="grid gap-3 rounded-xl border bg-card p-5">
      <div>
        <h2 className="font-display text-lg font-bold">Telegram</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Message your team lead, Ada, from Telegram. She hands each request to the right agent and brings back results. Everyone connects their own
          Telegram and keeps their own role.
        </p>
      </div>
      {user?.isAnonymous ? (
        <p className="text-sm text-muted-foreground">Demo sandboxes can&apos;t connect Telegram. Create a free account to try it.</p>
      ) : mine ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
          <span>
            Connected as <b>{mine.username ? `@${mine.username}` : mine.firstName}</b>
          </span>
          <Button size="sm" variant="ghost" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <Button onClick={connect} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <MessageCircle />} Connect my Telegram
          </Button>
          {link && (
            <p className="text-xs text-muted-foreground">
              Telegram didn&apos;t open? Open this link on your phone. It works once, for 10 minutes:{" "}
              <span className="break-all font-mono text-foreground">{link.url}</span>
            </p>
          )}
        </div>
      )}
      {links.data.length > 0 && (
        <p className="text-xs text-muted-foreground">
          On Telegram: {links.data.map((l) => names[l.uid] ?? l.firstName).join(", ")}
        </p>
      )}
    </section>
  );
}

function DemoNote() {
  return (
    <section className="grid gap-2 rounded-xl border bg-card p-5">
      <h2 className="font-display text-lg font-bold">Invite someone</h2>
      <p className="text-sm text-muted-foreground">Demo sandboxes can&apos;t invite people. Create a free account to build a team that shares agents, tokens and memory.</p>
    </section>
  );
}

function MemorySettings() {
  const me = useMe();
  const initial = { ...DEFAULT_MEMORY_SETTINGS, ...me.data?.memory };
  const [enabled, setEnabled] = useState(initial.enabled);
  const [approve, setApprove] = useState<Set<Shelf>>(new Set(initial.approveShelves));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    await call("/api/memory/settings", { method: "PUT", json: { enabled, approveShelves: [...approve] } }, "Memory settings saved.");
    setBusy(false);
  }

  return (
    <section className="grid gap-3 rounded-xl border bg-card p-5">
      <div>
        <h2 className="font-display text-lg font-bold">Company memory</h2>
        <p className="mt-1 text-sm text-muted-foreground">Agents share what they learn so the next one doesn&apos;t start from scratch.</p>
      </div>
      <label htmlFor="memory-on" className="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm">
        <Checkbox id="memory-on" checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
        <span>
          Share memory between agents
          <span className="block text-xs text-muted-foreground">Off: agents neither read nor add facts. Saved facts are kept.</span>
        </span>
      </label>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">Check these before agents use them</span>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {SHELVES.map((s) => (
            <label key={s} htmlFor={`approve-${s}`} className="flex items-center gap-2">
              <Checkbox
                id={`approve-${s}`}
                checked={approve.has(s)}
                onCheckedChange={(v) =>
                  setApprove((x) => {
                    const next = new Set(x);
                    if (v === true) next.add(s);
                    else next.delete(s);
                    return next;
                  })
                }
              />
              <ShelfBadge shelf={s} />
            </label>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={busy}>
          {busy && <Loader2 className="animate-spin" />} Save
        </Button>
      </div>
    </section>
  );
}

function LeaveTeam() {
  const { refreshAccount } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function leave() {
    setBusy(true);
    if (await call("/api/team/leave", {}, "You left the team. This is your own account again.")) {
      await refreshAccount();
      router.push("/workforce");
    }
    setBusy(false);
  }
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-5">
      <p className="text-sm text-muted-foreground">Leaving takes you back to your own account. The team keeps its agents, tokens and memory.</p>
      <Button variant="outline" onClick={leave} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <LogOut />} Leave this team
      </Button>
    </section>
  );
}
