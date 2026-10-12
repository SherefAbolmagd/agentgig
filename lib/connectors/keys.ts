import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "@/lib/firebase-admin";
import { GatewayError } from "@/lib/errors";
import { INTEGRATIONS, type KeyProvider } from "@/lib/integrations";
import { putSecret, readSecret } from "@/lib/secrets";
import { COLLECTIONS, type ConnectionDoc } from "@/types/firestore";

/**
 * Paste-a-key connections. The vendor's test call runs before anything is
 * saved; the key goes to Secret Manager and Firestore keeps only a label and
 * non-secret details (shop domain, data centre, account ID).
 */

export interface KeyCheck {
  accountLabel: string;
  meta: Record<string, unknown>;
}

export type KeyTester = (fields: Record<string, string>) => Promise<KeyCheck>;

export async function saveKeyConnection(userId: string, provider: KeyProvider, fields: Record<string, string>, test: KeyTester) {
  const spec = INTEGRATIONS[provider];
  const clean: Record<string, string> = {};
  for (const f of spec.fields ?? []) {
    const v = (fields[f.id] ?? "").trim();
    if (!v && !f.optional) throw new GatewayError("INVALID_INPUT", `Enter your ${spec.name} ${f.label.toLowerCase()}.`);
    if (v) clean[f.id] = v.slice(0, 500);
  }
  for (const [k, v] of Object.entries(fields)) if (!(k in clean) && v?.trim()) clean[k] = v.trim().slice(0, 500);

  const check = await test(clean);
  const secretRef = await putSecret(`conn-${provider}-${userId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 255), JSON.stringify(clean));
  await db()
    .collection(COLLECTIONS.connections)
    .doc(`${userId}_${provider}`)
    .set({
      userId,
      provider,
      accountLabel: check.accountLabel,
      scopes: [],
      secretRef,
      status: "active",
      meta: check.meta,
      createdAt: FieldValue.serverTimestamp(),
    });
  return check;
}

/** Reads a key connection's stored fields, or null if the owner hasn't connected it. */
export async function keyFields(userId: string, provider: KeyProvider): Promise<{ fields: Record<string, string>; conn: ConnectionDoc } | null> {
  const conn = (await db().collection(COLLECTIONS.connections).doc(`${userId}_${provider}`).get()).data() as ConnectionDoc | undefined;
  if (!conn || conn.status !== "active" || conn.secretRef === "simulated") return null;
  return { fields: JSON.parse(await readSecret(conn.secretRef)) as Record<string, string>, conn };
}

/** Turns a vendor's refusal into a message the owner can act on. */
export function vendorError(vendor: string, status: number, detail = ""): GatewayError {
  if (status === 401 || status === 403) return new GatewayError("INVALID_INPUT", `${vendor} rejected that key. Check it was copied in full and has the permissions listed.`);
  if (status === 404) return new GatewayError("INVALID_INPUT", `${vendor} couldn't find that account or store. Check the address.`);
  if (status === 429) return new GatewayError("BUSY", `${vendor} is rate-limiting requests. Try again in a minute.`);
  return new GatewayError("AGENT_FAILED", `${vendor} returned an error (HTTP ${status}).${detail ? ` ${detail.slice(0, 160)}` : ""}`);
}

/** fetch with a timeout and JSON parsing, mapping HTTP errors to vendorError. */
export async function vendorFetch<T>(vendor: string, url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new GatewayError("AGENT_FAILED", `We couldn't reach ${vendor}.`);
  }
  if (!res.ok) throw vendorError(vendor, res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}
