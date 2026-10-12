"use client";
import { useEffect, useState } from "react";
import { Check, Loader2, PlugZap, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/client/api";
import { useConnections } from "@/lib/client/firestore";
import { PROVIDER_INFO, useIntegrationStatus, type Provider } from "@/lib/client/integrations";
import { cn } from "@/lib/utils";

/** Starts a connection: navigates to the provider's consent screen, or creates a demo connection. */
export async function connectProvider(provider: Provider, returnTo: string) {
  const res = await api<{ url?: string; simulated?: boolean }>(`/api/connections/${provider}/start`, { json: { returnTo } });
  if (res.url) window.location.assign(res.url);
  else toast.success(`${PROVIDER_INFO[provider].name} connected in demo mode.`, { description: "Deliveries are simulated until real keys are configured." });
}

export function ConnectionsPanel({ providers = ["google", "linkedin", "slack"], returnTo, compact }: { providers?: Provider[]; returnTo: string; compact?: boolean }) {
  const conns = useConnections();
  const status = useIntegrationStatus();
  const [busy, setBusy] = useState<Provider | null>(null);

  async function connect(p: Provider) {
    setBusy(p);
    try {
      await connectProvider(p, returnTo);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't start the connection.");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(p: Provider) {
    setBusy(p);
    try {
      await api(`/api/connections/${p}`, { method: "DELETE" });
      toast.success(`${PROVIDER_INFO[p].name} disconnected and its access removed.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't disconnect.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="grid gap-2">
      {providers.map((p) => {
        const c = conns.data.find((x) => x.provider === p);
        const demo = c?.secretRef === "simulated";
        const live = !!c && c.status === "active";
        return (
          <li key={p} className={cn("grid gap-2 rounded-lg border px-3 py-2.5", compact && "py-2")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {PROVIDER_INFO[p].name}
                  {c?.status === "expired" && <span className="ml-2 text-xs text-destructive">Expired, reconnect</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">{live ? c.accountLabel : PROVIDER_INFO[p].does}</p>
              </div>
              {live ? (
                <div className="flex items-center gap-2">
                  <span className={cn("flex items-center gap-1 text-xs font-medium", demo ? "text-token" : "text-primary")}>
                    <Check className="size-3.5" /> {demo ? "Demo" : "Connected"}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => disconnect(p)} disabled={busy === p} aria-label={`Disconnect ${PROVIDER_INFO[p].name}`}>
                    {busy === p ? <Loader2 className="animate-spin" /> : <Unplug />}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => connect(p)} disabled={busy === p || !status}>
                  {busy === p ? <Loader2 className="animate-spin" /> : <PlugZap />}
                  {status?.providers[p] ? `Connect ${PROVIDER_INFO[p].name}` : "Connect (demo)"}
                </Button>
              )}
            </div>
            {p === "slack" && live && !demo && <SlackChannelPicker current={c.meta?.defaultChannel as string | undefined} />}
          </li>
        );
      })}
    </ul>
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
      toast.success(`Agents will use #${ch?.name}.`, { description: ch && !ch.isMember ? `Invite the bot there: type /invite @AgentExchange in #${ch.name}.` : undefined });
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
