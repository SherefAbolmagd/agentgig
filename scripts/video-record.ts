/**
 * Records the raw take of the demo video: "a week at Willow & Wick", an
 * online candle store run from Sam's phone. Everything happens for real on
 * agentgig.si, Telegram, Shopify, Stripe and Google; see scripts/video-kit.ts
 * for how it's driven and recorded, and video/prepare.ts for the edit.
 *
 *   VIDEO_PASSWORD=... FFMPEG=<path> npx tsx --conditions=react-server scripts/video-record.ts \
 *     <out-dir> <telegram-profile-dir> <edge-google-profile-dir> <sam-voice-note.wav>
 *
 * Before a take: Shopify connected and seeded (video-connect-shopify.ts, run
 * again within 24 h; video-seed-shopify.ts), Stripe connected (Revenue Pulse;
 * skipped when it isn't), Google connected and signed in on the Edge profile
 * (video-google-login.ts), Telegram linked, and the LabelWise partner running.
 * Earlier takes (Café Lumen) are in git history.
 */
import { readFileSync } from "node:fs";
import { FIX, openStage } from "./video-kit";

const [OUT, TG_PROFILE, GOOGLE_PROFILE, MIC] = process.argv.slice(2);
if (!OUT || !TG_PROFILE || !GOOGLE_PROFILE || !MIC) throw new Error("Usage: video-record.ts <out-dir> <telegram-profile-dir> <edge-google-profile-dir> <sam-voice-note.wav>");
const UID = "video-cafe-lumen";
const LABELWISE_URL = process.env.LABELWISE_URL ?? "https://labelwise-allergens-653235000565.us-central1.run.app";
const VOICE_SECONDS = (readFileSync(MIC).length - 44) / (48000 * 2);

