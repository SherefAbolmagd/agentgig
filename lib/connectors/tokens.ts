import "server-only";
import { db } from "@/lib/firebase-admin";
import { GatewayError } from "@/lib/errors";
import { INTEGRATIONS, type OAuthProvider } from "@/lib/integrations";
import { putSecret, readSecret } from "@/lib/secrets";
import { COLLECTIONS, type ConnectionDoc } from "@/types/firestore";
import { refreshTokens, type StoredTokens } from "./oauth";

/**
 * Recently refreshed tokens, kept in memory to avoid re-reading Secret Manager
 * every call. Keyed by connect time too, so a reconnect (new permissions) is
 * picked up at once.
 */
const fresh = new Map<string, StoredTokens>();
const cacheKey = (conn: ConnectionDoc & { id: string }) => `${conn.id}@${conn.createdAt?.toMillis?.() ?? 0}`;

/**
 * Returns a usable access token for an OAuth connection, refreshing it when it
 * expires. Rotated refresh tokens (Xero, QuickBooks) are written back to
 * Secret Manager immediately, because the old one stops working.
 */
export async function accessToken(conn: ConnectionDoc & { id: string }): Promise<string> {
  let tokens = fresh.get(cacheKey(conn)) ?? (JSON.parse(await readSecret(conn.secretRef)) as StoredTokens);
  const expiring = tokens.expires_at !== undefined && tokens.expires_at < Date.now() + 60_000;
  if (expiring) {
    const provider = conn.provider as OAuthProvider;
    const name = INTEGRATIONS[provider]?.name ?? provider;
    if (!tokens.refresh_token) {
      await markExpired(conn);
      throw new GatewayError("AGENT_FAILED", "Your " + name + " connection expired. Reconnect it in Company knowledge → Connections.");
    }
    try {
      const next = await refreshTokens(provider, tokens);
      if (next.refresh_token !== tokens.refresh_token) await putSecret(conn.secretRef.split("/").pop()!, JSON.stringify(next));
      tokens = next;
    } catch {
      await markExpired(conn);
      throw new GatewayError("AGENT_FAILED", name + " access expired. Reconnect it in Company knowledge → Connections.");
    }
  }
  fresh.set(cacheKey(conn), tokens);
  return tokens.access_token;
}

async function markExpired(conn: ConnectionDoc & { id: string }) {
  fresh.delete(cacheKey(conn));
  await db().collection(COLLECTIONS.connections).doc(conn.id).update({ status: "expired" });
}
