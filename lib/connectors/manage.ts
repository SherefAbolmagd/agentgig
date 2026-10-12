import "server-only";
import { db } from "@/lib/firebase-admin";
import { GatewayError } from "@/lib/errors";
import { deleteSecret } from "@/lib/secrets";
import { COLLECTIONS, type ConnectionDoc, type ToolProvider } from "@/types/firestore";
import { PROVIDERS, providerForTool as forTool, type Provider } from "@/lib/integrations";

export { PROVIDERS };

/** Which provider a tool belongs to; tools without one are used manually. */
export function providerForTool(tool: ToolProvider): Provider | null {
  return forTool(tool);
}

export function parseProvider(raw: string): Provider {
  if (!(PROVIDERS as string[]).includes(raw)) throw new GatewayError("INVALID_INPUT", `Unknown connection “${raw}”.`);
  return raw as Provider;
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
