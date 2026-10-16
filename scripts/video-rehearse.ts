/**
 * Dress rehearsal for the demo video: runs every beat of the story on the
 * real gateway, Gemini, Firestore, Memory Bank and the partner agent, against
 * the video account only. Telegram is the one thing faked: messages Ada and
 * the agents would send are printed here instead, so nothing reaches a phone.
 * Sam's real Telegram link (if any) is put back at the end.
 *
 *   npm run video:rehearse            all beats
 *   npm run video:rehearse -- quote   only beats whose name contains "quote"
 */
// Telegram stub before anything reads the environment (dotenv never overrides).
process.env.TELEGRAM_BOT_TOKEN = "rehearsal";
process.env.TELEGRAM_BOT_USERNAME = "AgentGigBot";
process.env.TELEGRAM_WEBHOOK_SECRET = "rehearsal-secret";

import { readFileSync } from "node:fs";

const FAKE_TG = 777_000_001;
let messageId = 1000;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url);
  if (!u.startsWith("https://api.telegram.org/")) return realFetch(url, init);
  const method = u.split("/").pop();
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  if (method === "sendMessage") {
    const text = String(body.text).replace(/<\/?b>/g, "").replace(/<blockquote[^>]*>/g, "\n  │ ").replace(/<\/blockquote>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const kb = (body.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined)?.inline_keyboard;
    console.log(`  📱 ${text.replace(/\n/g, "\n     ")}${kb ? `\n     [${kb.flat().map((b) => b.text).join("] [")}]` : ""}`);
  } else if (method === "setMessageReaction") {
    console.log(`  📱 (reacts ${JSON.stringify((body.reaction as { emoji: string }[] | undefined)?.map((r) => r.emoji) ?? [])})`);
  } else if (method === "editMessageText" || method === "sendChatAction") {
    // live status lines: show them once, dimly
    if (body.text) console.log(`  📱 · ${String(body.text)}`);
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const only = process.argv[2];

async function main() {
  const { resetVideoAccount, VIDEO } = await import("./video-reset");
  const { DIR, writeVideoFixtures } = await import("./video-fixtures");
  const { FieldValue } = await import("firebase-admin/firestore");
  const { db } = await import("@/lib/firebase-admin");
  const { addKnowledge } = await import("@/lib/knowledge");
  const { hireAgent } = await import("@/lib/hires");
  const { dropInInbox } = await import("@/lib/triggers");
  const { runTask } = await import("@/lib/gateway/pipeline");
  const { runTelegramJob } = await import("@/lib/telegram/webhook");
  const { COLLECTIONS } = await import("@/types/firestore");
  const store = db();
  const uid = VIDEO.uid;

  writeVideoFixtures();
  console.log("Resetting the video account…");
  await resetVideoAccount();

  // Swap in a fake Telegram link for the rehearsal; the real one goes back at the end.
  const linkRef = store.collection(COLLECTIONS.telegramLinks).doc(uid);
  const realLink = await linkRef.get();
  await linkRef.set({ accountId: uid, uid, telegramUserId: FAKE_TG, chatId: FAKE_TG, username: "sam", firstName: "Sam", linkedAt: FieldValue.serverTimestamp(), pendingEdit: null });

  let update = Date.now();
  const say = async (text: string) => {
    console.log(`  🧑 Sam: ${text}`);
    const res = await runTelegramJob({ updateId: ++update, telegramUserId: FAKE_TG, chatId: FAKE_TG, kind: "message", text, messageId: ++messageId });
    if (res !== "answered") console.log(`  ⚠ job: ${res}`);
  };
  const tap = async (approvalId: string, choice: "a" | "e" | "s") => {
    console.log(`  🧑 Sam taps ${{ a: "Approve", e: "Edit", s: "Skip" }[choice]}`);
    console.log(`  ⚙ ${await runTelegramJob({ updateId: ++update, telegramUserId: FAKE_TG, chatId: FAKE_TG, kind: "callback", callbackId: "cb", callbackData: `ap:${approvalId}:${choice}`, messageId: ++messageId })}`);
  };
  const waitFor = async <T>(what: string, check: () => Promise<T | undefined>, seconds = 180): Promise<T> => {
    for (let i = 0; i < seconds; i++) {
      const v = await check();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const openApproval = (agentId: string) =>
    waitFor(`${agentId} approval`, async () => {
      const s = await store.collection(COLLECTIONS.approvals).where("userId", "==", uid).where("agentId", "==", agentId).where("status", "==", "open").get();
      return s.docs[0]?.id;
    });

  const beats: [string, () => Promise<void>][] = [
    [
      "knowledge+hire: upload the price list, hire Quote Builder",
      async () => {
        const file = { name: "catering-price-list.md", mimeType: "text/markdown", data: readFileSync(`${DIR}/catering-price-list.md`) };
        const { id } = await addKnowledge(uid, file);
        await hireAgent(uid, { agentId: "quote-builder", triggerId: "manual", approvalMode: "ask", knowledgeAccess: ["profile", id] });
        console.log("  ✓ price list uploaded, Quote Builder hired with access to it");
      },
    ],
    [
      "invoice: drop two invoices in the inbox, one overcharged",
      async () => {
        for (const name of ["invoice-BD-5582.pdf", "invoice-INV-21407.pdf"]) {
          await dropInInbox(uid, { name, mimeType: "application/pdf", data: readFileSync(`${DIR}/${name}`) });
        }
        // The production server handles inbox uploads too, so whichever copy runs first wins.
        for (let n = 0; n < 2; n++) {
          const approvalId = await openApproval("receipthero");
          const a = (await store.collection(COLLECTIONS.approvals).doc(approvalId).get()).data()!;
          console.log(`  ✓ approval: ${a.title} · ${a.preview}`);
          await tap(approvalId, "a");
        }
      },
    ],
    ["vat: ask Ada for the VAT summary (partner agent over A2A)", () => say("Can you get the VAT summary for October ready?")],
    ["memory: ask about oat milk", () => say("How are we on oat milk this week?")],
    [
      "quote: forward the catering enquiry",
      async () => {
        await say(`Can you quote this? ${readFileSync(`${DIR}/catering-enquiry.txt`, "utf8")}`);
        const approvalId = await openApproval("quote-builder").catch(() => undefined);
        if (approvalId) await tap(approvalId, "a");
      },
    ],
    ["remember: tell Ada something for the team", () => say("Remember that Brightwell Studio has a few vegans, always include vegan pastries for them.")],
    [
      "review: hand Ada a Google review",
      async () => {
        await say(`We got this review, can you draft a reply? ${readFileSync(`${DIR}/google-review.txt`, "utf8")}`);
        const approvalId = await openApproval("reviewpulse").catch(() => undefined);
        if (approvalId) await tap(approvalId, "e");
        await say("Sorry Tom, that's not the standard we hold ourselves to. Jordan now leaves 30 minutes earlier on Mondays and we've added a second oat milk supplier. Your next delivery's pastries are on us. Sam");
      },
    ],
    [
      "rota: build next week's rota (on the website)",
      async () => {
        const monday = new Date();
        monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
        const res = await runTask({ userId: uid, agentId: "rotabuilder", rawInput: { staffCsv: readFileSync(`${DIR}/staff.csv`, "utf8"), weekStarting: monday.toISOString().slice(0, 10) }, files: [], origin: "manual", requestedBy: uid });
        console.log(`  ✓ ${res.status}, ${res.tokensCharged} tokens`);
      },
    ],
    ["status: ask Ada what the morning cost", () => say("What did all that cost us this morning?")],
  ];

  try {
    for (const [name, run] of beats) {
      if (only && !name.includes(only)) continue;
      console.log(`\n▶ ${name}`);
      const t = Date.now();
      try {
        await run();
      } catch (err) {
        console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
      }
      console.log(`  ⏱ ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }
    const user = (await store.collection(COLLECTIONS.users).doc(uid).get()).data()!;
    const tasks = await store.collection(COLLECTIONS.tasks).where("userId", "==", uid).get();
    console.log(`\nBalance ${user.tokenBalance} (spent ${user.tokensSpent}, held ${user.tokensHeld}); tasks: ${tasks.docs.map((d) => `${d.get("agentId")}=${d.get("status")}/${d.get("settlement") ?? "-"}`).join(", ")}`);
  } finally {
    if (realLink.exists) await linkRef.set(realLink.data()!);
    else await linkRef.delete();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
