import "server-only";
import { GoogleAuth } from "google-auth-library";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import type { Shelf } from "@/types/firestore";

/**
 * Vertex AI Agent Engine Memory Bank over REST (v1beta1). One scope per
 * account and shelf, { account_id, shelf }: retrieval only matches a scope
 * exactly, so an agent's read shelves are separate calls. Memory Bank embeds
 * facts, merges a new fact with ones it updates ("oat milk is back" replaces
 * "oat milk is out"), and drops expired ones.
 *
 * Optional: without MEMORY_ENGINE, lib/memory keeps facts in Firestore only.
 */

let auth: GoogleAuth | undefined;

export function bankEnabled(): boolean {
  return !!env().MEMORY_ENGINE;
}

function base(): string {
  const engine = env().MEMORY_ENGINE!;
  const location = engine.match(/locations\/([^/]+)/)?.[1] ?? env().GOOGLE_CLOUD_LOCATION;
  return `https://${location}-aiplatform.googleapis.com/v1beta1`;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const res = await fetch(`${base()}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-goog-user-project": env().GOOGLE_CLOUD_PROJECT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Memory Bank ${method} ${path.split("/").pop()} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const scope = (accountId: string, shelf: Shelf) => ({ account_id: accountId, shelf });

export interface BankMemory {
  name: string;
  fact: string;
}

/** Facts on one shelf closest to `query`. */
export async function bankRetrieve(accountId: string, shelf: Shelf, query: string, topK: number): Promise<BankMemory[]> {
  const res = await call<{ retrievedMemories?: { memory: BankMemory }[] }>("POST", `${env().MEMORY_ENGINE}/memories:retrieve`, {
    scope: scope(accountId, shelf),
    similaritySearchParams: { searchQuery: query, topK },
  });
  return (res.retrievedMemories ?? []).map((r) => ({ name: r.memory.name, fact: r.memory.fact }));
}

export type GeneratedAction = "CREATED" | "UPDATED" | "DELETED";

interface Operation {
  name: string;
  done?: boolean;
  error?: { message: string };
  response?: { generatedMemories?: { memory: { name: string }; action: GeneratedAction }[] };
}

/**
 * Adds already-extracted facts and lets Memory Bank merge them with what the
 * shelf holds. Returns what changed, with each memory's current text.
 */
export async function bankGenerate(accountId: string, shelf: Shelf, facts: string[]): Promise<{ name: string; fact: string; action: GeneratedAction }[]> {
  let op = await call<Operation>("POST", `${env().MEMORY_ENGINE}/memories:generate`, {
    directMemoriesSource: { directMemories: facts.slice(0, 5).map((fact) => ({ fact })) },
    scope: scope(accountId, shelf),
  });
  for (let i = 0; !op.done && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    op = await call<Operation>("GET", op.name);
  }
  if (!op.done) throw new Error("Memory Bank didn't finish saving within 20 seconds.");
  if (op.error) throw new Error(`Memory Bank couldn't save: ${op.error.message}`);
  const changes = op.response?.generatedMemories ?? [];
  return Promise.all(
    changes.map(async (c) =>
      c.action === "DELETED"
        ? { name: c.memory.name, fact: "", action: c.action }
        : { name: c.memory.name, fact: (await call<BankMemory>("GET", c.memory.name)).fact, action: c.action },
    ),
  );
}

/** Memory Bank wants the fact in every update, even when only the expiry changes. */
export async function bankSetExpiry(name: string, fact: string, expiresAt: Date | null): Promise<void> {
  if (!expiresAt) return;
  await call("PATCH", `${name}?updateMask=expire_time`, { fact, expireTime: expiresAt.toISOString() }).catch((err) =>
    log("WARNING", "memory.expiry_failed", { component: "memory", error: String(err) }),
  );
}

export async function bankUpdate(name: string, fact: string): Promise<void> {
  await call("PATCH", `${name}?updateMask=fact`, { fact });
}

export async function bankDelete(name: string): Promise<void> {
  await call("DELETE", name).catch((err) => {
    if (!String(err).includes("HTTP 404")) throw err;
  });
}

export function memoryIdOf(name: string): string {
  return name.split("/").pop()!;
}
