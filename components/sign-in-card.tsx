"use client";
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authErrorMessage, useAuth } from "@/lib/client/auth";

export function SignInCard() {
  const auth = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function attempt(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(authErrorMessage(err));
      setBusy(null);
    }
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    attempt("email", () =>
      mode === "signin" ? auth.signInEmail(email, password) : auth.signUpEmail(String(f.get("name") ?? ""), email, password),
    );
  }

  return (
    <Card className="w-full max-w-md py-8 shadow-sm">
      <CardHeader className="gap-2 px-6 sm:px-8">
        <CardTitle className="font-display text-3xl">{mode === "signin" ? "Meet your AI team" : "Create your account"}</CardTitle>
        <CardDescription className="text-[15px] leading-relaxed">
          {mode === "signin"
            ? "Try the demo to step into Café Lumen, a coffee roaster with two AI employees already hired and 312 tokens to spend."
            : "Start with 100 free tokens and an empty team, then hire the agents you need."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 px-6 sm:px-8">
        <Button size="lg" onClick={() => attempt("demo", auth.signInDemo)} disabled={!!busy}>
          {busy === "demo" ? <Loader2 className="animate-spin" /> : null}
          Try the demo, no sign-up <ArrowRight />
        </Button>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> or use your own account <span className="h-px flex-1 bg-border" />
        </div>

        <Button variant="outline" size="lg" onClick={() => attempt("google", auth.signInGoogle)} disabled={!!busy}>
          {busy === "google" ? <Loader2 className="animate-spin" /> : <GoogleMark />}
          Continue with Google
        </Button>

        <form onSubmit={submit} className="grid gap-4">
          {mode === "signup" && (
            <div className="grid gap-1.5">
              <Label htmlFor="name">Your name</Label>
              <Input id="name" name="name" autoComplete="name" className="h-11" />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required className="h-11" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              minLength={6}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              className="h-11"
            />
          </div>
          <Button type="submit" variant="secondary" size="lg" disabled={!!busy}>
            {busy === "email" ? <Loader2 className="animate-spin" /> : null}
            {mode === "signin" ? "Sign in" : "Create account · 100 free tokens"}
          </Button>
        </form>

        {error && (
          <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <p className="text-center text-sm text-muted-foreground">
          {mode === "signin" ? "New here?" : "Already have an account?"}{" "}
          <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </CardContent>
    </Card>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8z" />
      <path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7H2.1a11 11 0 0 0 0 9.9l3.7-2.8z" />
      <path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z" />
    </svg>
  );
}
