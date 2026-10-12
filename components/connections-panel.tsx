"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Check, Loader2, PlugZap, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/client/api";
import { useConnections } from "@/lib/client/firestore";
import { PROVIDER_INFO, PROVIDERS, useIntegrationStatus, type Provider } from "@/lib/client/integrations";
import { INTEGRATION_GROUPS } from "@/lib/integrations";
import { cn } from "@/lib/utils";

/** Starts a sign-in connection: navigates to the vendor's consent screen (or the WooCommerce store's approval page). */
export async function connectProvider(provider: Provider, returnTo: string, siteUrl?: string) {
  const res = await api<{ url: string }>(`/api/connections/${provider}/start`, { json: { returnTo, siteUrl } });
  window.location.assign(res.url);
}

const GROUPS = INTEGRATION_GROUPS;

export function ConnectionsPanel({ providers = [...PROVIDERS], returnTo, compact }: { providers?: Provider[]; returnTo: string; compact?: boolean }) {
  const conns = useConnections();
  const status = useIntegrationStatus();
  const [busy, setBusy] = useState<Provider | null>(null);
  const [open, setOpen] = useState<Provider | null>(null);

  async function run(p: Provider, fn: () => Promise<unknown>, fallback: string) {
    setBusy(p);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(null);
    }
  }

  const disconnect = (p: Provider) =>
    run(
      p,
      async () => {
        await api(`/api/connections/${p}`, { method: "DELETE" });
        toast.success(`${PROVIDER_INFO[p].name} disconnected and its access removed.`);
      },
      "Couldn't disconnect.",
    );

  async function submit(p: Provider, values: Record<string, string>) {
    const info = PROVIDER_INFO[p];
    await run(
      p,
      async () => {
        if (info.kind === "woo") return connectProvider(p, returnTo, values.siteUrl);
        const res = await api<{ accountLabel: string }>(`/api/connections/${p}/key`, { json: { fields: values } });
        toast.success(`${info.name} connected: ${res.accountLabel}`);
        setOpen(null);
      },
      `Couldn't connect ${info.name}.`,
    );
  }

  const row = (p: Provider) => {
    const info = PROVIDER_INFO[p];
    const c = conns.data.find((x) => x.provider === p);
    const live = !!c && c.status === "active" && c.secretRef !== "simulated";
    // Key and WooCommerce connections need no app credentials on our side.
    const available = info.kind !== "oauth" || !!status?.providers[p];
    return (
      <li key={p} className={cn("grid gap-2 rounded-lg border px-3 py-2.5", compact && "py-2")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-sm">
            <p className="flex items-center gap-2 font-medium">
              {info.name}
              {info.beta && (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  Beta
                </Badge>
              )}
              {c?.status === "expired" && <span className="text-xs text-destructive">Expired, reconnect</span>}
            </p>
            <p className="truncate text-xs text-muted-foreground">{live ? c.accountLabel : info.does}</p>
          </div>
          {live ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-xs font-medium text-primary">
                <Check className="size-3.5" /> Connected
              </span>
              <Button size="sm" variant="ghost" onClick={() => disconnect(p)} disabled={busy === p} aria-label={`Disconnect ${info.name}`}>
                {busy === p ? <Loader2 className="animate-spin" /> : <Unplug />}
              </Button>
            </div>
          ) : info.kind === "oauth" ? (
            <Button size="sm" variant="outline" onClick={() => run(p, () => connectProvider(p, returnTo), "Couldn't start the connection.")} disabled={busy === p || !available}>
              {busy === p ? <Loader2 className="animate-spin" /> : <PlugZap />}
              {available || !status ? `Connect ${info.name}` : "Not available yet"}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setOpen(open === p ? null : p)} aria-expanded={open === p}>
              <PlugZap />
              {open === p ? "Cancel" : `Connect ${info.name}`}
            </Button>
          )}
        </div>
        {!live && open === p && <KeyForm provider={p} busy={busy === p} onSubmit={(v) => submit(p, v)} />}
        {p === "slack" && live && <SlackChannelPicker current={c.meta?.defaultChannel as string | undefined} />}
      </li>
    );
  };

  if (compact || providers.length <= 3) return <ul className="grid gap-2">{providers.map(row)}</ul>;
  return (
    <div className="grid gap-5">
      {GROUPS.map((g) => {
        const inGroup = providers.filter((p) => PROVIDER_INFO[p].group === g);
        if (!inGroup.length) return null;
        return (
          <section key={g} className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</h3>
            <ul className="grid gap-2">{inGroup.map(row)}</ul>
          </section>
        );
      })}
    </div>
  );
}

/** Paste-a-key (or WooCommerce store address) form, with where to find each value. */
function KeyForm({ provider, busy, onSubmit }: { provider: Provider; busy: boolean; onSubmit(values: Record<string, string>): void }) {
  const info = PROVIDER_INFO[provider];
  const [values, setValues] = useState<Record<string, string>>({});
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
  }
  return (
    <form onSubmit={submit} className="grid gap-3 rounded-md bg-muted/50 p-3">
      {info.steps && (
        <ol className="grid list-decimal gap-1 pl-4 text-xs text-muted-foreground">
          {info.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {info.fields?.map((f) => (
        <div key={f.id} className="grid gap-1">
          <Label htmlFor={`${provider}-${f.id}`} className="text-xs">
            {f.label}
          </Label>
          <Input
            id={`${provider}-${f.id}`}
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={f.placeholder}
            required={!f.optional}
            value={values[f.id] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        {info.kind === "woo" ? "You'll approve access on your own site." : "We check it with one read-only call, then keep it in Google Secret Manager. It's never shown again."}
      </p>
      <Button type="submit" size="sm" disabled={busy} className="justify-self-start">
        {busy && <Loader2 className="animate-spin" />}
        {info.kind === "woo" ? "Continue to my store" : "Check and connect"}
      </Button>
    </form>
  );
}

function SlackChannelPicker({ current }: { current?: string }) {
  const [channels, setChannels] = useState<{ id: string; name: string; isMember: boolean }[] | null>(null);
  useEffect(() => {
    api<{ channels: { id: string; name: string; isMember: boolean }[] }>("/api/connections/slack/channels", { method: "GET" })
      .then((r) => setChannels(r.channels))
      .catch(() => setChannels([]));
  }, []);
  async function choose(channel: string) {
    try {
      await api("/api/connections/slack/channels", { method: "PUT", json: { channel } });
      const ch = channels?.find((c) => c.id === channel);
      toast.success(`Agents will use #${ch?.name}.`, { description: ch && !ch.isMember ? `Invite the bot there: type /invite @AgentGig in #${ch.name}.` : undefined });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save the channel.");
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      Channel for customer messages and posts
      <Select value={current} onValueChange={choose} disabled={!channels}>
        <SelectTrigger className="h-8 w-48" aria-label="Slack channel">
          <SelectValue placeholder={channels ? "Choose a channel" : "Loading…"} />
        </SelectTrigger>
        <SelectContent>
          {channels?.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              #{c.name}
              {!c.isMember && " (invite the bot)"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
