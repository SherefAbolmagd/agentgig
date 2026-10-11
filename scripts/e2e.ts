/**
 * Clicks through the app as a first-time demo visitor and saves screenshots.
 * Needs `npm run dev` running.
 *
 *   npm run e2e                 # screenshots to ./e2e-shots
 *   npm run e2e -- <out-dir>
 */
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const OUT = process.argv[2] ?? "e2e-shots";
mkdirSync(OUT, { recursive: true });

const errors: string[] = [];
let n = 0;
async function shot(page: Page, name: string) {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  📸 ${file}`);
}
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    return r;
  } catch (err) {
    console.log(`✗ ${label}: ${(err as Error).message.split("\n")[0]}`);
    throw err;
  }
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  try {
    await step("home page loads", async () => {
      await page.goto(BASE);
      await page.getByRole("heading", { name: /Hire AI employees/ }).waitFor();
      await shot(page, "home");
    });

    await step("Try the demo signs in and opens the workforce", async () => {
      await page.getByRole("button", { name: /Try the demo/ }).first().click();
      await page.waitForURL("**/workforce", { timeout: 30_000 });
      await page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }).waitFor({ timeout: 30_000 });
      await page.getByText("EchoSocial").first().waitFor();
      await shot(page, "workforce-empty");
    });

    await step("EchoSocial runs and its draft reaches the inbox", async () => {
      await page.getByRole("button", { name: /^ES EchoSocial/ }).click();
      await page.getByRole("button", { name: /Run now · 5 tokens/ }).click();
      await page.getByText(/draft sent to your approval inbox/).waitFor({ timeout: 90_000 });
      await page.getByText("Your LinkedIn post is ready").waitFor({ timeout: 15_000 });
      await shot(page, "echosocial-done");
    });

    await step("Approving the draft delivers it", async () => {
      await page.getByRole("button", { name: "Approve & schedule" }).click();
      await page.getByText(/You're all caught up/).waitFor({ timeout: 30_000 });
      await page.getByText(/You approved/).waitFor({ timeout: 15_000 });
      await shot(page, "approved");
    });

    await step("ReceiptHero audits the sample invoice", async () => {
      await page.getByRole("button", { name: /^RH ReceiptHero/ }).click();
      await page.getByRole("button", { name: "Use sample invoice" }).click();
      await page.getByText("invoice-lumen-supplies.pdf").waitFor();
      await page.getByRole("button", { name: /Run now · 2 tokens/ }).click();
      await page.getByText(/The total doesn't add up/).waitFor({ timeout: 90_000 });
      await shot(page, "receipthero-done");
    });

    await step("balance reflects both charges", async () => {
      const header = await page.locator("header").first().innerText();
      if (!/\b305\b/.test(header)) throw new Error(`expected 305 tokens in header, got: ${header.replace(/\s+/g, " ").slice(0, 120)}`);
    });

    await step("marketplace lists all agents", async () => {
      await page.getByRole("link", { name: "Marketplace" }).click();
      await page.getByRole("heading", { name: "What do you need help with?" }).waitFor();
      await page.getByText("Inventory Guardian").waitFor();
      await shot(page, "marketplace");
    });

    await step("knowledge page shows the demo profile", async () => {
      await page.getByRole("link", { name: "Company knowledge" }).click();
      await page.getByLabel("Business name").waitFor();
      const value = await page.getByLabel("Business name").inputValue();
      if (!value.includes("Café Lumen")) throw new Error(`profile not loaded: "${value}"`);
      await shot(page, "knowledge");
    });

    await step("workforce works at phone width", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(6000); // let toasts from earlier steps close
      await page.getByRole("link", { name: /My workforce/ }).click();
      await page.getByRole("heading", { name: /Good/ }).waitFor();
      const { overflow, culprits } = await page.evaluate(() => {
        const vw = window.innerWidth;
        // Report the outermost elements that stick out, skipping ones inside a horizontal scroller.
        const culprits = Array.from(document.querySelectorAll("body *"))
          .filter((el) => {
            if (el.getBoundingClientRect().right <= vw + 1) return false;
            for (let p = el.parentElement; p; p = p.parentElement) {
              if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return false;
              if (p.getBoundingClientRect().right > vw + 1) return false;
            }
            return true;
          })
          .slice(0, 5)
          .map((el) => `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 80)}"> ${el.textContent?.slice(0, 40)}`);
        return { overflow: document.documentElement.scrollWidth - vw, culprits };
      });
      if (overflow > 1) throw new Error(`page scrolls sideways by ${overflow}px: ${culprits.join(" | ")}`);
      await shot(page, "workforce-mobile");
    });
  } finally {
    await browser.close();
    const real = errors.filter((e) => !/favicon|Download the React DevTools/.test(e));
    console.log(real.length ? `\nBrowser console errors:\n${real.map((e) => `  - ${e}`).join("\n")}` : "\nNo browser console errors.");
  }
}

main().catch(() => process.exit(1));
