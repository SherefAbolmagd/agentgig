"use client";
import { useEffect, useState } from "react";

export type Provider = "google" | "linkedin" | "slack";

export const PROVIDER_INFO: Record<Provider, { name: string; does: string }> = {
  google: { name: "Google", does: "Drive invoice folder, Gmail drafts, Sheets spend log" },
  linkedin: { name: "LinkedIn", does: "Publish EchoSocial posts to your profile" },
  slack: { name: "Slack", does: "Answer customers and post rotas in your workspace" },
};

export interface IntegrationStatus {
  providers: Record<Provider, boolean>;
  payments: boolean;
}

let cached: Promise<IntegrationStatus> | null = null;

/** Which real integrations the server has keys for (fetched once per page load). */
export function useIntegrationStatus(): IntegrationStatus | null {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  useEffect(() => {
    cached ??= fetch("/api/connections/status").then((r) => r.json());
    cached.then(setStatus).catch(() => setStatus({ providers: { google: false, linkedin: false, slack: false }, payments: false }));
  }, []);
  return status;
}

/** Tools an agent works in → the provider you connect for them. */
export function providerForTool(tool: string): Provider | null {
  if (tool === "google_drive" || tool === "gmail" || tool === "google_sheets") return "google";
  if (tool === "linkedin") return "linkedin";
  if (tool === "slack") return "slack";
  return null;
}
