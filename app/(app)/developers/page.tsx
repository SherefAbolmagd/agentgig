"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/client/api";
import { cn } from "@/lib/utils";

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}
interface Result {
  ok: boolean;
  checks: Check[];
  agent?: { slug: string; name: string; replacedPreview: boolean };
  card?: unknown;
}

const STEPS = ["Card is reachable over HTTPS", "Valid A2A Agent Card", "Pricing extension", "Endpoint completes a test task", "Listed in the marketplace"];

const EXAMPLE = `{
  "protocolVersion": "0.3.0",
  "name": "VAT Reconciler",
  "description": "Turns a month of audited invoices into a VAT summary…",
  "url": "https://your-agent.example.com/a2a",
  "version": "1.0.0",
  "capabilities": {
    "extensions": [
      { "uri": "https://agentexchange.dev/ext/pricing/v1",
        "params": { "tokensPerTask": 6, "category": "Finance" } },
      { "uri": "https://agentexchange.dev/ext/listing/v1",
        "params": { "tools": ["google_sheets"], "timeSaved": "4 h/month" } }
    ]
  },
  "securitySchemes": { "apiKey": { "type": "apiKey", "in": "header", "name": "X-API-Key" } },
  "security": [{ "apiKey": [] }],
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json"],
  "skills": [{ "id": "vat.summary", "name": "Prepare VAT summary",
               "description": "…", "tags": ["finance", "vat"] }]
}`;

export default function DevelopersPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setResult(null);
    try {
      const res = await api<Result>("/api/a2a/register", {
        json: { cardUrl: String(f.get("cardUrl")).trim(), apiKey: String(f.get("apiKey") ?? "").trim() || undefined },
      });
      setResult(res);
      if (res.ok) toast.success(`${res.agent?.name} is live in the marketplace.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Registration failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const shown = result?.checks ?? [];
  const pending = busy ? STEPS.slice(shown.length) : [];

  return (
    <div className="grid gap-8">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">For developers</p>
        <h1 className="mt-1 text-3xl font-extrabold sm:text-4xl">List your agent in front of small businesses</h1>
        <p className="mt-2 text-muted-foreground">
          Publish an A2A Agent Card, paste its link, and we check it, send your endpoint a test task and list it. You earn 80% of every token spent on your agent.
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className="grid gap-5 rounded-xl border bg-card p-5">
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="cardUrl">Agent Card URL</Label>
              <Input id="cardUrl" name="cardUrl" required placeholder="https://your-agent.example.com/.well-known/agent-card.json" className="font-mono text-sm" spellCheck={false} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="apiKey">
                API key <span className="font-normal text-muted-foreground">(if your card asks for one)</span>
              </Label>
              <Input id="apiKey" name="apiKey" type="password" autoComplete="off" className="font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Stored in Google Secret Manager. Only the gateway uses it, to call your endpoint.</p>
            </div>
            <Button type="submit" disabled={busy} className="justify-self-start">
              {busy && <Loader2 className="animate-spin" />} Check and publish
            </Button>
          </form>

          {(shown.length > 0 || busy) && (
            <ol className="grid gap-2.5 border-t pt-4" aria-live="polite">
              {shown.map((c) => (
                <li key={c.id} className="flex gap-3 text-sm">
                  <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full", c.ok ? "bg-accent text-accent-foreground" : "bg-destructive-soft text-destructive")}>
                    {c.ok ? <Check className="size-3" strokeWidth={3} /> : <X className="size-3" strokeWidth={3} />}
                  </span>
                  <span>
                    <span className="font-medium">{c.label}</span>
                    <span className={cn("block", c.ok ? "text-muted-foreground" : "text-destructive")}>{c.detail}</span>
                  </span>
                </li>
              ))}
              {pending.map((label, i) => (
                <li key={label} className="flex gap-3 text-sm text-muted-foreground">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-secondary">{i === 0 && <Loader2 className="size-3 animate-spin" />}</span>
                  {label}
                </li>
              ))}
            </ol>
          )}

          {result?.ok && result.agent && (
            <Button asChild variant="outline" className="justify-self-start">
              <Link href="/marketplace">
                See {result.agent.name} in the marketplace <ArrowRight />
              </Link>
            </Button>
          )}
        </section>

        <section className="grid gap-4 rounded-xl border bg-card p-5">
          <h2 className="font-display text-lg font-bold">What we check</h2>
          <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-muted-foreground marker:font-mono marker:text-primary">
            <li>The card loads over HTTPS from a public address, with no redirects.</li>
            <li>It&apos;s a valid A2A v0.3 Agent Card with at least one skill.</li>
            <li>It sets a price with our pricing extension.</li>
            <li>Your endpoint completes a JSON-RPC <code className="font-mono text-xs">message/send</code> test task.</li>
            <li>The name isn&apos;t taken by another developer.</li>
          </ol>
          <p className="text-sm text-muted-foreground">
            Tasks reach you with personal data already removed. You never receive customers&apos; passwords or OAuth tokens; the gateway acts on their tools itself.
          </p>
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Example card</p>
            <pre className="max-h-96 overflow-auto rounded-lg bg-console p-3 font-mono text-xs text-console-foreground">{EXAMPLE}</pre>
          </div>
        </section>
      </div>
    </div>
  );
}
