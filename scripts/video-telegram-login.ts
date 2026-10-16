/**
 * Opens Telegram Web in a browser profile kept for the video recorder, so you
 * can log in once with a QR code. The profile holds a live Telegram session:
 * keep it outside the repo, and end the session (Settings → Devices) when done.
 *
 *   npx tsx scripts/video-telegram-login.ts <profile-dir>
 */
import { chromium } from "playwright";

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("Pass the profile directory.");
  const ctx = await chromium.launchPersistentContext(dir, { headless: false, viewport: { width: 1100, height: 900 } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://web.telegram.org/k/");
  console.log("Scan the QR code: Telegram on your phone → Settings → Devices → Link Desktop Device.");
  // Logged in once the chat list's search box shows up.
  await page.locator(".input-search input, input.input-search-input").first().waitFor({ timeout: 300_000 });
  await page.waitForTimeout(5000);
  console.log("✓ Logged in. Closing.");
  await ctx.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
