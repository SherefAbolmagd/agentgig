import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { scrubText } from "@/lib/dlp";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { log } from "@/lib/log";
import { DEFAULT_MEMORY_SETTINGS, SHELF_INFO, defaultShelves } from "@/lib/shelves";
import { generateJson } from "@/lib/vertex";
import {
  COLLECTIONS,
  SHELVES,
  type AgentDoc,
  type HireDoc,
  type MemoryDoc,
  type MemorySettings,
  type Shelf,
  type TaskDoc,
  type UserDoc,
} from "@/types/firestore";
import { bankDelete, bankEnabled, bankGenerate, bankListScope, bankRetrieve, bankSetExpiry, bankUpdate, memoryIdOf } from "./bank";

/**
 * Company memory: short facts every agent on an account can share.
 *
 *   recall    Ground step: facts from the shelves this hire may read
 *   remember  after Deliver: Gemini picks out new facts from the result,
 *             DLP scrubs them, and they are saved (or wait for approval)
 *
 * Firestore memory/{id} holds every fact and is what the Memory page shows.
 * With MEMORY_ENGINE set, Vertex AI Memory Bank also stores them, finds the
 * relevant ones by meaning and merges updates; Firestore mirrors it under
 * the same IDs.
 */

const PER_SHELF = 5;
const MAX_RECALLED = 15;

export interface RecalledFact {
  id: string;
  shelf: Shelf;
  fact: string;
}

type Source = MemoryDoc["source"];

const memory = () => db().collection(COLLECTIONS.memory);

export function memorySettings(user: Pick<UserDoc, "memory">): MemorySettings {
  return { ...DEFAULT_MEMORY_SETTINGS, ...user.memory };
}

export function hireShelves(hire: Pick<HireDoc, "memory">, agent: Pick<AgentDoc, "slug" | "category" | "source">) {
  const shelves = hire.memory ?? defaultShelves(agent);
  // Partner agents only ever read, whatever the hire says.
  return { read: shelves.read, write: agent.source === "a2a" ? [] : shelves.write };
}

const live = (m: MemoryDoc, now: number) => m.status === "saved" && (!m.expiresAt || m.expiresAt.toMillis() > now);

/* ------------------------------------------------------------------ */
/* Recall                                                              */
/* ------------------------------------------------------------------ */

export async function recall(user: UserDoc, hire: HireDoc, agent: AgentDoc, query: string, { track = true } = {}): Promise<RecalledFact[]> {
  const shelves = hireShelves(hire, agent).read;
  if (!memorySettings(user).enabled || !shelves.length) return [];
  const accountId = hire.userId;
  const now = Date.now();

  // Firestore holds every fact; pinned ones always go to agents reading their shelf.
  const snap = await memory().where("userId", "==", accountId).limit(300).get();
  const facts = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as MemoryDoc) }))
    .filter((m) => live(m, now) && shelves.includes(m.shelf))
    .sort((a, b) => (b.updatedAt?.toMillis() ?? 0) - (a.updatedAt?.toMillis() ?? 0));
  const pinned = facts.filter((m) => m.pinned);
  const mirrored = new Set(facts.map((m) => m.id));

  // Memory Bank finds its facts by meaning; facts only in Firestore (Memory
  // Bank off, seeded, or saved while it was down) count by recency.
  const bank = bankEnabled();
  const recent = shelves.flatMap((shelf) => facts.filter((f) => f.shelf === shelf && !(bank && f.memoryName)).slice(0, PER_SHELF));
  const searched = bank
    ? (
        await Promise.all(
          shelves.map((shelf) =>
            bankRetrieve(accountId, shelf, query, PER_SHELF)
              // Only memories Firestore mirrors: a save that timed out may finish later without one.
              .then((ms) => ms.map((m) => ({ id: memoryIdOf(m.name), shelf, fact: m.fact })).filter((m) => mirrored.has(m.id)))
              .catch((err) => {
                log("WARNING", "memory.recall_failed", { component: "memory", shelf, error: String(err) });
                return [];
              }),
          ),
        )
      ).flat()
    : [];
  const found: RecalledFact[] = [...searched, ...recent];

  const seen = new Set<string>();
  const result = [...pinned, ...found]
    .filter((f) => !seen.has(f.id) && seen.add(f.id))
    .slice(0, MAX_RECALLED)
    .map(({ id, shelf, fact }) => ({ id, shelf, fact }));

  // "Used by" on the Memory page. Best effort: a fact deleted meanwhile is skipped.
  if (track) await Promise.allSettled(result.map((f) => memory().doc(f.id).update({ usedBy: FieldValue.arrayUnion(agent.slug) })));
  return result;
}

