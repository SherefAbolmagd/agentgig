/**
 * Shared kit for recording demo-video takes (scripts/video-record*.ts):
 * agentgig.si (left) and Telegram Web (right) side by side on the second
 * monitor, driven like a person would with a visible pointer, recorded from the
 * real screen at 60 fps. Every step's time goes to marks.json and every click,
 * new chat message or deliberate "look at this" to events.json, for the edit's
 * camera (video/prepare.ts).
 *
 * Env: VIDEO_PASSWORD (video account), FFMPEG, VIDEO_BASE, VIDEO_WINDOW_X,
 * HEADLESS=1 / CAPTURE=cdp (Chrome screencast instead of the screen; drops frames).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

export const BASE = process.env.VIDEO_BASE ?? "https://agentgig.si";
export const FIX = "fixtures/video";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

/** The take's clock, marks and camera events. */
class Take {
  readonly t0 = Date.now() / 1000;
  readonly marks: { t: number; label: string }[] = [];
  readonly events: Focus[] = [];
  constructor(readonly out: string) {
    mkdirSync(out, { recursive: true });
  }
  now() {
    return Date.now() / 1000 - this.t0;
  }
  mark(label: string) {
    const t = this.now();
    this.marks.push({ t, label });
    console.log(`${t.toFixed(1).padStart(6)} s  ${label}`);
  }
}

/** Where the action is, in page pixels: pointer stops, clicks, new chat messages and things shown on purpose. */
export type Focus = { t: number; page: "web" | "tg"; kind: "move" | "click" | "message" | "focus"; x: number; y: number; w?: number; h?: number; text?: string };

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

class Screencast {
  frames: { file: string; t: number }[] = [];
  private n = 0;
  constructor(private take: Take, private page: Page, private name: string, private w: number, private h: number) {
    mkdirSync(`${take.out}/${name}`, { recursive: true });
  }
  async start() {
    const cdp = await this.page.context().newCDPSession(this.page);
    cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      const file = `${this.take.out}/${this.name}/${String(++this.n).padStart(6, "0")}.jpg`;
      writeFileSync(file, Buffer.from(data, "base64"));
      this.frames.push({ file, t: (metadata.timestamp ?? Date.now() / 1000) - this.take.t0 });
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
    const list = `${this.take.out}/${this.name}/frames.txt`;
    writeFileSync(list, lines.join("\n"));
    const out = `${this.take.out}/${this.name}.mp4`;
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
 * Pins the recorder's own browser windows always on top, so nothing else can
 * slide into the recorded area: Playwright's Chromium, and Edge only when it
 * runs on one of the recording profiles (never the person's own browser).
 * Returns how many windows were pinned.
 */
function pinOnTop(profiles: string[] = []): number {
  const match = profiles.map((d) => `$_.CommandLine -like '*${d.replace(/[\\/]/g, "*")}*'`).join(" -or ") || "$false";
  const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Pin { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags); }
"@
$n = 0
$ids = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -and $_.ExecutablePath -like '*ms-playwright*') -or ($_.Name -eq 'msedge.exe' -and (${match})) } | ForEach-Object { $_.ProcessId }
Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
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
  constructor(private take: Take, private rect: Rect, private file: string) {}
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
          this.startedAt = this.take.now();
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

export class Person {
  x = 640;
  y = 540;
  constructor(private take: Take, public page: Page, public name: "web" | "tg" = "web") {}
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
    this.take.events.push({ t: this.take.now(), page: this.name, kind: "move", x, y });
  }
  async point(target: Locator) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("Can't see the element to point at");
    await this.moveTo(box.x + box.width / 2, box.y + box.height / 2);
  }
  /** Points at something and tells the camera to frame it: a result, a panel, a card. */
  async show(target: Locator, hold = 2000) {
    await target.waitFor({ state: "visible", timeout: 60_000 });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (box) this.take.events.push({ t: this.take.now(), page: this.name, kind: "focus", x: box.x, y: box.y, w: box.width, h: Math.min(box.height, 900) });
    await this.point(target).catch(() => undefined);
    await this.pause(hold);
  }
  async click(target: Locator, after = 500) {
    await target.waitFor({ state: "visible", timeout: 30_000 });
    await this.point(target);
    await this.pause(220);
    // The page may have moved while the pointer glided (a new chat message), so
    // the click itself goes to the element where it is now, not where it was.
    const box = await target.boundingBox().catch(() => null);
    if (box) [this.x, this.y] = [box.x + box.width / 2, box.y + box.height / 2];
    this.take.events.push({ t: this.take.now(), page: this.name, kind: "click", x: this.x, y: this.y });
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
  async go(path: string) {
    await this.page.goto(`${BASE}${path}`);
    await this.redraw();
  }
  /**
   * A short look at the real result somewhere else (a Gmail draft, the Drive
   * folder, the spend sheet), then back to where we were. `ready` is what must
   * be on screen before the camera holds on it.
   */
  async glance(url: string, ready: (p: Page) => Locator, hold = 3000) {
    const back = this.page.url();
    await this.page.goto(url);
    await this.redraw();
    await this.show(ready(this.page), hold);
    await this.page.goto(back);
    await this.redraw();
  }
}

