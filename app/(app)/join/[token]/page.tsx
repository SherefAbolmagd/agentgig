"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth";

/** /join/{token}: an invite link. The app layout makes the person sign in first. */
export default function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { user, refreshAccount, signOut } = useAuth();
  const router = useRouter();
  const [invite, setInvite] = useState<{ businessName: string; role: "manager" | "member" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ businessName: string; role: "manager" | "member" }>(`/api/team/invites/${token}`, { method: "GET" })
      .then(setInvite)
      .catch((err) => setError(err instanceof ApiError ? err.message : "We couldn't open this invite."));
  }, [token]);

  async function join() {
    setBusy(true);
    try {
      const res = await api<{ businessName: string }>("/api/team/join", { json: { token } });
      await refreshAccount();
      toast.success(`You joined ${res.businessName}.`);
      router.push("/workforce");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Joining failed. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-md gap-4 rounded-xl border bg-card p-6 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-xl bg-accent text-accent-foreground">
        <Users />
      </span>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !invite ? (
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Opening invite…
        </p>
      ) : (
        <>
          <h1 className="font-display text-2xl font-extrabold">Join {invite.businessName}</h1>
          <p className="text-sm text-muted-foreground">
            You&apos;ll work as a {invite.role} with their agents, tokens and company memory. Your own account stays as it is, and you can leave any time.
          </p>
          {user?.isAnonymous ? (
            <>
              <p className="rounded-lg bg-token-soft px-3 py-2 text-sm text-token">You&apos;re in the demo. Sign out, then sign in with email or Google and open this link again.</p>
              <Button variant="outline" onClick={() => signOut()}>
                Sign out of the demo
              </Button>
            </>
          ) : (
            <Button onClick={join} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />} Join as {invite.role}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