/* ------------------------------------------------------------------ */
/* Remember                                                            */
/* ------------------------------------------------------------------ */

const Extracted = z.object({
  facts: z
    .array(
      z.object({
        shelf: z.enum(SHELVES),
        fact: z.string().min(8).max(300),
        /** Last day the fact is true, YYYY-MM-DD, or null if it lasts. */
        expiresOn: z.string().nullable(),
      }),
    )
    .max(3),
});

const clip = (v: unknown, n: number) => {
  const s = JSON.stringify(v ?? {});
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Runs after a task is delivered (or approved): picks out what the rest of
 * the team should know and saves it. Logged as the task's "remember" step.
 */
export async function rememberTask(taskId: string): Promise<{ saved: number; pending: number }> {
  const store = db();
  const taskRef = store.collection(COLLECTIONS.tasks).doc(taskId);
  const task = (await taskRef.get()).data() as (TaskDoc & { delivery?: { summary?: string } }) | undefined;
  if (!task || !task.output || task.status !== "delivered") return { saved: 0, pending: 0 };
  if ((task as { remembered?: boolean }).remembered) return { saved: 0, pending: 0 };

  const [userSnap, hireSnap, agentSnap] = await Promise.all([
    store.collection(COLLECTIONS.users).doc(task.userId).get(),
    task.hireId ? store.collection(COLLECTIONS.hires).doc(task.hireId).get() : null,
    store.collection(COLLECTIONS.agents).doc(task.agentId).get(),
  ]);
  const user = userSnap.data() as UserDoc | undefined;
  const hire = hireSnap?.data() as HireDoc | undefined;
  const agent = agentSnap.data() as AgentDoc | undefined;
  if (!user || !hire || !agent) return { saved: 0, pending: 0 };

  const settings = memorySettings(user);
  const shelves = hireShelves(hire, agent).write;
  const logStep = (status: "ok" | "skipped", message: string) =>
    taskRef.update({
      remembered: true,
      steps: FieldValue.arrayUnion({ step: "remember", status, message, at: Timestamp.now() }),
      updatedAt: FieldValue.serverTimestamp(),
    });
  if (!settings.enabled || !shelves.length) {
    await logStep("skipped", settings.enabled ? `${agent.name} doesn't add to company memory.` : "Company memory is off.");
    return { saved: 0, pending: 0 };
  }

  const tz = user.businessProfile?.timeZone ?? "Europe/London";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const known = await recall(user, { ...hire, memory: { read: shelves, write: shelves } }, agent, clip(task.output, 1000), { track: false });

  const { data } = await generateJson({
    tier: "flash",
    thinkingBudget: 0,
    temperature: 0.2,
    schema: Extracted,
    system: [
      `You keep the shared memory for ${user.businessName}'s team of AI agents. Today is ${today}.`,
      "Read what one agent just did and write down at most 3 facts the OTHER agents should know next time they work.",
      "A good fact is durable or time-bound business knowledge: stock levels, delivery dates, payment habits of a customer business, agreed terms, promotions, staff availability.",
      "Each fact is one plain sentence that makes sense on its own: name the customer business or product, and use absolute dates (\"Friday 17 Oct\", never \"Friday\").",
      "Never include email addresses, phone numbers, street addresses, card or bank numbers, or private details about individual people.",
      "Skip anything already in the known facts unless it changed; then write the updated fact.",
      "Skip the agent's own output (the post, the email text) and one-off chatter. Returning no facts is normal.",
      "Set expiresOn to the last day the fact stays true when it's temporary (e.g. out of stock until Friday → Friday's date); otherwise null.",
      `Use only these shelves:\n${shelves.map((s) => `- ${s}: ${SHELF_INFO[s].hint}`).join("\n")}`,
    ].join("\n"),
    parts: [
      {
        text: [
          `Agent: ${agent.name} (${task.skillId})`,
          `Known facts:\n${known.map((k) => `- [${k.shelf}] ${k.fact}`).join("\n") || "(none)"}`,
          `Task input: ${clip(task.input, 3000)}`,
          `Result: ${clip(task.output, 8000)}`,
          task.delivery?.summary ? `What happened: ${task.delivery.summary}` : "",
        ].join("\n\n"),
      },
    ],
  });

  const facts = data.facts.filter((f) => shelves.includes(f.shelf));
  if (!facts.length) {
    await logStep("ok", "Nothing new for company memory.");
    return { saved: 0, pending: 0 };
  }

  const source: Source = { kind: "agent", agentId: agent.slug, agentName: agent.name, taskId };
  const scrubbed = await scrubText(Object.fromEntries(facts.map((f, i) => [String(i), f.fact])));
  let saved = 0;
  let pending = 0;
  for (const [i, f] of facts.entries()) {
    const item = { fact: scrubbed.fields[String(i)], expiresAt: expiryFrom(f.expiresOn) };
    if (settings.approveShelves.includes(f.shelf)) {
      await memory().add({ userId: task.userId, shelf: f.shelf, ...item, status: "pending", source, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      pending++;
    } else {
      await saveFact(task.userId, f.shelf, item, source);
      saved++;
    }
  }
  const parts = [saved && `Added ${saved} fact${saved > 1 ? "s" : ""} to company memory`, pending && `${pending} waiting for your OK on the Memory page`].filter(Boolean);
  await logStep("ok", `${parts.join(" · ")}.`);
  return { saved, pending };
}

/** "2026-10-17" → end of that day (UTC), if it's a real date in the next year. */
export function expiryFrom(day: string | null | undefined, now = Date.now()): Timestamp | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = Date.parse(`${day}T23:59:59Z`);
  if (Number.isNaN(at) || at < now || at > now + 366 * 86_400_000) return null;
  return Timestamp.fromMillis(at);
}

type Item = { fact: string; expiresAt: Timestamp | null };

const savedDoc = (accountId: string, shelf: Shelf, item: Item, source: Source) => ({
  userId: accountId,
  shelf,
  status: "saved" as const,
  source,
  expiresAt: item.expiresAt,
  updatedAt: FieldValue.serverTimestamp(),
});

/** Stores one fact agents can use from now on. */
async function saveFact(accountId: string, shelf: Shelf, item: Item, source: Source, extra: Partial<MemoryDoc> = {}) {
  if (bankEnabled()) {
    try {
      await saveToBank(accountId, shelf, item, source, extra);
      return;
    } catch (err) {
      // Keep the fact in Firestore; recall still finds it there, and syncToBank can move it later.
      log("WARNING", "memory.bank_save_failed", { component: "memory", shelf, error: String(err) });
    }
  }
  await memory().add({ ...savedDoc(accountId, shelf, item, source), ...extra, fact: item.fact, createdAt: FieldValue.serverTimestamp() });
}

/** Memory Bank merges the fact with the shelf; Firestore mirrors whatever it created, updated or removed. */
async function saveToBank(accountId: string, shelf: Shelf, item: Item, source: Source, extra: Partial<MemoryDoc>) {
  const base = savedDoc(accountId, shelf, item, source);
  const changes = await bankGenerate(accountId, shelf, [item.fact]);
  for (const c of changes) {
    const ref = memory().doc(memoryIdOf(c.name));
    if (c.action === "DELETED") {
      await ref.delete();
      continue;
    }
    await bankSetExpiry(c.name, c.fact, item.expiresAt?.toDate() ?? null);
    await ref.set(
      { ...base, ...extra, fact: c.fact, memoryName: c.name, ...(c.action === "CREATED" && { createdAt: FieldValue.serverTimestamp() }) },
      { merge: true },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Owner actions (Memory page)                                         */
/* ------------------------------------------------------------------ */

/**
 * Moves an account's Firestore-only facts (demo seeds, or facts saved while
 * Memory Bank was down) into Memory Bank so they merge with new ones.
 */
export async function syncToBank(accountId: string): Promise<number> {
  if (!bankEnabled()) return 0;
  const snap = await memory().where("userId", "==", accountId).get();
  let moved = 0;
  for (const d of snap.docs) {
    const m = d.data() as MemoryDoc;
    if (m.status !== "saved" || m.memoryName) continue;
    await saveToBank(accountId, m.shelf, { fact: m.fact, expiresAt: (m.expiresAt as Timestamp | null) ?? null }, m.source, {
      ...(m.pinned && { pinned: true }),
    });
    await d.ref.delete();
    moved++;
  }
  return moved;
}

export const FactInput = z.object({
  shelf: z.enum(SHELVES),
  fact: z.string().trim().min(8, "Write the fact as a full sentence.").max(300),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

async function scrubFact(fact: string): Promise<string> {
  return (await scrubText({ fact })).fields.fact;
}

async function ownFact(accountId: string, id: string) {
  const ref = memory().doc(id);
  const snap = await ref.get();
  const m = snap.data() as MemoryDoc | undefined;
  if (!m || m.userId !== accountId) throw new GatewayError("TASK_NOT_FOUND", "That fact isn't in your company memory.");
  return { ref, m };
}

export async function addFact(accountId: string, person: { uid: string; name: string }, input: z.infer<typeof FactInput>) {
  await saveFact(accountId, input.shelf, { fact: await scrubFact(input.fact), expiresAt: expiryFrom(input.expiresOn) }, { kind: "person", ...person });
}

export async function approveFact(accountId: string, id: string) {
  const { ref, m } = await ownFact(accountId, id);
  if (m.status !== "pending") throw new GatewayError("ALREADY_SETTLED", "This fact is already saved.");
  if (bankEnabled()) {
    await saveFact(accountId, m.shelf, { fact: m.fact, expiresAt: (m.expiresAt as Timestamp | null) ?? null }, m.source);
    await ref.delete();
  } else {
    await ref.update({ status: "saved", updatedAt: FieldValue.serverTimestamp() });
  }
}

export async function editFact(accountId: string, id: string, fact: string) {
  const { ref, m } = await ownFact(accountId, id);
  const clean = await scrubFact(fact);
  if (m.memoryName) await bankUpdate(m.memoryName, clean);
  await ref.update({ fact: clean, updatedAt: FieldValue.serverTimestamp() });
}

export async function pinFact(accountId: string, id: string, pinned: boolean) {
  const { ref } = await ownFact(accountId, id);
  await ref.update({ pinned });
}

/** Forget a saved fact or discard a pending one. */
export async function forgetFact(accountId: string, id: string) {
  const { ref, m } = await ownFact(accountId, id);
  if (m.memoryName) await bankDelete(m.memoryName);
  await ref.delete();
}

export const SettingsInput = z.object({
  enabled: z.boolean(),
  approveShelves: z.array(z.enum(SHELVES)).max(SHELVES.length),
});

export async function saveMemorySettings(accountId: string, settings: MemorySettings) {
  await db().collection(COLLECTIONS.users).doc(accountId).update({ memory: settings, updatedAt: FieldValue.serverTimestamp() });
}

/**
 * Removes everything the account has in Memory Bank, shelf by shelf, including
 * memories Firestore never mirrored (the Firestore docs go with the account).
 */
export async function forgetAccountMemory(accountId: string) {
  if (!bankEnabled()) return;
  for (const shelf of SHELVES) {
    for (const name of await bankListScope(accountId, shelf)) await bankDelete(name);
  }
}
