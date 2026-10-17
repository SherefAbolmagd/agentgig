"use client";

import { useEffect, useState } from "react";
import { Loader2, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Review {
  id: string;
  rating: number;
  name: string;
  text: string;
  createdAt: string;
  reply: { text: string; at: string } | null;
}

const REFRESH_MS = 4000;

function Stars({ value, size = "size-4" }: { value: number; size?: string }) {
  return (
    <span className="flex gap-0.5" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cn(size, n <= value ? "fill-token text-token" : "text-muted-foreground/40")} />
      ))}
    </span>
  );
}

const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** The form and the list; replies appear by themselves once the business approves them. */
export function ReviewBoard({ slug, businessName, initial }: { slug: string; businessName: string; initial: Review[] }) {
  const [reviews, setReviews] = useState(initial);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const id = setInterval(async () => {
      const res = await fetch(`/api/reviews/${slug}`, { cache: "no-store" }).catch(() => null);
      if (res?.ok) setReviews(((await res.json()) as { reviews: Review[] }).reviews);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!rating) return setError("Choose a star rating.");
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/reviews/${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating, name, text, ...(website && { website }) }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      return setError(body?.error?.message ?? "Couldn't post your review. Try again.");
    }
    setSent(true);
    const list = await fetch(`/api/reviews/${slug}`, { cache: "no-store" }).catch(() => null);
    if (list?.ok) setReviews(((await list.json()) as { reviews: Review[] }).reviews);
  }

  const average = reviews.length ? reviews.reduce((n, r) => n + r.rating, 0) / reviews.length : 0;

  return (
    <>
      {reviews.length > 0 && (
        <div className="mt-4 flex items-center gap-2 text-sm">
          <Stars value={Math.round(average)} />
          <span className="font-medium">{average.toFixed(1)}</span>
          <span className="text-muted-foreground">· {reviews.length} review{reviews.length === 1 ? "" : "s"}</span>
        </div>
      )}

      <section className="mt-8 rounded-xl border bg-card p-5 sm:p-6">
        {sent ? (
          <div>
            <h2 className="font-display text-xl font-bold">Thanks for your review</h2>
            <p className="mt-1 text-sm text-muted-foreground">It&apos;s posted below. {businessName} usually replies within the day.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <h2 className="font-display text-xl font-bold">How was it?</h2>
            <div className="flex gap-1" role="radiogroup" aria-label="Your rating" onMouseLeave={() => setHover(0)}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} onClick={() => setRating(n)} onMouseEnter={() => setHover(n)} className="rounded p-0.5">
                  <Star className={cn("size-8 transition-colors", n <= (hover || rating) ? "fill-token text-token" : "text-muted-foreground/40")} />
                </button>
              ))}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="review-name">Your name</Label>
              <Input id="review-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoComplete="given-name" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="review-text">Your review</Label>
              <Textarea id="review-text" value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000} required />
            </div>
            {/* Honeypot for bots; hidden from people and screen readers. */}
            <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden className="hidden" />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy} className="justify-self-start">
              {busy && <Loader2 className="animate-spin" />} Post review
            </Button>
          </form>
        )}
      </section>

      <ul className="mt-8 grid gap-4">
        {reviews.map((r) => (
          <li key={r.id} className="rounded-xl border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{r.name}</span>
              <span className="text-xs text-muted-foreground">{when(r.createdAt)}</span>
            </div>
            <div className="mt-1">
              <Stars value={r.rating} />
            </div>
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed">{r.text}</p>
            {r.reply && (
              <div className="mt-4 rounded-lg border-l-4 border-primary bg-accent/60 px-4 py-3 animate-in fade-in slide-in-from-top-1">
                <p className="text-xs font-medium text-accent-foreground">Reply from {businessName}</p>
                <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{r.reply.text}</p>
              </div>
            )}
          </li>
        ))}
        {reviews.length === 0 && <li className="text-sm text-muted-foreground">No reviews yet. Be the first.</li>}
      </ul>
    </>
  );
}
