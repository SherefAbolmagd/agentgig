import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { env } from "@/lib/env";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { putSecret } from "@/lib/secrets";
import { COLLECTIONS } from "@/types/firestore";
import type { Provider } from "./index";

/**
 * OAuth 2.0 authorization-code flow (with PKCE where the provider supports
 * it) for the tools agents act in. Tokens go to Secret Manager; Firestore
 * keeps only the connection's label, scopes and a pointer to the secret.
 */

interface ProviderConfig {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId?: string;
  clientSecret?: string;
  pkce: boolean;
  extraAuthParams?: Record<string, string>;
}

export function providerConfig(provider: Provider): ProviderConfig {
  const e = process.env;
  switch (provider) {
    case "google":
      return {
        label: "Google (Drive, Gmail, Sheets)",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: [
          "openid",
          "email",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/spreadsheets",
        ],
        clientId: e.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET,
        pkce: true,
        extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
      };
    case "linkedin":
      return {
        label: "LinkedIn",
        authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
        tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
        scopes: ["openid", "profile", "w_member_social"],
        clientId: e.LINKEDIN_CLIENT_ID,
        clientSecret: e.LINKEDIN_CLIENT_SECRET,
        pkce: false,
      };
    case "slack":
      return {
        label: "Slack",
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        scopes: ["chat:write", "channels:history", "channels:read", "users:read"],
        clientId: e.SLACK_CLIENT_ID,
        clientSecret: e.SLACK_CLIENT_SECRET,
        pkce: false,
      };
  }
}

export function isConfigured(provider: Provider): boolean {
  const c = providerConfig(provider);
  return !!(c.clientId && c.clientSecret);
}

function redirectUri(provider: Provider, origin: string) {
  return `${env().PUBLIC_URL ?? env().APP_URL ?? origin}/api/connections/${provider}/callback`;
}

const STATE_TTL_MS = 10 * 60_000;

/** Starts a connection: stores a one-time state and returns the provider's consent URL. */
export async function startConnect(userId: string, provider: Provider, origin: string, returnTo: string): Promise<string> {
  const c = providerConfig(provider);
  if (!c.clientId) throw new GatewayError("AGENT_UNAVAILABLE", `${c.label} connections aren't set up on this server yet.`);
  const state = randomBytes(24).toString("base64url");
  const verifier = c.pkce ? randomBytes(48).toString("base64url") : null;
  await db().collection("oauth_states").doc(state).set({
    userId,
    provider,
    verifier,
    returnTo: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/workforce",
    expireAt: Timestamp.fromMillis(Date.now() + STATE_TTL_MS),
  });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: redirectUri(provider, origin),
    state,
    ...(provider === "slack" ? { scope: c.scopes.join(",") } : { scope: c.scopes.join(" ") }),
    ...(verifier && { code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }),
    ...c.extraAuthParams,
  });
  return `${c.authorizeUrl}?${params}`;
}

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms. */
  expires_at?: number;
}

/** Finishes a connection: checks state, exchanges the code, stores tokens, writes the connection doc. */
export async function finishConnect(provider: Provider, code: string, state: string, origin: string): Promise<{ returnTo: string }> {
  const stateRef = db().collection("oauth_states").doc(state);
  const saved = (await stateRef.get()).data() as
    | { userId: string; provider: Provider; verifier: string | null; returnTo: string; expireAt: Timestamp }
    | undefined;
  await stateRef.delete();
  if (!saved || saved.provider !== provider || saved.expireAt.toMillis() < Date.now()) {
    throw new GatewayError("UNAUTHENTICATED", "That sign-in link expired. Start the connection again.");
  }
  const c = providerConfig(provider);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider, origin),
    client_id: c.clientId!,
    client_secret: c.clientSecret!,
    ...(saved.verifier && { code_verifier: saved.verifier }),
  });
  const res = await fetch(c.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000) });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.ok === false || json.error) {
    throw new GatewayError("AGENT_FAILED", `${c.label} refused the connection: ${String(json.error_description ?? json.error ?? res.status)}`);
  }

  const { tokens, label, meta, scopes } = await describe(provider, json);
  const secretRef = await putSecret(`conn-${provider}-${saved.userId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 255), JSON.stringify(tokens));
  await db()
    .collection(COLLECTIONS.connections)
    .doc(`${saved.userId}_${provider}`)
    .set(
      {
        userId: saved.userId,
        provider,
        accountLabel: label,
        scopes,
        secretRef,
        status: "active",
        meta,
        createdAt: FieldValue.serverTimestamp(),
        ...(tokens.expires_at && { expiresAt: Timestamp.fromMillis(tokens.expires_at) }),
      },
      { merge: true },
    );
  return { returnTo: saved.returnTo };
}

/** Normalises each provider's token response and looks up who connected. */
async function describe(provider: Provider, json: Record<string, unknown>) {
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  if (provider === "slack") {
    const team = json.team as { name?: string; id?: string } | undefined;
    return {
      tokens: { access_token: String(json.access_token) } as StoredTokens,
      label: `Slack · ${team?.name ?? "workspace"}`,
      meta: { teamId: team?.id ?? null, botUserId: json.bot_user_id ?? null },
      scopes: String(json.scope ?? "").split(","),
    };
  }
  const tokens: StoredTokens = {
    access_token: String(json.access_token),
    ...(json.refresh_token ? { refresh_token: String(json.refresh_token) } : {}),
    ...(expiresIn ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
  };
  const infoUrl = provider === "google" ? "https://openidconnect.googleapis.com/v1/userinfo" : "https://api.linkedin.com/v2/userinfo";
  const info = (await (await fetch(infoUrl, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as { sub?: string; email?: string; name?: string };
  return provider === "google"
    ? { tokens, label: `Google · ${info.email ?? "account"}`, meta: {}, scopes: String(json.scope ?? "").split(" ") }
    : { tokens, label: `LinkedIn · ${info.name ?? "profile"}`, meta: { personUrn: info.sub ? `urn:li:person:${info.sub}` : null }, scopes: String(json.scope ?? "").split(/[ ,]/) };
}

/** Refreshes an expired Google access token with its refresh token. */
export async function refreshGoogle(tokens: StoredTokens): Promise<StoredTokens> {
  const c = providerConfig("google");
  const res = await fetch(c.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: c.clientId!, client_secret: c.clientSecret! }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google token refresh failed: ${json.error ?? res.status}`);
  return { ...tokens, access_token: json.access_token, expires_at: Date.now() + (json.expires_in ?? 3600) * 1000 };
}
