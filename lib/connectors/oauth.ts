import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { env } from "@/lib/env";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { putSecret } from "@/lib/secrets";
import { COLLECTIONS } from "@/types/firestore";
import type { OAuthProvider as Provider } from "@/lib/integrations";

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
  /** Send client credentials as HTTP Basic auth instead of in the body (QuickBooks, Xero). */
  basicAuth?: boolean;
  /** Token endpoint wants a JSON body instead of a form (Square, FreshBooks). */
  jsonBody?: boolean;
  scopeSeparator?: string;
}

/** Square's sandbox and production live on different hosts. */
export function squareHosts() {
  const sandbox = process.env.SQUARE_ENV !== "production";
  return { sandbox, connect: sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com" };
}

/** Zoho runs a separate accounts server per region; only these may receive our client secret. */
const ZOHO_ACCOUNTS = /^https:\/\/accounts\.zoho\.(com|eu|in|com\.au|jp|ca|sa|uk|com\.cn)$/;
export function isZohoAccountsServer(url: string): boolean {
  return ZOHO_ACCOUNTS.test(url);
}

export function providerConfig(provider: Provider): ProviderConfig {
  const e = process.env;
  switch (provider) {
    case "google":
      return {
        label: "Google (Drive, Gmail, Sheets, Calendar)",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: [
          "openid",
          "email",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/calendar.readonly",
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
    case "xero":
      return {
        label: "Xero",
        authorizeUrl: "https://login.xero.com/identity/connect/authorize",
        tokenUrl: "https://identity.xero.com/connect/token",
        scopes: ["openid", "profile", "email", "offline_access", "accounting.transactions", "accounting.contacts"],
        clientId: e.XERO_CLIENT_ID,
        clientSecret: e.XERO_CLIENT_SECRET,
        pkce: true,
        basicAuth: true,
      };
    case "microsoft":
      return {
        label: "Microsoft 365",
        authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scopes: ["openid", "email", "offline_access", "User.Read", "Mail.ReadWrite", "Calendars.Read"],
        clientId: e.MICROSOFT_CLIENT_ID,
        clientSecret: e.MICROSOFT_CLIENT_SECRET,
        pkce: true,
        extraAuthParams: { prompt: "select_account" },
      };
    case "square": {
      const { connect } = squareHosts();
      return {
        label: "Square",
        authorizeUrl: `${connect}/oauth2/authorize`,
        tokenUrl: `${connect}/oauth2/token`,
        scopes: ["MERCHANT_PROFILE_READ", "PAYMENTS_READ", "ORDERS_READ", "ITEMS_READ", "INVENTORY_READ", "CUSTOMERS_READ", "APPOINTMENTS_READ", "APPOINTMENTS_ALL_READ", "INVOICES_READ"],
        clientId: e.SQUARE_CLIENT_ID,
        clientSecret: e.SQUARE_CLIENT_SECRET,
        pkce: false,
        jsonBody: true,
        extraAuthParams: { session: "false" },
      };
    }
    case "zoho":
      return {
        label: "Zoho CRM",
        authorizeUrl: "https://accounts.zoho.com/oauth/v2/auth",
        tokenUrl: "https://accounts.zoho.com/oauth/v2/token",
        scopes: ["ZohoCRM.modules.leads.READ", "ZohoCRM.modules.contacts.READ", "ZohoCRM.modules.deals.READ", "ZohoCRM.modules.notes.CREATE", "ZohoCRM.org.READ"],
        scopeSeparator: ",",
        clientId: e.ZOHO_CLIENT_ID,
        clientSecret: e.ZOHO_CLIENT_SECRET,
        pkce: false,
        extraAuthParams: { access_type: "offline", prompt: "consent" },
      };
    case "freshbooks":
      return {
        label: "FreshBooks",
        authorizeUrl: "https://auth.freshbooks.com/oauth/authorize",
        tokenUrl: "https://api.freshbooks.com/auth/oauth/token",
        scopes: [
          "user:profile:read",
          "user:clients:read",
          "user:invoices:read",
          "user:bills:read",
          "user:bills:write",
          "user:bill_vendors:read",
          "user:bill_vendors:write",
          "user:expenses:read",
        ],
        clientId: e.FRESHBOOKS_CLIENT_ID,
        clientSecret: e.FRESHBOOKS_CLIENT_SECRET,
        pkce: false,
        jsonBody: true,
      };
    case "sage":
      return {
        label: "Sage Accounting",
        authorizeUrl: "https://www.sageone.com/oauth2/auth/central?filter=apiv3.1",
        tokenUrl: "https://oauth.accounting.sage.com/token",
        scopes: ["full_access"],
        clientId: e.SAGE_CLIENT_ID,
        clientSecret: e.SAGE_CLIENT_SECRET,
        pkce: false,
      };
    case "quickbooks":
      return {
        label: "QuickBooks",
        authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
        tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        scopes: ["com.intuit.quickbooks.accounting", "openid", "email"],
        clientId: e.QUICKBOOKS_CLIENT_ID,
        clientSecret: e.QUICKBOOKS_CLIENT_SECRET,
        pkce: false,
        basicAuth: true,
      };
  }
}

/** Token endpoint call with the provider's preferred client authentication. */
async function tokenRequest(c: ProviderConfig, params: Record<string, string>, tokenUrl = c.tokenUrl) {
  const fields = c.basicAuth ? params : { ...params, client_id: c.clientId!, client_secret: c.clientSecret! };
  const body = c.jsonBody ? JSON.stringify(fields) : new URLSearchParams(fields);
  const headers: Record<string, string> = { "content-type": c.jsonBody ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json" };
  if (c.basicAuth) headers.authorization = "Basic " + Buffer.from(c.clientId + ":" + c.clientSecret).toString("base64");
  const res = await fetch(tokenUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  return { res, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
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
    scope: c.scopes.join(c.scopeSeparator ?? (provider === "slack" ? "," : " ")),
    ...(verifier && { code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }),
    ...c.extraAuthParams,
  });
  return `${c.authorizeUrl}${c.authorizeUrl.includes("?") ? "&" : "?"}${params}`;
}

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms. */
  expires_at?: number;
  /** Where to refresh, when it differs per account (Zoho's regional accounts servers). */
  token_url?: string;
}

type ConnectExtra = { realmId?: string; accountsServer?: string };

/** Access-token lifetime from either expires_in (seconds) or expires_at (ISO, Square). */
function expiryMs(json: Record<string, unknown>): number | undefined {
  if (typeof json.expires_in === "number") return Date.now() + json.expires_in * 1000;
  if (typeof json.expires_in === "string" && Number(json.expires_in) > 0) return Date.now() + Number(json.expires_in) * 1000;
  if (typeof json.expires_at === "string" && !Number.isNaN(Date.parse(json.expires_at))) return Date.parse(json.expires_at);
  return undefined;
}

/** Finishes a connection: checks state, exchanges the code, stores tokens, writes the connection doc. */
export async function finishConnect(provider: Provider, code: string, state: string, origin: string, extra: ConnectExtra = {}): Promise<{ returnTo: string }> {
  const stateRef = db().collection("oauth_states").doc(state);
  const saved = (await stateRef.get()).data() as
    | { userId: string; provider: Provider; verifier: string | null; returnTo: string; expireAt: Timestamp }
    | undefined;
  await stateRef.delete();
  if (!saved || saved.provider !== provider || saved.expireAt.toMillis() < Date.now()) {
    throw new GatewayError("UNAUTHENTICATED", "That sign-in link expired. Start the connection again.");
  }
  const c = providerConfig(provider);
  let tokenUrl = c.tokenUrl;
  if (provider === "zoho" && extra.accountsServer) {
    if (!isZohoAccountsServer(extra.accountsServer)) throw new GatewayError("INVALID_INPUT", "Zoho sent an unexpected sign-in server. Start the connection again.");
    tokenUrl = `${extra.accountsServer}/oauth/v2/token`;
  }
  const { res, json } = await tokenRequest(
    c,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(provider, origin),
      ...(saved.verifier && { code_verifier: saved.verifier }),
    },
    tokenUrl,
  );
  if (!res.ok || json.ok === false || json.error) {
    throw new GatewayError("AGENT_FAILED", `${c.label} refused the connection: ${String(json.error_description ?? json.error ?? res.status)}`);
  }

  const { tokens, label, meta, scopes } = await describe(provider, json, extra);
  if (provider === "zoho") tokens.token_url = tokenUrl;
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
async function describe(provider: Provider, json: Record<string, unknown>, extra: ConnectExtra) {
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
    ...(expiryMs(json) ? { expires_at: expiryMs(json) } : {}),
  };
  const bearer = { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" };
  const getJson = async <T>(url: string, headers: Record<string, string> = bearer): Promise<T> => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new GatewayError("AGENT_FAILED", `${providerConfig(provider).label} connected, but reading the account failed (HTTP ${r.status}).`);
    return (await r.json()) as T;
  };
  const scopeList = String(json.scope ?? "").split(/[ ,]/).filter(Boolean);
  if (provider === "microsoft") {
    const me = await getJson<{ mail?: string | null; userPrincipalName?: string; displayName?: string }>("https://graph.microsoft.com/v1.0/me");
    const email = me.mail || me.userPrincipalName || null;
    return { tokens, label: `Microsoft 365 · ${email ?? me.displayName ?? "account"}`, meta: { email }, scopes: scopeList };
  }
  if (provider === "square") {
    const { sandbox } = squareHosts();
    const api = sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    const h = { ...bearer, "square-version": "2025-01-23" };
    const m = await getJson<{ merchant: { id: string; business_name?: string; currency?: string } }>(`${api}/v2/merchants/me`, h);
    const locs = await getJson<{ locations?: { id: string; status: string }[] }>(`${api}/v2/locations`, h);
    return {
      tokens,
      label: `Square · ${m.merchant.business_name ?? m.merchant.id}${sandbox ? " (sandbox)" : ""}`,
      meta: { sandbox, merchantId: m.merchant.id, currency: m.merchant.currency ?? "USD", locationIds: (locs.locations ?? []).filter((l) => l.status === "ACTIVE").map((l) => l.id) },
      scopes: providerConfig("square").scopes,
    };
  }
  if (provider === "zoho") {
    const apiDomain = String(json.api_domain ?? "https://www.zohoapis.com");
    if (!/^https:\/\/(www\.)?zohoapis\.[a-z.]+$/.test(apiDomain)) throw new GatewayError("INVALID_INPUT", "Zoho returned an unexpected API address.");
    const org = await getJson<{ org?: { company_name?: string }[] }>(`${apiDomain}/crm/v6/org`, { authorization: `Zoho-oauthtoken ${tokens.access_token}` });
    return { tokens, label: `Zoho CRM · ${org.org?.[0]?.company_name ?? "organisation"}`, meta: { apiDomain }, scopes: scopeList };
  }
  if (provider === "freshbooks") {
    const me = await getJson<{ response: { business_memberships?: { business: { id: number; name: string; account_id: string } }[] } }>("https://api.freshbooks.com/auth/api/v1/users/me");
    const biz = me.response.business_memberships?.[0]?.business;
    if (!biz) throw new GatewayError("INVALID_INPUT", "Your FreshBooks login has no business.");
    return { tokens, label: `FreshBooks · ${biz.name}`, meta: { accountId: biz.account_id, businessId: biz.id }, scopes: scopeList };
  }
  if (provider === "sage") {
    const biz = await getJson<{ $items?: { id: string; displayed_as: string }[] }>("https://api.accounting.sage.com/v3.1/businesses");
    const lead = biz.$items?.[0];
    if (!lead) throw new GatewayError("INVALID_INPUT", "Your Sage login has no business.");
    return { tokens, label: `Sage · ${lead.displayed_as}`, meta: { businessId: lead.id }, scopes: ["full_access"] };
  }
  if (provider === "xero") {
    // Xero tokens are per user; the organisation ("tenant") comes from /connections.
    const tenants = (await (await fetch("https://api.xero.com/connections", { headers: { authorization: "Bearer " + tokens.access_token } })).json()) as { tenantId: string; tenantName: string; tenantType: string }[];
    const org = tenants.find((t) => t.tenantType === "ORGANISATION") ?? tenants[0];
    if (!org) throw new GatewayError("INVALID_INPUT", "Your Xero login has no organisation. Create or select one in Xero first.");
    return { tokens, label: "Xero · " + org.tenantName, meta: { tenantId: org.tenantId }, scopes: String(json.scope ?? "").split(" ") };
  }
  if (provider === "quickbooks") {
    if (!extra.realmId) throw new GatewayError("INVALID_INPUT", "QuickBooks didn't say which company to connect. Try again.");
    return { tokens, label: "QuickBooks · company " + extra.realmId, meta: { realmId: extra.realmId, sandbox: process.env.QUICKBOOKS_ENV !== "production" }, scopes: ["com.intuit.quickbooks.accounting"] };
  }
  const infoUrl = provider === "google" ? "https://openidconnect.googleapis.com/v1/userinfo" : "https://api.linkedin.com/v2/userinfo";
  const info = (await (await fetch(infoUrl, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as { sub?: string; email?: string; name?: string };
  return provider === "google"
    ? { tokens, label: `Google · ${info.email ?? "account"}`, meta: {}, scopes: String(json.scope ?? "").split(" ") }
    : { tokens, label: `LinkedIn · ${info.name ?? "profile"}`, meta: { personUrn: info.sub ? `urn:li:person:${info.sub}` : null }, scopes: String(json.scope ?? "").split(/[ ,]/) };
}

/**
 * Refreshes an access token. Xero and QuickBooks rotate refresh tokens (each
 * is single-use), so the caller must persist the returned tokens.
 */
export async function refreshTokens(provider: Provider, tokens: StoredTokens): Promise<StoredTokens> {
  const c = providerConfig(provider);
  const { res, json } = await tokenRequest(c, { grant_type: "refresh_token", refresh_token: tokens.refresh_token! }, tokens.token_url ?? c.tokenUrl);
  if (!res.ok || typeof json.access_token !== "string") throw new Error(c.label + " token refresh failed: " + String(json.error ?? res.status));
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : tokens.refresh_token,
    expires_at: expiryMs(json) ?? Date.now() + 3600 * 1000,
    ...(tokens.token_url && { token_url: tokens.token_url }),
  };
}
