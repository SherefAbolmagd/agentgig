"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { PROVIDER_INFO, type Provider } from "@/lib/client/integrations";

/** Shows the outcome of an OAuth or Stripe redirect once, then cleans the URL. */
export function RedirectFeedback() {
  const params = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const connected = params.get("connected") as Provider | null;
    const connectError = params.get("connectError");
    const topup = params.get("topup");
    if (!connected && !connectError && !topup) return;
    if (connected && PROVIDER_INFO[connected]) toast.success(`${PROVIDER_INFO[connected].name} connected.`, { description: "Your agents can now act there." });
    if (connectError) toast.error(connectError);
    if (topup === "success") toast.success("Payment received.", { description: "Your tokens appear in a few seconds." });
    if (topup === "cancelled") toast("Checkout cancelled. Nothing was charged.");
    const next = new URLSearchParams(params);
    ["connected", "connectError", "topup"].forEach((k) => next.delete(k));
    router.replace(`${window.location.pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  }, [params, router]);
  return null;
}
