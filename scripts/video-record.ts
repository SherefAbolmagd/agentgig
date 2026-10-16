/**
 * Records the demo video's raw take: agentgig.si (left, 1280×1080) and
 * Telegram Web (right, 640×1080) driven like a person would, with a visible
 * pointer. Frames come from Chrome's screencast at full quality; every step's
 * time goes to marks.json so the edit can cut waits and speed up agent runs.
 *
 *   VIDEO_PASSWORD=... FFMPEG=<path> npx tsx --conditions=react-server scripts/video-record.ts <out-dir> [telegram-profile-dir]
 *
 * Without a Telegram profile it records the website alone and approves drafts
 * on the website, which is how the website half is tested.
 * Writes <out-dir>/web.mp4, telegram.mp4 (if any), raw.mp4 (side by side) and marks.json.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

const BASE = process.env.VIDEO_BASE ?? "https://agentgig.si";
const FIX = "fixtures/video";
const [OUT, TG_PROFILE] = process.argv.slice(2);
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
if (!OUT) throw new Error("Pass the output directory.");
mkdirSync(OUT, { recursive: true });

const T0 = Date.now() / 1000;
const marks: { t: number; label: string }[] = [];
const mark = (label: string) => {
  const t = Date.now() / 1000 - T0;
  marks.push({ t, label });
  console.log(`${t.toFixed(1).padStart(6)} s  ${label}`);
};

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

class Screencast {
  frames: { file: string; t: number }[] = [];
  private n = 0;
  constructor(private page: Page, private name: string, private w: number, private h: number) {
    mkdirSync(`${OUT}/${name}`, { recursive: true });
  }
  async start() {
    const cdp = await this.page.context().newCDPSession(this.page);
    cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      const file = `${OUT}/${this.name}/${String(++this.n).padStart(6, "0")}.jpg`;
      writeFileSync(file, Buffer.from(data, "base64"));
      this.frames.push({ file, t: (metadata.timestamp ?? Date.now() / 1000) - T0 });
      await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: this.w, maxHeight: this.h, everyNthFrame: 1 });
  }
  /** One constant-frame-rate MP4 from T0 to `end`, each frame held until the next. */
  encode(end: number): string {
    const lines: string[] = [];
    const frames = this.frames.filter((f) => f.t >= 0);
    frames.forEach((f, i) => {
      const next = frames[i + 1]?.t ?? end;
      lines.push(`file '${f.file.replace(/\\/g, "/").split("/").pop()}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
    });
    // The first frame also covers the time before it arrived.
    if (frames[0]) lines.splice(1, 1, `duration ${(frames[1]?.t ?? end).toFixed(4)}`);
    lines.push(lines[lines.length - 2]); // concat demuxer drops the last duration otherwise
    const list = `${OUT}/${this.name}/frames.txt`;
    writeFileSync(list, lines.join("\n"));
    const out = `${OUT}/${this.name}.mp4`;
    execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=30,scale=${this.w}:${this.h}:force_original_aspect_ratio=decrease,pad=${this.w}:${this.h}:(ow-iw)/2:0,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "16", out]);
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* A person at the controls                                            */
/* ------------------------------------------------------------------ */

const POINTER = `(() => {
  const draw = (x, y) => {
    let c = document.getElementById("__pointer");
    if (!c) {
      c = document.createElement("div");
      c.id = "__pointer";
      c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 2.5v17.2l4.3-4.1 2.9 6.6 2.9-1.3-2.9-6.5 5.9-.3z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      Object.assign(c.style, { position: "fixed", zIndex: "2147483647", pointerEvents: "none", width: "24px", height: "24px", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" });
      document.documentElement.appendChild(c);
    }
    c.style.left = x - 5 + "px";
    c.style.top = y - 2 + "px";
  };
  addEventListener("mousemove", (e) => draw(e.clientX, e.clientY), true);
  addEventListener("mousedown", (e) => {
    const r = document.createElement("div");
    Object.assign(r.style, { position: "fixed", left: e.clientX - 14 + "px", top: e.clientY - 14 + "px", width: "28px", height: "28px", borderRadius: "50%", background: "rgba(232,93,4,.35)", zIndex: "2147483646", pointerEvents: "none", transition: "transform .35s ease-out, opacity .35s ease-out" });
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; });
    setTimeout(() => r.remove(), 400);
  }, true);
})();`;

class Person {
  x = 640;
  y = 540;
  constructor(public page: Page) {}
  async setup() {
    await this.page.addInitScript(POINTER);
  }
  pause(ms = 600) {
    return this.page.waitForTimeout(ms);
  }
  /** Glides the pointer, like a hand on a mouse: quick in the middle, slow at the ends. */
  async moveTo(x: number, y: number) {
    const dist = Math.hypot(x - this.x, y - this.y);
    const steps = Math.max(8, Math.min(45, Math.round(dist / 18)));
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      await this.page.mouse.move(this.x + (x - this.x) * e, this.y + (y - this.y) * e);
      await this.page.waitForTimeout(12);
    }
    this.x = x;
    this.y = y;
  }
  async point(target: Locator) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("Can't see the element to point at");
    await this.moveTo(box.x + box.width / 2, box.y + box.height / 2);
  }
  async click(target: Locator, after = 500) {
    await target.waitFor({ state: "visible", timeout: 30_000 });
    await this.point(target);
    await this.pause(220);
    await this.page.mouse.down();
    await this.page.mouse.up();
    await this.pause(after);
  }
  async type(target: Locator, text: string, delay = 38) {
    await this.click(target, 200);
    await this.page.keyboard.type(text, { delay });
  }
  /** Pastes, for long text nobody would type out. */
  async paste(target: Locator, text: string) {
    await this.click(target, 200);
    await this.page.keyboard.insertText(text);
  }
  async scroll(dy: number) {
    const step = dy > 0 ? 60 : -60;
    for (let done = 0; Math.abs(done) < Math.abs(dy); done += step) {
      await this.page.mouse.wheel(0, step);
      await this.page.waitForTimeout(16);
    }
    await this.pause(300);
  }
  /** After a navigation the pointer is redrawn where it was. */
  async redraw() {
    await this.page.mouse.move(this.x, this.y);
  }
}

/* ------------------------------------------------------------------ */
/* Telegram Web (K)                                                    */
/* ------------------------------------------------------------------ */

class Telegram {
  constructor(public me: Person) {}
  get page() {
    return this.me.page;
  }
  input() {
    return this.page.locator("div.input-message-input[contenteditable=true]:not(.input-field-input-fake)").first();
  }
  async send(text: string, { paste = false } = {}) {
    if (paste) await this.me.paste(this.input(), text);
    else await this.me.type(this.input(), text);
    await this.me.pause(300);
    await this.page.keyboard.press("Enter");
  }
  /** Waits for a message containing `text` and returns its bubble. */
  async waitFor(text: string | RegExp, timeout = 180_000) {
    const bubble = this.page.locator(".bubble", { hasText: text }).last();
    await bubble.waitFor({ timeout });
    await bubble.scrollIntoViewIfNeeded().catch(() => undefined);
    return bubble;
  }
  async tap(bubble: Locator, button: string) {
    await this.me.click(bubble.locator(".reply-markup-button", { hasText: button }).first(), 800);
  }
}

/* ------------------------------------------------------------------ */
/* The take                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  const password = process.env.VIDEO_PASSWORD;
  if (!password) throw new Error("Set VIDEO_PASSWORD to the video account's password.");
  const { resetVideoAccount, VIDEO } = await import("./video-reset");
  console.log("Resetting the video account…");
  await resetVideoAccount();

  const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
  const webCtx = await browser.newContext({ viewport: { width: 1280, height: 1080 }, deviceScaleFactor: 1, locale: "en-GB", timezoneId: "Europe/London" });
  const web = new Person(await webCtx.newPage());
  await web.setup();

  let tgCtx: BrowserContext | undefined;
  let tg: Telegram | undefined;
  if (TG_PROFILE) {
    tgCtx = await chromium.launchPersistentContext(TG_PROFILE, { headless: process.env.HEADED !== "1", viewport: { width: 640, height: 1080 }, locale: "en-GB", timezoneId: "Europe/London" });
    const p = tgCtx.pages()[0] ?? (await tgCtx.newPage());
    tg = new Telegram(new Person(p));
    await tg.me.setup();
    await p.goto("https://web.telegram.org/k/#@AgentGigBot");
    await tg.input().waitFor({ timeout: 60_000 });
  }

  // Signed in before the camera rolls.
  await web.page.goto(`${BASE}/workforce`);
  const email = web.page.getByLabel("Email");
  await email.waitFor({ timeout: 30_000 });
  if (await web.page.getByRole("button", { name: "Sign in", exact: true }).count() === 0) {
    await web.page.getByRole("button", { name: "Sign in" }).last().click();
  }
  await email.fill(VIDEO.email);
  await web.page.getByLabel("Password").fill(password);
  await web.page.getByRole("button", { name: "Sign in", exact: true }).click();
  await web.page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }).waitFor({ timeout: 30_000 });
  await web.page.waitForTimeout(1500);

  const webCam = new Screencast(web.page, "web", 1280, 1080);
  const tgCam = tg ? new Screencast(tg.page, "telegram", 640, 1080) : undefined;
  await webCam.start();
  await tgCam?.start();
  await web.redraw();
  await tg?.me.redraw();
  mark("start");

  try {
    /* 2 · Home */
    mark("scene 2 home");
    await web.pause(1200);
    await web.point(web.page.locator("header").getByText(/tokens?/i).first()).catch(() => undefined);
    await web.pause(1200);
    await web.scroll(500);
    await web.pause(1200);
    await web.scroll(-500);

    /* 3 · Company knowledge + memory */
    mark("scene 3 knowledge");
    await web.click(web.page.getByRole("link", { name: "Company knowledge" }));
    await web.page.getByLabel("Business name").waitFor();
    await web.redraw();
    await web.pause(1000);
    await web.scroll(700);
    const files = web.page.locator("section", { has: web.page.getByRole("heading", { name: "Files" }) });
    await web.point(files);
    await web.page.locator("input[type=file]").first().setInputFiles(`${FIX}/catering-price-list.md`);
    await web.page.getByText("catering-price-list.md added.").waitFor({ timeout: 60_000 });
    mark("price list uploaded");
    await web.pause(1500);
    await web.click(web.page.getByRole("link", { name: "Memory" }));
    await web.redraw();
    await web.pause(2500);
    await web.scroll(400);
    await web.pause(1500);

    /* 4 · Hire Quote Builder */
    mark("scene 4 hire");
    await web.click(web.page.getByRole("link", { name: "Marketplace" }));
    await web.redraw();
    await web.pause(800);
    const card = web.page.locator("article", { hasText: "Quote Builder" });
    await web.point(card);
    await web.pause(800);
    await web.click(card.getByRole("button", { name: /^Hire/ }));
    const dialog = web.page.getByRole("dialog");
    await dialog.waitFor();
    await web.pause(800);
    await web.click(dialog.getByText("Ask me first"));
    await web.click(dialog.locator("label", { hasText: "catering-price-list.md" }));
    await web.type(dialog.getByLabel("Monthly token limit"), "100");
    await web.pause(600);
    await web.click(dialog.getByRole("button", { name: "Hire Quote Builder" }));
    await web.page.getByText("Quote Builder joined your team.").waitFor({ timeout: 20_000 });
    mark("hired");
    await web.pause(1500);

    /* 5 · Invoices */
    mark("scene 5 invoices");
    await web.page.goto(`${BASE}/workforce?agent=receipthero`);
    await web.redraw();
    const inbox = web.page.getByLabel("Drop invoices in your inbox");
    await web.page.getByText("Your invoice inbox").waitFor({ timeout: 30_000 });
    await web.point(web.page.getByText("Your invoice inbox"));
    await web.pause(600);
    await inbox.setInputFiles([`${FIX}/invoice-BD-5582.pdf`, `${FIX}/invoice-INV-21407.pdf`]);
    await web.page.getByText(/2 invoices dropped in your inbox/).waitFor({ timeout: 30_000 });
    mark("invoices dropped");
    const recent = web.page.locator("section", { has: web.page.getByRole("heading", { name: "Recent tasks" }) });
    await web.point(recent);

    /* 6 · Approve (Telegram, or the website's approval inbox) */
    if (tg) {
      const over = await tg.waitFor("overcharged by");
      mark("invoice draft in telegram");
      await tg.me.pause(1500);
      await tg.tap(over, "Approve");
      const clean = await tg.waitFor("no problems");
      await tg.tap(clean, "Approve");
      await tg.waitFor(/drafted a correction email/);
      mark("invoice approved in telegram");
    } else {
      await web.page.getByText(/overcharged by/).first().waitFor({ timeout: 180_000 });
      mark("invoice draft on website");
      await web.page.goto(`${BASE}/workforce`);
      await web.redraw();
      for (const button of ["Email supplier a correction", "File it"]) {
        await web.click(web.page.getByRole("button", { name: button }).first(), 2500);
      }
      mark("invoices approved on website");
    }
    await web.page.goto(`${BASE}/workforce?agent=receipthero`);
    await web.redraw();
    await web.pause(2500);

    if (tg) {
      /* 7 · VAT */
      mark("scene 7 vat");
      await tg.send("Can you get the VAT summary for October ready?");
      await tg.waitFor(/VAT to reclaim/);
      mark("vat posted");
      await tg.me.pause(2500);

      /* 8 · Quote + remember */
      mark("scene 8 quote");
      await tg.send(`Can you quote this? ${readFileSync(`${FIX}/catering-enquiry.txt`, "utf8")}`, { paste: true });
      const quote = await tg.waitFor(/Quote Q-.* ready/);
      mark("quote posted");
      await tg.me.point(quote);
      await tg.me.pause(2500);
      await tg.tap(quote, "Approve");
      await tg.waitFor(/draft in Gmail/);
      mark("quote approved");
      await tg.send("Remember that Brightwell Studio has a few vegans, always include vegan pastries for them.");
      await tg.waitFor(/Brightwell/);
      mark("remembered");
      await tg.me.pause(1500);

      /* 9 · Review */
      mark("scene 9 review");
      await tg.send(`We got this review, can you draft a reply? ${readFileSync(`${FIX}/google-review.txt`, "utf8")}`, { paste: true });
      const review = await tg.waitFor(/review needs attention|Reply ready/);
      mark("review draft posted");
      await tg.me.pause(3000);
      await tg.tap(review, "Edit");
      await tg.waitFor(/Send me the new text/);
      await tg.send("Sorry Tom, that's not the standard we hold ourselves to. Jordan now leaves 30 minutes earlier on Mondays and we've added a second oat milk supplier. Your next delivery's pastries are on us. Sam", { paste: true });
      await tg.waitFor(/Sent your version/);
      mark("review approved");
      await tg.me.pause(1500);
    }

    /* 10 · Rota */
    mark("scene 10 rota");
    await web.page.goto(`${BASE}/workforce?agent=rotabuilder`);
    await web.redraw();
    const staff = web.page.locator("#staffCsv");
    await staff.waitFor({ timeout: 30_000 });
    await web.paste(staff, readFileSync(`${FIX}/staff.csv`, "utf8"));
    await web.pause(800);
    await web.click(web.page.getByRole("button", { name: /Run now · 4 tokens/ }));
    await web.page.getByText(/Rota for \d{4}-\d{2}-\d{2} (is ready|has \d+ problems?)/).first().waitFor({ timeout: 180_000 });
    mark("rota ready");
    await web.pause(2500);
    await web.scroll(600);
    await web.pause(2000);

    /* 11 · Cost */
    mark("scene 11 cost");
    if (tg) {
      await tg.send("What did all that cost us this morning?");
      await tg.waitFor(/tokens/);
      mark("cost answered");
      await tg.me.pause(1500);
    }
    await web.page.goto(`${BASE}/workforce`);
    await web.redraw();
    await web.pause(1000);
    await web.point(web.page.locator("header").getByText(/tokens?/i).first()).catch(() => undefined);
    await web.pause(3000);
    mark("end");
  } catch (err) {
    mark(`FAILED: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    await web.page.screenshot({ path: `${OUT}/failed-web.png` });
    await tg?.page.screenshot({ path: `${OUT}/failed-telegram.png` });
    process.exitCode = 1;
  } finally {
    const end = Date.now() / 1000 - T0;
    await webCtx.close();
    await tgCtx?.close();
    await browser.close();
    writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks, null, 2));
    console.log("Encoding…");
    const webMp4 = webCam.encode(end);
    const parts = [webMp4];
    if (tgCam) parts.push(tgCam.encode(end));
    const raw = `${OUT}/raw.mp4`;
    if (parts.length === 2) {
      execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", parts[0], "-i", parts[1], "-filter_complex", "[0:v][1:v]hstack=inputs=2[v]", "-map", "[v]", "-c:v", "libx264", "-crf", "16", raw]);
    } else {
      execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", parts[0], "-vf", "pad=1920:1080:0:0:color=0x111111", "-c:v", "libx264", "-crf", "16", raw]);
    }
    console.log(`✓ ${raw} (${end.toFixed(0)} s), marks in ${OUT}/marks.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
