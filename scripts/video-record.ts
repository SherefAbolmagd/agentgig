/**
 * Records the demo video's raw take: agentgig.si (left, 1280×1080) and
 * Telegram Web (right, 640×1080) driven like a person would, with a visible
 * pointer. Frames come from Chrome's screencast at full quality; every step's
 * time goes to marks.json so the edit can cut waits and speed up agent runs.
 *
 *   VIDEO_PASSWORD=... FFMPEG=<path> npx tsx --conditions=react-server scripts/video-record.ts <out-dir> [telegram-profile-dir]
 *
 * Chrome runs in visible windows (on the second monitor by default) so the GPU
 * renders at 60 fps; HEADLESS=1 runs it hidden, at the cost of dropped frames.
 *
 * Without a Telegram profile it records the website alone and approves drafts
 * on the website, which is how the website half is tested.
 * Writes <out-dir>/web.mp4, telegram.mp4 (if any), raw.mp4 (side by side) and marks.json.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
/** Where the action is, for the edit's camera: pointer stops, clicks and new chat messages, in page pixels. */
type Focus = { t: number; page: "web" | "tg"; kind: "move" | "click" | "message"; x: number; y: number; w?: number; h?: number; text?: string };
const events: Focus[] = [];
const now = () => Date.now() / 1000 - T0;
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
    execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=60,scale=${this.w}:${this.h}:force_original_aspect_ratio=decrease,pad=${this.w}:${this.h}:(ow-iw)/2:0,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "16", out]);
    return out;
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a page's content sits on the real screen (Windows, 100% scaling). */
async function clientRect(page: Page): Promise<Rect> {
  return page.evaluate(() => {
    const border = (outerWidth - innerWidth) / 2;
    return { x: screenX + border, y: screenY + outerHeight - innerHeight - border, w: innerWidth, h: innerHeight };
  });
}

/**
 * Pins the recorder's own Chrome windows (Playwright's Chromium, never the
 * person's browser) always on top, so nothing else can slide into the
 * recorded area. Returns how many windows were pinned.
 */
function pinOnTop(): number {
  const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Pin { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags); }
