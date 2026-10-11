"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authErrorMessage, useAuth } from "@/lib/client/auth";

/** Signs in to the demo sandbox (or reuses the session) and opens the workforce. */
export function DemoButton({ size = "lg", label = "Try the demo" }: { size?: "lg" | "default" | "sm"; label?: string }) {
  const { user, signInDemo } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      if (!user) await signInDemo();
      router.push("/workforce");
    } catch (err) {
      toast.error(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Button size={size} onClick={go} disabled={busy}>
      {busy && <Loader2 className="animate-spin" />}
      {user ? "Open my workforce" : label} <ArrowRight />
    </Button>
  );
}
