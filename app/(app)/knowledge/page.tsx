"use client";
import { useRef, useState } from "react";
import { FileText, Loader2, ShieldCheck, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/client/api";
import { useKnowledge, useMe } from "@/lib/client/firestore";
import { when } from "@/lib/client/format";
import { BusinessProfileSchema } from "@/lib/profile";
import type { BusinessProfile } from "@/types/firestore";

export default function KnowledgePage() {
  const me = useMe();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Company knowledge</p>
        <h1 className="mt-1 text-3xl font-extrabold sm:text-4xl">Teach your team about your business</h1>
        <p className="mt-2 text-muted-foreground">
          Agents only see what you tick when you hire them. Emails, phone and card numbers are removed from text before any agent reads it.
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {me.loading ? <Skeleton className="h-[640px] rounded-xl" /> : <ProfileForm key={me.data?.businessName} businessName={me.data?.businessName ?? ""} profile={me.data?.businessProfile} />}
        <Files />
      </div>
    </div>
  );
}

const FIELDS: { name: keyof BusinessProfile; label: string; hint: string; multiline?: boolean }[] = [
  { name: "description", label: "What does your business do?", hint: "Two or three sentences, the way you'd tell a new customer.", multiline: true },
  { name: "products", label: "What do you sell?", hint: "Products or services, with prices if you're happy to share them.", multiline: true },
  { name: "audience", label: "Who are your customers?", hint: "e.g. Office managers at 10–80 person companies in Manchester" },
  { name: "toneOfVoice", label: "How do you sound?", hint: "e.g. Friendly and down to earth, never corporate" },
  { name: "website", label: "Website", hint: "https://…" },
  { name: "location", label: "Location", hint: "City or area you serve" },
  { name: "openingHours", label: "Opening hours", hint: "e.g. Mon–Fri 07:00–17:00" },
  { name: "timeZone", label: "Time zone", hint: "Used to schedule posts, e.g. Europe/London" },
];

function ProfileForm({ businessName, profile }: { businessName: string; profile?: BusinessProfile }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const raw = {
      businessName: String(f.get("businessName") ?? ""),
      ...Object.fromEntries(FIELDS.map((x) => [x.name, String(f.get(x.name) ?? "").trim() || undefined])),
      avoidWords: String(f.get("avoidWords") ?? "")
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean),
    };
    const parsed = BusinessProfileSchema.safeParse(raw);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api("/api/profile", { method: "PUT", json: parsed.data });
      toast.success("Saved. Agents with access will use it from their next task.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-xl border bg-card p-5" noValidate>
      <h2 className="font-display text-lg font-bold">Business profile</h2>
      <Field name="businessName" label="Business name" error={errors.businessName}>
        <Input id="businessName" name="businessName" defaultValue={businessName} />
      </Field>
      {FIELDS.map((x) => (
        <Field key={x.name} name={x.name} label={x.label} hint={x.hint} error={errors[x.name]}>
          {x.multiline ? (
            <Textarea id={x.name} name={x.name} rows={3} defaultValue={(profile?.[x.name] as string) ?? ""} />
          ) : (
            <Input id={x.name} name={x.name} defaultValue={(profile?.[x.name] as string) ?? ""} />
          )}
        </Field>
      ))}
      <Field name="avoidWords" label="Words to avoid" hint="Comma-separated. Agents will never use them." error={errors.avoidWords}>
        <Input id="avoidWords" name="avoidWords" defaultValue={profile?.avoidWords.join(", ") ?? ""} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />} Save profile
        </Button>
      </div>
    </form>
  );
}

function Field({ name, label, hint, error, children }: { name: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Files() {
  const files = useKnowledge();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function upload(file: File) {
    setUploading(true);
    const form = new FormData();
    form.set("file", file);
    try {
      const res = await api<{ dlpFindings: { infoType: string; count: number }[] }>("/api/knowledge", { form });
      const removed = res.dlpFindings.reduce((n, f) => n + f.count, 0);
      toast.success(`${file.name} added.`, {
        description: removed ? `Removed ${removed} piece${removed > 1 ? "s" : ""} of personal data first.` : "Tick it when hiring an agent to share it.",
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Upload failed. Try again.");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(id: string, name: string) {
    setDeleting(id);
    try {
      await api(`/api/knowledge/${id}`, { method: "DELETE" });
      toast.success(`${name} deleted.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't delete. Try again.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="grid gap-4 rounded-xl border bg-card p-5">
      <div>
        <h2 className="font-display text-lg font-bold">Files</h2>
        <p className="mt-1 text-sm text-muted-foreground">FAQs, price lists, menus, policies or past posts. PDF, TXT, Markdown or CSV, up to 5 MB each.</p>
      </div>
      <Button variant="outline" onClick={() => input.current?.click()} disabled={uploading}>
        {uploading ? <Loader2 className="animate-spin" /> : <Upload />} Upload a file
      </Button>
      <input ref={input} type="file" hidden accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />

      {files.data.length === 0 && !files.loading ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No files yet. Start with your FAQ; it&apos;s what customers ask most.</p>
      ) : (
        <ul className="grid gap-2">
          {files.data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <FileText className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.name}</p>
                <p className="text-xs text-muted-foreground">
                  ~{Math.round(f.approxTokens * 0.75).toLocaleString()} words · {when(f.createdAt)}
                  {f.dlpFindings.length > 0 && (
                    <span className="ml-1 inline-flex items-center gap-1 text-primary">
                      · <ShieldCheck className="size-3" /> personal data removed
                    </span>
                  )}
                </p>
              </div>
              <Button size="icon" variant="ghost" aria-label={`Delete ${f.name}`} onClick={() => remove(f.id, f.name)} disabled={deleting === f.id}>
                {deleting === f.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