"@
$n = 0
Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' -and $_.MainWindowHandle -ne 0 } | ForEach-Object {
  if ([Pin]::SetWindowPos($_.MainWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0013)) { $n++ }
}
$n`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  return Number(out.trim().split(/\s+/).pop());
}

/**
 * Records a region of the real screen at a constant 60 fps (gdigrab, encoded
 * on the graphics card): every frame the monitor showed, so motion is smooth.
 */
class ScreenCapture {
  private proc?: ChildProcess;
  /** Seconds after T0 when the first frame was taken. */
  startedAt = 0;
  constructor(private rect: Rect, private file: string) {}
  async start() {
    const { x, y, w, h } = this.rect;
    this.proc = spawn(FFMPEG, [
      "-y", "-f", "gdigrab", "-framerate", "60", "-draw_mouse", "0",
      "-offset_x", String(x), "-offset_y", String(y), "-video_size", `${w}x${h}`, "-i", "desktop",
      "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "17", "-pix_fmt", "yuv420p", this.file,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      let log = "";
      this.proc!.stderr!.on("data", (d: Buffer) => {
        log += d.toString();
        if (!this.startedAt && log.includes("Press [q]")) {
          this.startedAt = Date.now() / 1000 - T0;
          resolve();
        }
      });
      this.proc!.on("exit", (code) => reject(new Error(`Screen capture stopped (${code}): ${log.slice(-400)}`)));
    });
  }
  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const done = new Promise((r) => this.proc!.once("exit", r));
    this.proc.stdin!.write("q");
    await done;
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
  constructor(public page: Page, public name: "web" | "tg" = "web") {}
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
      await this.page.waitForTimeout(16); // one step per screen refresh
    }
    this.x = x;
    this.y = y;
    events.push({ t: now(), page: this.name, kind: "move", x, y });
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
    // The page may have moved while the pointer glided (a new chat message), so
    // the click itself goes to the element where it is now, not where it was.
    const box = await target.boundingBox().catch(() => null);
    if (box) [this.x, this.y] = [box.x + box.width / 2, box.y + box.height / 2];
    events.push({ t: now(), page: this.name, kind: "click", x: this.x, y: this.y });
    try {
      await target.click({ delay: 60, timeout: 3000 });
    } catch {
      // Covered by another element (a label over a radio): click where it is.
      await this.page.mouse.click(this.x, this.y, { delay: 60 });
    }
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
  /** Incoming messages (Ada and the agents), never Sam's own. */
  incoming(text: string | RegExp) {
    return this.page.locator(".bubble.is-in", { hasText: text });
  }
  async send(text: string, { paste = false } = {}) {
    await this.assertPrivate();
    if (paste) await this.me.paste(this.input(), text);
    else await this.me.type(this.input(), text);
    await this.me.pause(300);
    await this.page.keyboard.press("Enter");
  }
  /** Sends, then waits for a new incoming message containing `reply`, and returns it. */
  async ask(text: string, reply: string | RegExp, opts: { paste?: boolean } = {}) {
    const before = await this.incoming(reply).count();
    await this.send(text, opts);
    return this.waitFor(reply, before);
  }
  /** Waits until more than `before` incoming messages contain `text`; returns the newest. */
  async waitFor(text: string | RegExp, before = 0, timeout = 180_000) {
    const all = this.incoming(text);
    const deadline = Date.now() + timeout;
    while ((await all.count()) <= before) {
      if (Date.now() > deadline) throw new Error(`No new Telegram message matching ${text}`);
      await this.page.waitForTimeout(400);
    }
    const bubble = all.last();
    const box = await bubble.boundingBox().catch(() => null);
    if (box) events.push({ t: now(), page: "tg", kind: "message", x: box.x, y: box.y, w: box.width, h: box.height, text: (await bubble.innerText().catch(() => "")).slice(0, 80) });
    await bubble.scrollIntoViewIfNeeded().catch(() => undefined);
    // Let Ada's follow-up land too, so the next message doesn't cut in.
    await this.page.waitForTimeout(2500);
    return bubble;
  }
  async tap(bubble: Locator, button: string) {
    // The buttons sit just under the bubble, in the same message group.
    const group = bubble.locator("xpath=ancestor-or-self::*[contains(@class,'bubble')][1]");
    await this.me.click(group.locator(".reply-markup-button", { hasText: button }).first(), 800);
  }
  /** Opens the bot chat with an empty history, and makes sure no other chat is on screen. */
  async prepare() {
    await this.page.goto("https://web.telegram.org/k/#@AgentGigBot");
    await this.input().waitFor({ timeout: 60_000 });
    await this.page.waitForTimeout(4000);
    if (await this.page.locator(".bubble").count()) {
      await this.page.locator(".topbar button.btn-menu-toggle").filter({ visible: true }).first().click();
      await this.page.locator(".btn-menu-item", { hasText: "Clear history" }).filter({ visible: true }).click();
      await this.page.locator(".popup-button", { hasText: /Delete|Clear/i }).last().click();
      await this.page.waitForTimeout(2500);
    }
    await this.assertPrivate();
  }
  /** Stops the take if the chat list (other people's chats) could be on screen. */
  async assertPrivate() {
    const left = await this.page.locator("#column-left").boundingBox();
    if (left && left.x + left.width > 1) throw new Error("Telegram's chat list is visible; refusing to record it.");
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

  // Visible windows, so the graphics card renders them: headless software
  // rendering drops frames. They open on a second monitor if there is one
  // (VIDEO_WINDOW_X, default -1920) and Chrome is told not to slow them down
  // when they're covered or out of focus.
  // CAPTURE=screen (the default when windows are visible) records the monitor
  // itself; CAPTURE=cdp uses Chrome's screencast, which drops frames under load.
  const headless = process.env.HEADLESS === "1";
  const screen = !headless && process.env.CAPTURE !== "cdp";
  const winX = Number(process.env.VIDEO_WINDOW_X ?? -1920);
  const smooth = ["--hide-crash-restore-bubble", "--no-default-browser-check", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-features=CalculateNativeWinOcclusion"];
  // Side by side on one 1920×1080 monitor: 8 px invisible borders overlap; content is 1272 + 636 wide.
  const webWindow = screen ? [`--window-position=${winX - 8},0`, "--window-size=1288,1088"] : [`--window-position=${winX},0`, "--window-size=1300,1000"];
  const tgWindow = screen ? [`--window-position=${winX + 1264},0`, "--window-size=652,1088"] : [`--window-position=${winX + 1280},0`, "--window-size=660,1000"];
  const view = (width: number) => (screen ? { viewport: null } : { viewport: { width, height: 1080 }, deviceScaleFactor: 1 });
  // No "controlled by automated test software" bar: it takes 40 px of the page.
  const quiet = { ignoreDefaultArgs: ["--enable-automation"] };
  const browser = await chromium.launch({ headless, ...quiet, args: [...smooth, ...webWindow] });
  const webCtx = await browser.newContext({ ...view(1280), locale: "en-GB", timezoneId: "Europe/London" });
  const web = new Person(await webCtx.newPage());
  await web.setup();

  let tgCtx: BrowserContext | undefined;
  let tg: Telegram | undefined;
  if (TG_PROFILE) {
    tgCtx = await chromium.launchPersistentContext(TG_PROFILE, { headless, ...quiet, args: [...smooth, ...tgWindow], ...view(640), locale: "en-GB", timezoneId: "Europe/London" });
    const p = tgCtx.pages()[0] ?? (await tgCtx.newPage());
    tg = new Telegram(new Person(p, "tg"));
    await tg.me.setup();
    await tg.prepare();
    if (process.env.TG_PREP_ONLY === "1") {
      await p.screenshot({ path: `${OUT}/telegram-prepared.png` });
      console.log(`✓ Telegram prepared: ${OUT}/telegram-prepared.png`);
      await tgCtx.close();
      await browser.close();
      return;
    }
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

  // Screen mode: one recording of the area holding both pages, cropped apart later.
  let capture: ScreenCapture | undefined;
  let rects: Rect[] = [];
  if (screen) {
    await web.page.bringToFront();
    await tg?.page.bringToFront();
    const pinned = pinOnTop();
    if (pinned < (tg ? 2 : 1)) throw new Error(`Only ${pinned} recording window(s) could be kept on top; not recording the screen.`);
    await web.page.waitForTimeout(500);
    rects = [await clientRect(web.page), ...(tg ? [await clientRect(tg.page)] : [])];
    console.log("Pages on screen:", rects.map((r) => `${r.w}×${r.h} at ${r.x},${r.y}`).join(" | "));
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const even = (n: number) => n - (n % 2);
    const region = { x: x0, y: y0, w: even(Math.max(...rects.map((r) => r.x + r.w)) - x0), h: even(Math.max(...rects.map((r) => r.y + r.h)) - y0) };
    rects = rects.map((r) => ({ ...r, x: r.x - x0, y: r.y - y0 }));
    capture = new ScreenCapture(region, `${OUT}/screen.mp4`);
    await capture.start();
  }
  const webCam = screen ? undefined : new Screencast(web.page, "web", 1280, 1080);
  const tgCam = screen || !tg ? undefined : new Screencast(tg.page, "telegram", 640, 1080);
  await webCam?.start();
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
      const clean = await tg.waitFor("no problems");
      mark("invoice draft in telegram");
      await tg.me.point(over);
      await tg.me.pause(1500);
      await tg.tap(over, "Approve");
      await tg.waitFor(/drafted a correction email/);
      mark("overcharged invoice approved in telegram");
      await tg.tap(clean, "Approve");
      await tg.waitFor(/Logged to your spend sheet/, 1);
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
      await tg.ask("Can you get the VAT summary for October ready?", /VAT to reclaim/);
      mark("vat posted");
      await tg.me.pause(2500);

      /* 8 · Quote + remember */
      mark("scene 8 quote");
      const quote = await tg.ask(`Can you quote this? ${readFileSync(`${FIX}/catering-enquiry.txt`, "utf8")}`, /Quote Q-.* ready/, { paste: true });
      mark("quote posted");
      await tg.me.point(quote);
      await tg.me.pause(2500);
      await tg.tap(quote, "Approve");
      await tg.waitFor(/draft in Gmail/);
      mark("quote approved");
      await tg.ask("Remember that Brightwell Studio has a few vegans, always include vegan pastries for them.", /saved|noted|remember/i);
      mark("remembered");
      await tg.me.pause(1500);

      /* 9 · Review */
      mark("scene 9 review");
      const review = await tg.ask(`We got this review, can you draft a reply? ${readFileSync(`${FIX}/google-review.txt`, "utf8")}`, /review needs attention|Reply ready/, { paste: true });
      mark("review draft posted");
      await tg.me.point(review);
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
      await tg.ask("What did all that cost us today?", /tokens/);
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
    await capture?.stop();
    await webCtx.close();
    await tgCtx?.close();
    await browser.close();
    // Marks are relative to the recording's first frame.
    const shift = capture?.startedAt ?? 0;
    writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks.map((m) => ({ ...m, t: m.t - shift })), null, 2));
    writeFileSync(`${OUT}/events.json`, JSON.stringify(events.map((e) => ({ ...e, t: e.t - shift })), null, 2));
    // The page crops inside raw.mp4's source, for the edit to cut them out separately.
    if (capture) writeFileSync(`${OUT}/layout.json`, JSON.stringify({ pages: rects }, null, 2));
    console.log("Encoding…");
    const raw = `${OUT}/raw.mp4`;

    if (capture) {
      // Both pages cropped out at the same height and centred on a 1920×1080 frame.
      const even = (n: number) => n - (n % 2);
      const h = even(Math.min(...rects.map((r) => r.h)));
      const crops = rects.map((r, i) => `[0:v]crop=${even(r.w)}:${h}:${r.x}:${r.y}[c${i}]`).join(";");
      const stack = rects.length === 2 ? "[c0][c1]hstack=inputs=2[s]" : "[c0]null[s]";
      execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", `${OUT}/screen.mp4`, "-filter_complex", `${crops};${stack};[s]pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0e1412,fps=60[v]`, "-map", "[v]", "-c:v", "h264_nvenc", "-preset", "p6", "-rc", "vbr", "-cq", "17", "-pix_fmt", "yuv420p", raw]);
    } else {
      const parts = [webCam!.encode(end), ...(tgCam ? [tgCam.encode(end)] : [])];
      const layout = parts.length === 2 ? ["-filter_complex", "[0:v][1:v]hstack=inputs=2[v]", "-map", "[v]"] : ["-vf", "pad=1920:1080:0:0:color=0x111111"];
      execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...parts.flatMap((p) => ["-i", p]), ...layout, "-c:v", "libx264", "-crf", "16", raw]);
    }
    console.log(`✓ ${raw} (${end.toFixed(0)} s), marks in ${OUT}/marks.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
