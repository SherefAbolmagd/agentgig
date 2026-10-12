import "server-only";
import { db } from "@/lib/firebase-admin";
import { GatewayError } from "@/lib/errors";
import { readSecret } from "@/lib/secrets";
import { COLLECTIONS, type ConnectionDoc } from "@/types/firestore";
import { refreshGoogle, type StoredTokens } from "./oauth";

/** Refreshed Google access tokens, kept in memory (refresh tokens never leave Secret Manager). */
const fresh = new Map<string, StoredTokens>();

/** Returns a usable access token for a connection, refreshing Google tokens when they expire. */
export async function accessToken(conn: ConnectionDoc & { id: string }): Promise<string> {
  let tokens = fresh.get(conn.id) ?? (JSON.parse(await readSecret(conn.secretRef)) as StoredTokens);
  const expiring = tokens.expires_at !== undefined && tokens.expires_at < Date.now() + 60_000;
  if (expiring) {
    if (conn.provider === "google" && tokens.refresh_token) {
      try {
        tokens = await refreshGoogle(tokens);
      } catch {
        await markExpired(conn.id);
        throw new GatewayError("AGENT_FAILED", "Google access expired. Reconnect Google in Company knowledge → Connections.");
      }
    } else {
      await markExpired(conn.id);
      throw new GatewayError("AGENT_FAILED", `Your ${conn.provider} connection expired. Reconnect it in Company knowledge → Connections.`);
    }
  }
  fresh.set(conn.id, tokens);
  return tokens.access_token;
}

async function markExpired(id: string) {
  fresh.delete(id);
  await db().collection(COLLECTIONS.connections).doc(id).update({ status: "expired" });
}