async function main() {
  const { readSecret } = await import("@/lib/secrets");
  const { getConnection } = await import("@/lib/connectors");
  const { driveListInvoices, driveUploadInvoice } = await import("@/lib/connectors/google");
  const { queueDriveInvoices } = await import("@/lib/triggers");
  const apiKey = await readSecret("projects/agentexchange-hackathon/secrets/labelwise-api-key");
  const stripe = !!(await getConnection(UID, "stripe"));

  const stage = await openStage({ out: OUT, tgProfile: TG_PROFILE, micFile: MIC, googleProfile: GOOGLE_PROFILE });
  const { web, mark } = stage;
  const tg = stage.tg!;
  const p = web.page;
  const runButton = () => p.getByRole("button", { name: /Run now · \d+ tokens/ });
  const resultPanel = () => p.getByRole("heading", { name: "Result" }).locator("xpath=ancestor::section[1]");
  const gmailDrafts = "https://mail.google.com/mail/u/0/#drafts";

  await stage.run(async () => {
    /* 1 · Cold open: "where's my order?", answered from the phone */
    mark("cold");
    const reply = await tg.ask(`Can you answer this? ${readFileSync(`${FIX}/order-question.txt`, "utf8")}`, /Order reply ready|reply ready/i, { paste: true });
    mark("cold draft");
    await tg.me.point(reply);
    await tg.me.pause(2200);
    await tg.tap(reply, "Approve");
    await tg.waitFor(/Approved/);
    mark("cold approved");

    /* 3 · Home */
    mark("scene 3 home");
    await web.go("/workforce");
    await web.pause(1200);
    await web.show(p.locator("header").getByText(/tokens?/i).first(), 1200);
    await web.scroll(420);
    await web.pause(1300);
    await web.scroll(-420);

    /* 4 · Stock: Inventory Guardian reads Shopify (it runs by itself at 07:00) */
    mark("scene 4 stock");
    await web.go("/workforce?agent=inventory-guardian");
    await runButton().waitFor({ timeout: 30_000 });
    await web.show(p.getByText(/Live stock from/).first(), 900);
    await web.click(runButton());
    const reorder = await tg.waitFor(/Reorder/);
    mark("stock ready");
    await web.show(resultPanel(), 2500);
    await tg.tap(reorder, "Approve");
    await tg.waitFor(/Approved/, 1);
    mark("stock approved");
    await web.glance(gmailDrafts, (g) => g.getByRole("main"), 3000);
    mark("drafts shown");

    /* 5 · Voice note: how did the week go? (Revenue Pulse reads Stripe) */
    if (stripe) {
      mark("scene 5 revenue");
      const before = await tg.incoming(/£|GBP|takings|revenue/i).count();
      await tg.voice(VOICE_SECONDS);
      mark("voice sent");
      await tg.waitFor(/£|GBP|takings|revenue/i, before);
      mark("revenue posted");
      await tg.me.pause(2500);
    }

    /* 6 · Hire Win-back */
    mark("scene 6 hire");
    await web.click(p.getByRole("link", { name: "Marketplace" }));
    await web.redraw();
    const card = p.locator("article", { hasText: "Win-back" });
    await web.show(card, 900);
    await web.click(card.getByRole("button", { name: /^Hire/ }));
    const dialog = p.getByRole("dialog");
    await dialog.waitFor();
    await web.show(dialog.getByText(/Connected/).first(), 900);
    await web.click(dialog.getByText("Ask me first"));
    await web.type(dialog.getByLabel("Monthly token limit"), "30");
    await web.click(dialog.getByRole("button", { name: "Hire Win-back" }));
    await p.getByText("Win-back joined your team.").waitFor({ timeout: 20_000 });
    mark("hired");

    /* 7 · Win-back finds customers who stopped ordering */
    mark("scene 7 winback");
    await web.go("/workforce?agent=winback");
    await runButton().waitFor({ timeout: 30_000 });
    await web.click(runButton());
    const winback = await tg.waitFor(/win-back emails? ready/i);
    mark("winback ready");
    await web.show(resultPanel(), 2500);
    await tg.tap(winback, "Approve");
    await tg.waitFor(/Approved/, 2);
    mark("winback approved");

    /* 8 · A wholesale enquiry becomes a quote */
    mark("scene 8 quote");
    const quote = await tg.ask(`Can you quote this? ${readFileSync(`${FIX}/wholesale-enquiry.txt`, "utf8")}`, /Quote Q-/, { paste: true });
    mark("quote posted");
    await tg.me.point(quote);
    await tg.me.pause(2200);
    await tg.tap(quote, "Approve");
    await tg.waitFor(/draft in Gmail/);
    mark("quote approved");
    await web.glance(gmailDrafts, (g) => g.getByText(/Your quote Q-/).first(), 2500);

    /* 9 · A supplier invoice lands in Google Drive */
    mark("scene 9 drive");
    const folder = await driveListInvoices(UID);
    await driveUploadInvoice(UID, { name: "invoice-NW-3317.pdf", mimeType: "application/pdf", data: readFileSync(`${FIX}/invoice-NW-3317.pdf`) });
    mark("drive upload");
    if (folder) await web.glance(`https://drive.google.com/drive/folders/${folder.folderId}`, (g) => g.getByText("invoice-NW-3317.pdf").first(), 2500);
    // Drive is checked every 5 minutes; the edit skips ahead to the check.
    await queueDriveInvoices();
    mark("drive checked");
    const over = await tg.waitFor("overcharged by");
    mark("invoice draft");
    await tg.me.pause(1500);
    await tg.tap(over, "Approve");
    await tg.waitFor(/drafted a correction email/);
    mark("invoice approved");
    const sheet = (await getConnection(UID, "google"))?.meta?.spendSheetId as string | undefined;
    if (sheet) await web.glance(`https://docs.google.com/spreadsheets/d/${sheet}`, (g) => g.getByText(/NW-3317|Northern Wax/).first(), 2500);

    /* 10 · Memory: a fact waits for Sam's OK, then Ada uses it */
    mark("scene 10 memory");
    await web.go("/memory");
    const waiting = p.getByRole("region", { name: "Waiting for your OK" });
    await web.show(waiting, 1500);
    await web.click(waiting.getByRole("button", { name: "Remember it" }).first());
    mark("fact approved");
    await web.pause(1200);
    await tg.ask("Who's slow to pay us?", /Northside/);
    mark("memory answered");

    /* 11 · Team: invite Priya as a manager */
    mark("scene 11 team");
    await web.go("/team");
    await p.locator("#invite-label").waitFor({ timeout: 30_000 });
    await web.type(p.locator("#invite-label"), "Priya", 50);
    await web.click(p.locator("#invite-role"));
    await web.click(p.getByRole("option", { name: "Manager" }));
    await web.click(p.getByRole("button", { name: "Create invite link" }));
    await web.show(p.getByLabel("Invite link"), 2500);
    mark("invite created");

    /* 12 · Developers: a partner registers their agent live */
    mark("scene 12 developers");
    await web.go("/developers");
    await p.locator("#cardUrl").waitFor({ timeout: 30_000 });
    await web.paste(p.locator("#cardUrl"), `${LABELWISE_URL}/.well-known/agent-card.json`);
    await web.paste(p.locator("#apiKey"), apiKey);
    await web.click(p.getByRole("button", { name: "Check and publish" }));
    await p.getByText(/is live in the marketplace/).first().waitFor({ timeout: 90_000 });
    mark("partner listed");
    await web.show(p.locator("main"), 3000);

    /* 13 · What it all cost */
    mark("scene 13 cost");
    await tg.ask("What did all of this cost us?", /tokens/);
    mark("cost answered");
    await tg.me.pause(2000);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
