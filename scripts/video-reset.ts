/**
 * Puts the demo-video account back to the moment the video starts, so every
 * take begins the same. It only touches the video account (uid
 * video-cafe-lumen), never the judges' or anyone else's.
 *
 * Kept between takes: the sign-in, the Google connection and Sam's Telegram
 * link. Cleared: tasks, ledger, approvals, hires, memory, uploaded files,
 * teammates, invites and the Telegram chat history.
 *
 *   npm run video:reset                       (the first run prints the password)
 *   VIDEO_PASSWORD=... npm run video:reset    sets a password of your choice
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export const VIDEO = {
  uid: "video-cafe-lumen",
  email: "video@agentgig.si",
  startingTokens: 480,
} as const;

/** Willow & Wick: the online candle store the video follows. */
const STORE = {
  businessName: "Willow & Wick",
  displayName: "Sam Patel",
  profile: {
    description: "Online store selling soy candles, wax melts and gift sets. We design the scents in Leeds; our partner chandlery Calder Candle Co. pours them. We ship across the UK and supply a few homeware shops wholesale.",
    products: "Candles 300g £22–£26 (Fig & Cedar is the best seller), wax melts £9.50, Autumn gift set £48, long matches £4. Wholesale prices in our price list.",
    audience: "People buying candles for their home or as gifts, and independent homeware shops",
    toneOfVoice: "Warm, calm and personal, like a friend recommending a candle; never pushy",
    avoidWords: ["luxury", "game-changer", "exclusive offer"],
    website: "https://willow-and-wick.myshopify.com",
    location: "Leeds, UK",
    timeZone: "Europe/London",
  },
} as const;

/** The team Sam already has when the video starts; Win-back is hired on camera. */
const TEAM: { agentId: string; triggerId: string; approvalMode: "ask" | "auto"; priceList?: true }[] = [
  { agentId: "order-desk", triggerId: "email", approvalMode: "ask" },
  { agentId: "inventory-guardian", triggerId: "daily-0700", approvalMode: "ask" },
  { agentId: "revenue-pulse", triggerId: "mon-0800", approvalMode: "ask" },
  { agentId: "quote-builder", triggerId: "email", approvalMode: "ask", priceList: true },
  { agentId: "receipthero", triggerId: "drive", approvalMode: "ask" },
];

/** What the team already knows about the store; the Customers fact waits for Sam's OK. */
const FACTS: { shelf: "customers" | "money" | "stock" | "brand" | "team"; fact: string; pending?: true }[] = [
  { shelf: "stock", fact: "Fig & Cedar is the best seller; reorder from Calder Candle Co. when fewer than 10 are left." },
  { shelf: "money", fact: "Northern Wax Co. invoices are due 30 days after delivery." },
  { shelf: "brand", fact: "Customer emails are signed \"Sam at Willow & Wick\" and never use exclamation marks more than once." },
  { shelf: "team", fact: "Priya packs and ships orders Monday to Thursday; Leo answers customer emails." },
  { shelf: "customers", fact: "Northside Interiors usually pays wholesale invoices about three weeks late.", pending: true },
];

const CLEARED = ["tasks", "token_transactions", "approvals", "hires", "knowledge_sources", "style_examples", "invoice_keys", "memory"] as const;

/** AgentGig's agents started drafting in this Gmail on this day; older drafts are the owner's. */
const AGENTS_SINCE = Date.parse("2026-10-16T00:00:00Z");

async function deleteAgentDrafts(token: string): Promise<number> {
  const auth = { authorization: `Bearer ${token}` };
  const list = (await (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=200", { headers: auth })).json()) as { drafts?: { id: string }[] };
  let deleted = 0;
  for (const d of list.drafts ?? []) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}?format=minimal`, { headers: auth });
    if (!r.ok) continue;
    const m = (await r.json()) as { message?: { internalDate?: string } };
    if (Number(m.message?.internalDate ?? 0) < AGENTS_SINCE) continue;
    if ((await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}`, { method: "DELETE", headers: auth })).ok) deleted++;
  }
  return deleted;
}

