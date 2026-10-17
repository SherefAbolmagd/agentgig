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

/** Sam's team when the video starts: every agent starts on an event, nobody types a task. */
const TEAM: { agentId: string; triggerId: string; approvalMode: "ask" | "auto"; priceList?: true }[] = [
  { agentId: "inventory-guardian", triggerId: "order", approvalMode: "ask" },
  { agentId: "order-desk", triggerId: "email", approvalMode: "ask" },
  { agentId: "payment-rescue", triggerId: "payment-failed", approvalMode: "ask" },
  { agentId: "receipthero", triggerId: "drive", approvalMode: "ask" },
  { agentId: "quote-builder", triggerId: "email", approvalMode: "ask", priceList: true },
];

type Fact = { shelf: "customers" | "money" | "stock" | "brand" | "team"; fact: string; pending?: true };

/** What the team already knows about the store. Northside's habit is what Quote Builder uses on camera. */
const facts = (calder: string): Fact[] => [
  { shelf: "stock", fact: `Fig & Cedar is the best seller. Calder Candle Co. pours our candles; send reorders to ${calder}.` },
  { shelf: "money", fact: "Northern Wax Co. invoices are due 30 days after delivery." },
  { shelf: "brand", fact: 'Customer emails are signed "Sam at Willow & Wick" and never use exclamation marks more than once.' },
  { shelf: "team", fact: "Priya packs and ships orders Monday to Thursday; Leo answers customer emails." },
  { shelf: "customers", fact: "Northside Interiors usually pays wholesale invoices about three weeks late, so ask them for a 50% deposit." },
  { shelf: "customers", fact: "Aisha Khan buys an Autumn gift set every October.", pending: true },
];

/** Shopify stock at the start of a take (the take's own orders take it down). */
const STOCK: Record<string, number> = { "WW-FIG": 4, "WW-SAGE": 7, "WW-VET": 31, "WW-MELT": 3, "WW-GIFT": 14, "WW-MATCH": 80 };

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

/** Puts the demo store's stock back, so the take's new order runs Fig & Cedar low again. */
async function resetStock() {
  const { keyFields } = await import("@/lib/connectors/keys");
  const k = await keyFields(VIDEO.uid, "shopify");
  if (!k) return;
  const gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetch(`https://${k.fields.shopDomain}/admin/api/2025-07/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": k.fields.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`Shopify: ${body.errors[0].message}`);
    return body.data;
  };
  const location = (await gql<{ locations: { nodes: { id: string }[] } }>(`{ locations(first: 1) { nodes { id } } }`)).locations.nodes[0].id;
  const variants = (await gql<{ productVariants: { nodes: { sku: string | null; inventoryItem: { id: string } }[] } }>(`{ productVariants(first: 50, query: "sku:WW-*") { nodes { sku inventoryItem { id } } } }`)).productVariants.nodes;
  const quantities = variants.filter((v) => v.sku && v.sku in STOCK).map((v) => ({ inventoryItemId: v.inventoryItem.id, locationId: location, quantity: STOCK[v.sku!] }));
  await gql(
    `mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message } } }`,
    { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities } },
  );
}

export async function resetVideoAccount(): Promise<{ password?: string }> {
  // Shopify and Stripe need a public address to call when the team is hired below.
  process.env.PUBLIC_URL ??= "https://agentexchange-653235000565.us-central1.run.app";
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
  // Emails to and from the video's people (earlier takes) go to the bin.
  const { videoAddresses } = await import("./video-inbox");
  const people = conn ? await videoAddresses() : null;
  if (conn && people) {
    const auth = { authorization: `Bearer ${await accessToken(conn)}` };
    const who = [...Object.values(people), "sophie.turner@example.com", "hannah@hearthandhome.example"];
    const q = encodeURIComponent(`{${who.map((a) => `from:${a} to:${a}`).join(" ")}}`);
    const found = (await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=200`, { headers: auth })).json()) as { messages?: { id: string }[] };
    for (const m of found.messages ?? []) await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/trash`, { method: "POST", headers: auth });
  }
  await resetStock();
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
    // On camera, approving an email sends it, so the sent email can be shown.
    emailOnApprove: "send",
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
  for (const f of facts(people?.calder ?? "orders@caldercandle.example")) {
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