/* ------------------------------------------------------------------ */
/* Telegram Web (K)                                                    */
/* ------------------------------------------------------------------ */

export class Telegram {
  constructor(private take: Take, public me: Person) {}
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
  /**
   * Records a voice note from the fake microphone (the take's micFile, which
   * Chrome plays as if spoken) and sends it. `seconds` is how long the line runs.
   */
  async voice(seconds: number) {
    await this.assertPrivate();
    const mic = this.page.locator("button.btn-send.record").first();
    await this.me.click(mic, 0);
    await this.page.waitForTimeout(seconds * 1000 + 600);
    await this.me.click(this.page.locator("button.btn-send").first(), 300);
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
    if (box) this.take.events.push({ t: this.take.now(), page: "tg", kind: "message", x: box.x, y: box.y, w: box.width, h: box.height, text: (await bubble.innerText().catch(() => "")).slice(0, 80) });
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
/* The stage                                                           */
/* ------------------------------------------------------------------ */

export interface Stage {
  take: Take;
  web: Person;
  tg?: Telegram;
  mark: (label: string) => void;
  /** Runs the scenes, then stops recording and writes raw.mp4, marks.json, events.json and layout.json. */
  run: (scenes: () => Promise<void>) => Promise<void>;
}

/**
 * Resets the video account, opens both windows, signs in, starts recording.
 * `micFile` (a WAV) is what Telegram Web hears through the fake microphone.
 */
export async function openStage(opts: { out: string; tgProfile?: string; micFile?: string; googleProfile?: string }): Promise<Stage> {
  const take = new Take(opts.out);
  const password = process.env.VIDEO_PASSWORD;
  if (!password) throw new Error("Set VIDEO_PASSWORD to the video account's password.");
  const { resetVideoAccount, VIDEO } = await import("./video-reset");
  console.log("Resetting the video account…");
  await resetVideoAccount();

  // Visible windows, so the graphics card renders them, side by side on the second
  // monitor (VIDEO_WINDOW_X, default -1920); Chrome must not slow them down when covered.
  const headless = process.env.HEADLESS === "1";
  const screen = !headless && process.env.CAPTURE !== "cdp";
  const winX = Number(process.env.VIDEO_WINDOW_X ?? -1920);
  const smooth = ["--hide-crash-restore-bubble", "--no-default-browser-check", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-features=CalculateNativeWinOcclusion"];
  // 8 px invisible borders overlap; content is 1272 + 636 wide.
  const webWindow = screen ? [`--window-position=${winX - 8},0`, "--window-size=1288,1088"] : [`--window-position=${winX},0`, "--window-size=1300,1000"];
  const tgWindow = screen ? [`--window-position=${winX + 1264},0`, "--window-size=652,1088"] : [`--window-position=${winX + 1280},0`, "--window-size=660,1000"];
  const view = (width: number) => (screen ? { viewport: null } : { viewport: { width, height: 1080 }, deviceScaleFactor: 1 });
  const mic = opts.micFile ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${opts.micFile}%noloop`] : [];
  // No "controlled by automated test software" bar: it takes 40 px of the page.
  const quiet = { ignoreDefaultArgs: ["--enable-automation"] };
  // With a Google profile the website window is Edge signed in to Google (Google refuses
  // sign-ins from Playwright's Chromium), so the take can glance at Gmail, Drive and Sheets.
  const browser: Browser | undefined = opts.googleProfile ? undefined : await chromium.launch({ headless, ...quiet, args: [...smooth, ...webWindow] });
  const webCtx = opts.googleProfile
    ? await chromium.launchPersistentContext(opts.googleProfile, { channel: "msedge", headless, ...quiet, args: [...smooth, ...webWindow, "--no-first-run"], ...view(1280), locale: "en-GB", timezoneId: "Europe/London" })
    : await browser!.newContext({ ...view(1280), locale: "en-GB", timezoneId: "Europe/London" });
  const web = new Person(take, webCtx.pages()[0] ?? (await webCtx.newPage()));
  await web.setup();

  let tgCtx: BrowserContext | undefined;
  let tg: Telegram | undefined;
  if (opts.tgProfile) {
    tgCtx = await chromium.launchPersistentContext(opts.tgProfile, { headless, ...quiet, args: [...smooth, ...tgWindow, ...mic], ...view(640), locale: "en-GB", timezoneId: "Europe/London" });
    if (opts.micFile) await tgCtx.grantPermissions(["microphone"], { origin: "https://web.telegram.org" });
    const p = tgCtx.pages()[0] ?? (await tgCtx.newPage());
    tg = new Telegram(take, new Person(take, p, "tg"));
    await tg.me.setup();
    await tg.prepare();
  }

  // Signed in before the camera rolls (a kept profile may already be).
  await web.page.goto(`${BASE}/workforce`);
  const home = web.page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ });
  const email = web.page.getByLabel("Email");
  await Promise.race([home.waitFor({ timeout: 30_000 }), email.waitFor({ timeout: 30_000 })]);
  if (!(await home.isVisible())) {
    if ((await web.page.getByRole("button", { name: "Sign in", exact: true }).count()) === 0) {
      await web.page.getByRole("button", { name: "Sign in" }).last().click();
    }
    await email.fill(VIDEO.email);
    await web.page.getByLabel("Password").fill(password);
    await web.page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await home.waitFor({ timeout: 30_000 });
  await web.page.waitForTimeout(1500);

  // Screen mode: one recording of the area holding both pages, cropped apart later.
  let capture: ScreenCapture | undefined;
  let rects: Rect[] = [];
  const even = (n: number) => n - (n % 2);
  if (screen) {
    await web.page.bringToFront();
    await tg?.page.bringToFront();
    const pinned = pinOnTop([opts.googleProfile, opts.tgProfile].filter((d): d is string => !!d));
    if (pinned < (tg ? 2 : 1)) throw new Error(`Only ${pinned} recording window(s) could be kept on top; not recording the screen.`);
    await web.page.waitForTimeout(500);
    rects = [await clientRect(web.page), ...(tg ? [await clientRect(tg.page)] : [])];
    console.log("Pages on screen:", rects.map((r) => `${r.w}×${r.h} at ${r.x},${r.y}`).join(" | "));
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const region = { x: x0, y: y0, w: even(Math.max(...rects.map((r) => r.x + r.w)) - x0), h: even(Math.max(...rects.map((r) => r.y + r.h)) - y0) };
    rects = rects.map((r) => ({ ...r, x: r.x - x0, y: r.y - y0 }));
    capture = new ScreenCapture(take, region, `${take.out}/screen.mp4`);
    await capture.start();
  }
  const webCam = screen ? undefined : new Screencast(take, web.page, "web", 1280, 1080);
  const tgCam = screen || !tg ? undefined : new Screencast(take, tg.page, "telegram", 640, 1080);
  await webCam?.start();
  await tgCam?.start();
  await web.redraw();
  await tg?.me.redraw();

  return {
    take,
    web,
    tg,
    mark: (l) => take.mark(l),
    async run(scenes) {
      take.mark("start");
      try {
        await scenes();
        take.mark("end");
      } catch (err) {
        take.mark(`FAILED: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        await web.page.screenshot({ path: `${take.out}/failed-web.png` }).catch(() => undefined);
        await tg?.page.screenshot({ path: `${take.out}/failed-telegram.png` }).catch(() => undefined);
        process.exitCode = 1;
      } finally {
        const end = take.now();
        await capture?.stop();
        await webCtx.close();
        await tgCtx?.close();
        await browser?.close();
        // Times are relative to the recording's first frame.
        const shift = capture?.startedAt ?? 0;
        writeFileSync(`${take.out}/marks.json`, JSON.stringify(take.marks.map((m) => ({ ...m, t: m.t - shift })), null, 2));
        writeFileSync(`${take.out}/events.json`, JSON.stringify(take.events.map((e) => ({ ...e, t: e.t - shift })), null, 2));
        if (capture) writeFileSync(`${take.out}/layout.json`, JSON.stringify({ pages: rects }, null, 2));
        console.log("Encoding…");
        const raw = `${take.out}/raw.mp4`;
        if (capture) {
          // A preview of both pages side by side; the edit crops screen.mp4 itself.
          const h = even(Math.min(...rects.map((r) => r.h)));
          const crops = rects.map((r, i) => `[0:v]crop=${even(r.w)}:${h}:${r.x}:${r.y}[c${i}]`).join(";");
          const stack = rects.length === 2 ? "[c0][c1]hstack=inputs=2[s]" : "[c0]null[s]";
          execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", `${take.out}/screen.mp4`, "-filter_complex", `${crops};${stack};[s]pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0e1412,fps=60[v]`, "-map", "[v]", "-c:v", "h264_nvenc", "-preset", "p6", "-rc", "vbr", "-cq", "17", "-pix_fmt", "yuv420p", raw]);
        } else {
          const parts = [webCam!.encode(end), ...(tgCam ? [tgCam.encode(end)] : [])];
          const layout = parts.length === 2 ? ["-filter_complex", "[0:v][1:v]hstack=inputs=2[v]", "-map", "[v]"] : ["-vf", "pad=1920:1080:0:0:color=0x111111"];
          execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...parts.flatMap((p) => ["-i", p]), ...layout, "-c:v", "libx264", "-crf", "16", raw]);
        }
        console.log(`✓ ${raw} (${end.toFixed(0)} s), marks in ${take.out}/marks.json`);
      }
    },
  };
}
