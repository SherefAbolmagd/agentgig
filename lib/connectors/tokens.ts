import "server-only";
import { db } from "@/lib/firebase-admin";
import { GatewayError } from "@/lib/errors";
import { INTEGRATIONS, type OAuthProvider } from "@/lib/integrations";
import { putSecret, readSecret } from "@/lib/secrets";
import { COLLECTIONS, type ConnectionDoc } from "@/types/firestore";
import { refreshTokens, type StoredTokens } from "./oauth";

/** Recently refreshed tokens, kept in memory to avoid re-reading Secret Manager every call. */
const fresh = new Map<string, StoredTokens>();

/**
 * Returns a usable access token for an OAuth connection, refreshing it when it
 * expires. Rotated refresh tokens (Xero, QuickBooks) are written back to
 * Secret Manager immediately, because the old one stops working.
 */
export async function accessToken(conn: ConnectionDoc & { id: string }): Promise<string> {
  let tokens = fresh.get(conn.id) ?? (JSON.parse(await readSecret(conn.secretRef)) as StoredTokens);
  const expiring = tokens.expires_at !== undefined && tokens.expires_at < Date.now() + 60_000;
  if (expiring) {
    const provider = conn.provider as OAuthProvider;
    const name = INTEGRATIONS[provider]?.name ?? provider;
    if (!tokens.refresh_token) {
      await markExpired(conn.id);
      throw new GatewayError("AGENT_FAILED", "Your " + name + " connection expired. Reconnect it in Company knowledge → Connections.");
    }
    try {
      const next = await refreshTokens(provider, tokens);
      if (next.refresh_token !== tokens.refresh_token) await putSecret(conn.secretRef.split("/").pop()!, JSON.stringify(next));
      tokens = next;
    } catch {
      await markExpired(conn.id);
      throw new GatewayError("AGENT_FAILED", name + " access expired. Reconnect it in Company knowledge → Connections.");
    }
  }
  fresh.set(conn.id, tokens);
  return tokens.access_token;
}

async function markExpired(id: string) {
  fresh.delete(id);
  await db().collection(COLLECTIONS.connections).doc(id).update({ status: "expired" });
}
