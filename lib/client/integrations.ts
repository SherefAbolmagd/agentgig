"use client";
import { useEffect, useState } from "react";
import { INTEGRATIONS, PROVIDERS, providerForTool, type Provider } from "@/lib/integrations";

export { INTEGRATIONS, PROVIDERS, providerForTool };
export type { Provider };

/** Short form used by older components. */
export const PROVIDER_INFO = INTEGRATIONS;

export interface IntegrationStatus {
  providers: Record<Provider, boolean>;
  payments: boolean;
}

let cached: Promise<IntegrationStatus> | null = null;

/** Which integrations this server can connect (OAuth apps configured; key-based ones always). */
export function useIntegrationStatus(): IntegrationStatus | null {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  useEffect(() => {
    cached ??= fetch("/api/connections/status").then((r) => r.json());
    cached.then(setStatus).catch(() => setStatus({ providers: Object.fromEntries(PROVIDERS.map((p) => [p, false])) as Record<Provider, boolean>, payments: false }));
  }, []);
  return status;
}
