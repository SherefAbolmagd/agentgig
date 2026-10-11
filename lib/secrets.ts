import "server-only";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { env } from "./env";

/**
 * Partner API keys live in Secret Manager; Firestore only stores the secret's
 * resource name. Values are cached briefly so each task doesn't re-read them.
 */

let client: SecretManagerServiceClient | undefined;
const sm = () => (client ??= new SecretManagerServiceClient());
const cache = new Map<string, { value: string; at: number }>();
const TTL_MS = 5 * 60_000;

/** Creates the secret if needed and adds `value` as its newest version. Returns the secret's resource name. */
export async function putSecret(secretId: string, value: string): Promise<string> {
  const parent = `projects/${env().GOOGLE_CLOUD_PROJECT}`;
  const name = `${parent}/secrets/${secretId}`;
  try {
    await sm().createSecret({ parent, secretId, secret: { replication: { automatic: {} }, labels: { app: "agentexchange" } } });
  } catch (err) {
    if ((err as { code?: number }).code !== 6 /* ALREADY_EXISTS */) throw err;
  }
  await sm().addSecretVersion({ parent: name, payload: { data: Buffer.from(value, "utf8") } });
  cache.set(name, { value, at: Date.now() });
  return name;
}

export async function readSecret(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const [version] = await sm().accessSecretVersion({ name: `${name}/versions/latest` });
  const value = Buffer.from(version.payload?.data as Uint8Array).toString("utf8");
  cache.set(name, { value, at: Date.now() });
  return value;
}
