import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "@/lib/firebase-admin";
import { GatewayError } from "@/lib/errors";
import { deleteSecret } from "@/lib/secrets";
import { COLLECTIONS, type ConnectionDoc, type ToolProvider } from "@/types/firestore";
import type { Provider } from "./index";
import { isConfigured, providerConfig } from "./oauth";

export const PROVIDERS: Provider[] = ["google", "linkedin", "slack"];

/** Which OAuth provider a tool belongs to; tools without one are used manually. */
export function providerForTool(tool: ToolProvider): Provider | null {
  if (tool === "google_drive" || tool === "gmail" || tool === "google_sheets") return "google";
  if (tool === "linkedin") return "linkedin";
  if (tool === "slack") return "slack";
  return null;
}

export function parseProvider(raw: string): Provider {
  if (!(PROVIDERS as string[]).includes(raw)) throw new GatewayError("INVALID_INPUT", `Unknown connection “${raw}”.`);
  return raw as Provider;
}

/**
 * When a provider's OAuth app isn't configured on this server, connecting
 * creates a demo connection so the rest of the product still works; agents
 * report their deliveries as simulated.
 */
export async function connectSimulated(userId: string, provider: Provider) {
  if (isConfigured(provider)) throw new GatewayError("INVALID_INPUT", "This connection uses real sign-in.");
  await db()
    .collection(COLLECTIONS.connections)
    .doc(`${userId}_${provider}`)
    .set({
      userId,
      provider,
      accountLabel: `${providerConfig(provider).label} (demo)`,
      scopes: [],
      secretRef: "simulated",
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
    } satisfies Omit<ConnectionDoc, "createdAt" | "provider"> & { provider: Provider; createdAt: FieldValue });
}

export async function disconnect(userId: string, provider: Provider) {
  const ref = db().collection(COLLECTIONS.connections).doc(`${userId}_${provider}`);
  const conn = (await ref.get()).data() as ConnectionDoc | undefined;
  if (!conn) return;
  if (conn.secretRef && conn.secretRef !== "simulated") await deleteSecret(conn.secretRef);
  await ref.delete();
}

export async function setSlackChannel(userId: string, channel: string) {
  const ref = db().collection(COLLECTIONS.connections).doc(`${userId}_slack`);
  if (!(await ref.get()).exists) throw new GatewayError("NOT_HIRED", "Connect Slack first.");
  await ref.set({ meta: { defaultChannel: channel } }, { merge: true });
}