export async function resetVideoAccount(): Promise<{ password?: string }> {
  const { FieldValue } = await import("firebase-admin/firestore");
  const { Storage } = await import("@google-cloud/storage");
  const { adminAuth, db } = await import("@/lib/firebase-admin");
  const { env } = await import("@/lib/env");
  const { hireAgent } = await import("@/lib/hires");
  const { forgetAccountMemory, queueBankSync } = await import("@/lib/memory");
  const { deleteMemberships } = await import("@/lib/org");
  const { addKnowledge } = await import("@/lib/knowledge");
  const { COLLECTIONS } = await import("@/types/firestore");
  const store = db();
  const uid = VIDEO.uid;

  // Memory Bank copies first, while the memory docs still list them.
  await forgetAccountMemory(uid);
  await deleteMemberships(uid);
  await store.recursiveDelete(store.collection(COLLECTIONS.telegramChats).doc(`${uid}_${uid}`));
  // Ada calls the person by the link's first name; on camera that's Sam, whoever's Telegram it is.
  await store.collection(COLLECTIONS.telegramLinks).doc(uid).update({ pendingEdit: null, firstName: "Sam" }).catch(() => undefined);
  for (const name of CLEARED) {
    for (;;) {
      const snap = await store.collection(name).where("userId", "==", uid).limit(400).get();
      if (snap.empty) break;
      const batch = store.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  const storage = new Storage({ projectId: env().GOOGLE_CLOUD_PROJECT });
  for (const [bucket, prefix] of [
    [env().KNOWLEDGE_BUCKET, `users/${uid}/`],
    [env().INBOX_BUCKET, `${uid}/`],
  ] as const) {
    if (!bucket) continue;
    const [objects] = await storage.bucket(bucket).getFiles({ prefix });
    await Promise.all(objects.map((o) => o.delete({ ignoreNotFound: true })));
  }

  // Empty the Drive invoice folder, so the take's invoices are the only ones there.
  const { driveListInvoices } = await import("@/lib/connectors/google");
  const { getConnection } = await import("@/lib/connectors");
  const { accessToken } = await import("@/lib/connectors/tokens");
  const conn = await getConnection(uid, "google");
  const folder = conn ? await driveListInvoices(uid).catch(() => null) : null;
  if (conn && folder?.files.length) {
    const token = await accessToken(conn);
    await Promise.all(folder.files.map((f) => fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })));
  }
  // Delete the Gmail drafts earlier takes left, so the take's drafts are the only ones on
  // screen: everything drafted since the agents started here. The owner's older drafts stay.
  if (conn) await deleteAgentDrafts(await accessToken(conn));
  // The customers' emails earlier takes delivered to the inbox go to the bin.
  if (conn) {
    const auth = { authorization: `Bearer ${await accessToken(conn)}` };
    const q = encodeURIComponent("from:(sophie.turner@example.com OR hannah@hearthandhome.example)");
    const found = (await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=100`, { headers: auth })).json()) as { messages?: { id: string }[] };
    for (const m of found.messages ?? []) await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/trash`, { method: "POST", headers: auth });
  }
  // The spend sheet AgentGig made: clear earlier takes' rows, keep the header.
  const sheetId = conn?.meta?.spendSheetId as string | undefined;
  if (conn && sheetId) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Invoices!A2:Z5000:clear`, { method: "POST", headers: { authorization: `Bearer ${await accessToken(conn)}` } });
  }

  // The sign-in: created once, then only its password changes if asked.
  let password: string | undefined;
  try {
    await adminAuth().getUser(uid);
    if (process.env.VIDEO_PASSWORD) {
      password = process.env.VIDEO_PASSWORD;
      await adminAuth().updateUser(uid, { password });
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
    password = process.env.VIDEO_PASSWORD ?? randomBytes(9).toString("base64url");
    await adminAuth().createUser({ uid, email: VIDEO.email, password, displayName: STORE.displayName, emailVerified: true });
  }

  const userRef = store.collection(COLLECTIONS.users).doc(uid);
  const existing = await userRef.get();
  await userRef.set({
    displayName: STORE.displayName,
    email: VIDEO.email,
    businessName: STORE.businessName,
    tokenBalance: VIDEO.startingTokens,
    tokensHeld: 0,
    tokensSpent: 0,
    businessProfile: STORE.profile,
    // Not a sandbox: the daily cleanup must leave it alone.
    isDemo: false,
    createdAt: existing.exists ? existing.get("createdAt") : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await store.collection(COLLECTIONS.tokenTransactions).add({
    userId: uid,
    type: "topup",
    amount: VIDEO.startingTokens,
    balanceAfter: VIDEO.startingTokens,
    description: "Token pack",
    createdAt: FieldValue.serverTimestamp(),
  });
  // The wholesale price list Quote Builder prices from.
  const { id: priceListId } = await addKnowledge(uid, { name: "wholesale-price-list.md", mimeType: "text/markdown", data: readFileSync("fixtures/video/wholesale-price-list.md") });
  for (const { priceList, ...h } of TEAM) await hireAgent(uid, { ...h, knowledgeAccess: priceList ? ["profile", priceListId] : ["profile"] });
  const batch = store.batch();
  for (const f of FACTS) {
    batch.set(store.collection(COLLECTIONS.memory).doc(), {
      userId: uid,
      shelf: f.shelf,
      fact: f.fact,
      status: f.pending ? "pending" : "saved",
      source: { kind: "person", uid, name: STORE.displayName },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  // Partner listings registered from this account on camera are removed, so the next take can register them again.
  const listed = await store.collection(COLLECTIONS.agents).where("ownerUid", "==", uid).get();
  await Promise.all(listed.docs.map((d) => d.ref.delete()));
  await queueBankSync(uid);
  return { password };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/video-reset.ts")) {
  resetVideoAccount()
    .then(({ password }) => {
      console.log(`✓ ${VIDEO.email} is ready for a take: ${VIDEO.startingTokens} tokens, ${TEAM.length} agents hired, memory seeded.`);
      if (password) console.log(`  Password: ${password}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
