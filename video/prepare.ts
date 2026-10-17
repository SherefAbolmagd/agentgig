/**
 * Turns a recorded take into the inputs of the Remotion composition:
 *   public/take/web.mp4, tg.mp4     the two pages cropped out of the screen recording
 *   public/audio/…                  narration, a joined music bed, ping/tap/whoosh effects
 *   src/timeline.json               every segment, caption, callout, sound and camera event, in seconds
 *
 *   FFMPEG=<path> npx tsx video/prepare.ts <take-dir> <voice-dir> <music-dir>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const [TAKE, VOICE, MUSIC] = process.argv.slice(2);
if (!MUSIC) throw new Error("Usage: prepare.ts <take-dir> <voice-dir> <music-dir>");
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const ROOT = "video";
const ff = (args: string[]) => execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
mkdirSync(`${ROOT}/public/take`, { recursive: true });
mkdirSync(`${ROOT}/public/audio/voice`, { recursive: true });

const MAX_TOTAL = 232; // seconds; the rules allow 4:00
const LEAD = 0.4;
const TAIL = 1.0;

type Mark = { t: number; label: string };
type Ev = { t: number; page: "web" | "tg"; kind: "move" | "click" | "message"; x: number; y: number; w?: number; h?: number; text?: string };
const marks = JSON.parse(readFileSync(`${TAKE}/marks.json`, "utf8")) as Mark[];
const events = JSON.parse(readFileSync(`${TAKE}/events.json`, "utf8")) as Ev[];
const layout = JSON.parse(readFileSync(`${TAKE}/layout.json`, "utf8")) as { pages: { x: number; y: number; w: number; h: number }[] };
const narration = JSON.parse(readFileSync("fixtures/video/narration.json", "utf8")) as Record<string, string>;
const at = (label: string) => {
  const m = marks.find((x) => x.label === label);
  if (!m) throw new Error(`No mark "${label}"`);
  return m.t;
};
const wavSeconds = (file: string) => (statSync(file).size - 44) / (48000 * 2 * (file.includes("music") ? 2 : 1));

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

const even = (n: number) => n - (n % 2);
const [webRect, tgRect] = layout.pages;
for (const [name, r] of [["web", webRect], ["tg", tgRect]] as const) {
  ff(["-i", `${TAKE}/screen.mp4`, "-vf", `crop=${even(r.w)}:${even(r.h)}:${r.x}:${r.y}`, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-g", "30", "-pix_fmt", "yuv420p", "-an", `${ROOT}/public/take/${name}.mp4`]);
}
// 7% quicker than Gemini reads it: still natural, and it keeps the video under four minutes.
for (const key of Object.keys(narration)) ff(["-i", `${VOICE}/${key}.wav`, "-af", "atempo=1.07", "-ar", "48000", "-ac", "1", `${ROOT}/public/audio/voice/${key}.wav`]);

// Music: Lyria's 30 s clips joined with 3 s crossfades into one long bed.
const clips = readdirSync(MUSIC).filter((f) => f.endsWith(".wav")).sort();
const inputs = clips.flatMap((f) => ["-i", `${MUSIC}/${f}`]);
let chain = "[0:a]";
const filters: string[] = [];
for (let i = 1; i < clips.length; i++) {
  const out = i === clips.length - 1 ? "[m]" : `[x${i}]`;
  filters.push(`${chain}[${i}:a]acrossfade=d=3:c1=tri:c2=tri${out}`);
  chain = out;
}
ff([...inputs, "-filter_complex", filters.join(";"), "-map", "[m]", "-ar", "48000", `${ROOT}/public/audio/music.wav`]);

// Effects: a two-note ping for a new message, a soft tap, a filtered-noise whoosh.
ff(["-f", "lavfi", "-i", "sine=f=1318:d=0.09", "-f", "lavfi", "-i", "sine=f=1760:d=0.22", "-filter_complex", "[0:a]afade=t=out:st=0.03:d=0.06[a];[1:a]adelay=80,afade=t=out:st=0.1:d=0.2[b];[a][b]amix=inputs=2:normalize=0,volume=0.5", "-ar", "48000", `${ROOT}/public/audio/ping.wav`]);
ff(["-f", "lavfi", "-i", "anoisesrc=d=0.05:c=white:a=0.6", "-af", "highpass=f=1800,lowpass=f=6000,afade=t=out:st=0.005:d=0.045", "-ar", "48000", `${ROOT}/public/audio/tap.wav`]);
ff(["-f", "lavfi", "-i", "anoisesrc=d=0.7:c=pink:a=0.5", "-af", "bandpass=f=900:w=1200,afade=t=in:d=0.3,afade=t=out:st=0.35:d=0.35,volume=0.7", "-ar", "48000", `${ROOT}/public/audio/whoosh.wav`]);

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

type Piece = { from: number; to: number; speed: number; wait?: boolean; hold?: number };
type Segment =
  | { kind: "cold" | "scene"; key?: string; start: number; dur: number; pieces: (Piece & { outStart: number; outDur: number })[] }
  | { kind: "title" | "arch" | "stats" | "end"; key?: string; start: number; dur: number };

const voiceLen = (key: string) => wavSeconds(`${ROOT}/public/audio/voice/${key}.wav`);
const p = (from: number, to: number, speed = 1, wait = false): Piece => ({ from, to, speed, wait });
const w = (from: number, to: number) => p(from, to, 1, true);

// Cold open: "where's my order?", answered from Sam's phone.
const has = (label: string) => marks.some((m) => m.label === label);
const cold: Piece[] = [p(at("cold"), at("cold") + 3), w(at("cold") + 3, at("cold draft") - 0.8), p(at("cold draft") - 0.8, at("scene 3 home"))];

/** The next scene's start after `label` (scene 5 is only there when Stripe is connected). */
const nextScene = (after: string) => marks.find((m) => /^scene \d+/.test(m.label) && m.t > at(after))?.t ?? at("end");

const scenes: { key: string; pieces: Piece[] }[] = [
  { key: "03", pieces: [p(at("scene 3 home"), at("scene 4 stock"))] },
  { key: "04", pieces: [p(at("scene 4 stock"), at("scene 4 stock") + 4), w(at("scene 4 stock") + 4, at("stock ready") - 0.8), p(at("stock ready") - 0.8, nextScene("scene 4 stock"))] },
  ...(has("scene 5 revenue")
    ? [{ key: "05", pieces: [p(at("scene 5 revenue"), at("voice sent") + 1), w(at("voice sent") + 1, at("revenue posted") - 0.8), p(at("revenue posted") - 0.8, at("scene 6 hire"))] }]
    : []),
  { key: "06", pieces: [p(at("scene 6 hire"), at("scene 7 winback"))] },
  { key: "07", pieces: [p(at("scene 7 winback"), at("scene 7 winback") + 3), w(at("scene 7 winback") + 3, at("winback ready") - 0.8), p(at("winback ready") - 0.8, at("scene 8 quote"))] },
  { key: "08", pieces: [p(at("scene 8 quote"), at("scene 8 quote") + 3), w(at("scene 8 quote") + 3, at("quote posted") - 0.8), p(at("quote posted") - 0.8, at("scene 9 drive"))] },
  {
    key: "09",
    // The 5-minute Drive check is skipped: the glance at the folder runs into the check.
    pieces: [p(at("scene 9 drive"), at("drive checked")), w(at("drive checked"), at("invoice draft") - 0.8), p(at("invoice draft") - 0.8, at("scene 10 memory"))],
  },
  { key: "10", pieces: [p(at("scene 10 memory"), at("fact approved") + 3), w(at("fact approved") + 3, at("memory answered") - 0.8), p(at("memory answered") - 0.8, at("scene 11 team"))] },
  { key: "11", pieces: [p(at("scene 11 team"), at("scene 12 developers"))] },
  { key: "12", pieces: [p(at("scene 12 developers"), at("scene 12 developers") + 5), w(at("scene 12 developers") + 5, at("partner listed") - 0.8), p(at("partner listed") - 0.8, at("scene 13 cost"))] },
  { key: "13", pieces: [p(at("scene 13 cost"), at("scene 13 cost") + 3), w(at("scene 13 cost") + 3, at("cost answered") - 0.8), p(at("cost answered") - 0.8, at("end"))] },
];

const piecesLen = (ps: Piece[], waitSpeed: number) => ps.reduce((n, x) => n + (x.to - x.from) / (x.wait ? waitSpeed : x.speed), 0);
const sceneLen = (sc: { key: string; pieces: Piece[] }, waitSpeed: number) => Math.max(piecesLen(sc.pieces, waitSpeed), voiceLen(sc.key) + LEAD + TAIL);
const TITLE = voiceLen("01") + LEAD + 1.0;
const ARCH = voiceLen("14") + LEAD + 0.6;
const STATS = 3.8;
const END = 4.0;
const fixed = TITLE + ARCH + STATS + END;
const waitSpeed = [1, 1.5, 2, 3, 4, 6].find((s) => fixed + piecesLen(cold, s) + scenes.reduce((n, sc) => n + sceneLen(sc, s), 0) <= MAX_TOTAL) ?? 6;

const segments: Segment[] = [];
let t = 0;
const place = (kind: "cold" | "scene", key: string | undefined, ps: Piece[], minDur = 0) => {
  const start = t;
  const out: (Piece & { outStart: number; outDur: number })[] = [];
  for (const x of ps) {
    const speed = x.wait ? waitSpeed : x.speed;
    const outDur = (x.to - x.from) / speed;
    out.push({ ...x, speed, outStart: t, outDur });
    t += outDur;
  }
  // Hold the last frame while the narration finishes.
  if (t - start < minDur) {
    const last = out[out.length - 1];
    out.push({ from: last.to, to: last.to, speed: 1, hold: minDur - (t - start), outStart: t, outDur: minDur - (t - start) });
    t = start + minDur;
  }
  segments.push({ kind, key, start, dur: t - start, pieces: out });
};
place("scene", undefined, cold);
segments.push({ kind: "title", key: "01", start: t, dur: TITLE });
t += TITLE;
for (const sc of scenes) place("scene", sc.key, sc.pieces, voiceLen(sc.key) + LEAD + TAIL);
segments.push({ kind: "arch", key: "14", start: t, dur: ARCH });
t += ARCH;
segments.push({ kind: "stats", start: t, dur: STATS });
t += STATS;
segments.push({ kind: "end", start: t, dur: END });
t += END;
const total = t;

// Held frames are stills: a video frozen on its last frame renders blank in Remotion.
let holds = 0;
for (const seg of segments) {
  if (!("pieces" in seg)) continue;
  for (const x of seg.pieces) {
    if (!x.hold) continue;
    const n = holds++;
    for (const page of ["web", "tg"]) ff(["-ss", Math.max(0, x.to - 1 / 60).toFixed(3), "-i", `${ROOT}/public/take/${page}.mp4`, "-frames:v", "1", "-q:v", "2", `${ROOT}/public/take/hold-${n}-${page}.jpg`]);
    (x as Piece & { still?: number }).still = n;
  }
}

/** Every output time showing a moment of the take (the cold open repeats some). */
const toOutAll = (src: number): number[] =>
  segments.flatMap((s) => ("pieces" in s ? s.pieces.filter((x) => !x.hold && src >= x.from && src < x.to).map((x) => x.outStart + (src - x.from) / x.speed) : []));
/** When a moment of the take appears in the story's scenes, if it does. */
const toOut = (src: number): number | null => toOutAll(src).filter((o) => o >= (segments.find((s) => s.kind === "scene" && s.key)?.start ?? 0)).shift() ?? null;

const sceneStart = (key: string) => segments.find((s) => s.key === key)!.start;
const voice = segments.filter((s) => s.key).map((s) => ({ key: s.key!, start: s.start + LEAD, dur: voiceLen(s.key!) }));

const captions = voice.flatMap(({ key, start, dur }) => {
  const sentences = narration[key].match(/[^.!?:]+[.!?:]+/g)?.map((x) => x.trim()) ?? [narration[key]];
  const chars = sentences.reduce((n, x) => n + x.length, 0);
  let c = start;
  return sentences.map((text) => {
    const d = (text.length / chars) * dur;
    const cue = { start: c, end: c + d - 0.05, text };
    c += d;
    return cue;
  });
});

const callout = (outT: number | null, text: string, sub?: string) => (outT === null ? [] : [{ start: outT, end: outT + 3.4, text, sub }]);
const callouts = [
  ...callout(toOutAll(at("cold") + 1)[0] ?? null, "A customer emails: where's my order?", "It lands in Gmail. Nobody forwards it"),
  ...callout(toOutAll(at("cold draft"))[0] ?? null, "Order Desk picked it up by itself", "Found in Shopify · reply drafted in the thread"),
  ...callout(sceneStart("03") + 1.5, "One team for the whole shop", "Orders · stock · money · customers"),
  ...callout(sceneStart("04") + 1.2, "Runs by itself every morning", "Started by hand for the demo"),
  ...callout(toOut(at("stock ready")), "Two products running low", "Reorder email drafted"),
  ...callout(toOut(at("drafts shown")), "Waiting in Gmail", "Nothing is sent without Sam"),
  ...(has("revenue posted") ? callout(toOut(at("revenue posted")), "This week's takings from Stripe", "And one declined card") : []),
  ...callout(sceneStart("06") + 1.5, "Hired in seconds", "Works in Sam's Shopify · 30-token monthly cap"),
  ...callout(toOut(at("winback ready")), "4 customers to win back", "Only those who opted in to emails"),
  ...callout(toOut(at("quote email")), "A wholesale enquiry by email", "Quote Builder picks it up from the inbox"),
  ...callout(toOut(at("quote posted")), "Priced from Sam's own list", "Volume discounts applied"),
  ...callout(toOut(at("drive upload")), "Lands in Google Drive", "The folder is checked every 5 minutes"),
  ...callout(toOut(at("invoice draft")), "£22.00 overcharge caught", "Gemini reads it · code checks the sums"),
  ...callout(toOut(at("fact approved")), "Memory with a human check", "Customer and money facts need an OK"),
  ...callout(toOut(at("invite created")), "Roles for the whole team", "Managers approve · the owner pays"),
  ...callout(toOut(at("partner listed")), "Five live checks, then listed", "Partners earn 80% of the tokens"),
  ...callout(toOut(at("cost answered")), "Charged only for finished work", "Failed tasks are free"),
];

/* ------------------------------------------------------------------ */
/* Camera: planned shots, like an editor would cut a screen recording  */
/* ------------------------------------------------------------------ */

// Stage layout, shared with src/Demo.tsx (the website window and the phone).
const STAGE = { web: { x: 56, y: 108, s: 0.86 }, tg: { x: 1222 + 14, y: 112 + 14, s: 0.84 }, box: { left: 30, top: 50, right: 1890, bottom: 975 } };
type Rect = { x: number; y: number; w: number; h: number };
type View = { t: number; cx: number; cy: number; w: number };
const OVERVIEW = { cx: 960, cy: 540, w: 1920 };

/** Where something in a page sits on the stage, in pixels. */
function toStage(e: Ev): Rect {
  const st = STAGE[e.page];
  if (e.w && e.h) return { x: st.x + e.x * st.s, y: st.y + e.y * st.s, w: e.w * st.s, h: e.h * st.s };
  // A click: frame the area around it.
  const w = e.page === "web" ? 520 : 380;
  const h = e.page === "web" ? 300 : 240;
  return { x: st.x + e.x * st.s - w / 2, y: st.y + e.y * st.s - h / 2, w, h };
}
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
/** Steady zoom levels read as deliberate camera work; the phone's text is smaller, so it gets a closer shot. */
const LEVEL = { web: 1.5, tg: 1.75 };

/** The view (centre and width; 16:9) that frames a rectangle with some air, or null if a zoom isn't worth it. */
function frame(r: Rect & { level?: number }): Omit<View, "t"> | null {
  const z = Math.min(r.level ?? 1.5, 1920 / (r.w * 1.18), 1080 / (r.h * 1.3));
  if (z < 1.25) return null;
  const w = 1920 / z;
  const h = w * (9 / 16);
  const { box } = STAGE;
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
  return { cx: clamp(r.x + r.w / 2, box.left + w / 2, box.right - w / 2), cy: clamp(r.y + r.h / 2, box.top + h / 2, box.bottom - h / 2), w };
}

const MOVE = 0.9; // seconds per camera move
const HOLD = 2.4; // how long a shot stays after its last moment
const GROUP = 2.0; // moments closer than this share a shot
const DIRECT = 3.0; // shots closer than this pan straight across instead of pulling out and back in
const OPEN = 1.0; // every scene starts wide for at least this long

/** Keyframes for one scene, in seconds from the scene's start. */
function sceneCamera(seg: Extract<Segment, { kind: "cold" | "scene" }>): View[] {
  const moments = events
    .filter((e) => e.kind !== "move")
    .flatMap((e) => toOutAll(e.t).filter((o) => o >= seg.start && o < seg.start + seg.dur).map((o) => ({ t: o - seg.start, rect: { ...toStage(e), level: LEVEL[e.page] } })))
    .sort((a, b) => a.t - b.t);
  const shots: { start: number; end: number; rect: Rect & { level: number } }[] = [];
  for (const m of moments) {
    const last = shots[shots.length - 1];
    if (last && m.t - last.end + HOLD < GROUP && frame(union(last.rect, m.rect))) {
      last.rect = { ...union(last.rect, m.rect), level: Math.min(last.rect.level, m.rect.level) };
      last.end = m.t + HOLD;
    } else shots.push({ start: m.t, end: m.t + HOLD, rect: m.rect });
  }
  const keys: View[] = [{ t: 0, ...OVERVIEW }];
  let at = OVERVIEW as Omit<View, "t">;
  for (let i = 0; i < shots.length; i++) {
    const v = frame(shots[i].rect);
    if (!v) continue;
    const arrive = Math.max(shots[i].start - 0.15, keys[keys.length - 1].t + MOVE, OPEN + MOVE);
    keys.push({ t: arrive - MOVE, ...at }, { t: arrive, ...v });
    at = v;
    const next = shots[i + 1];
    const leave = Math.min(shots[i].end, seg.dur - MOVE);
    // Pan straight to the next shot when it's close; otherwise ease back to the whole stage.
    if (next && frame(next.rect) && next.start - shots[i].end < DIRECT) continue;
    if (leave > arrive) keys.push({ t: leave, ...v }, { t: Math.min(leave + MOVE, seg.dur), ...OVERVIEW });
    at = OVERVIEW;
  }
  // Drop keyframes that went backwards in time when shots crowd each other.
  return keys.filter((k, i) => i === 0 || k.t > keys[i - 1].t - 1e-6).map((k) => ({ ...k, t: Math.max(0, Math.min(k.t, seg.dur)) }));
}
const camera = Object.fromEntries(segments.filter((s): s is Extract<Segment, { kind: "cold" | "scene" }> => s.kind === "scene").map((s) => [String(segments.indexOf(s)), sceneCamera(s)]));

const sounds = [
  ...events.filter((e) => e.kind === "message").flatMap((e) => toOutAll(e.t).map((at) => ({ at, src: "ping" }))),
  ...events.filter((e) => e.kind === "click").flatMap((e) => toOutAll(e.t).map((at) => ({ at, src: "tap" }))),
  ...segments.filter((s) => s.kind !== "scene" || s.key === "03").map((s) => ({ at: s.start - 0.25, src: "whoosh" })),
].filter((s): s is { at: number; src: string } => s.at !== null);

writeFileSync(
  `${ROOT}/src/timeline.json`,
  JSON.stringify({ total, waitSpeed, costTokens: Number(/(\d+) tokens/.exec(events.filter((e) => e.kind === "message").pop()?.text ?? "")?.[1] ?? 0), tasks: marks.filter((m) => /approved|posted|ready|answered/.test(m.label)).length, pages: { web: { w: even(webRect.w), h: even(webRect.h) }, tg: { w: even(tgRect.w), h: even(tgRect.h) } }, segments, camera, voice, captions, callouts, sounds, events, musicSeconds: wavSeconds(`${ROOT}/public/audio/music.wav`) }, null, 1),
);
console.log(`✓ timeline: ${total.toFixed(1)} s, waits ×${waitSpeed}, ${callouts.length} callouts, ${sounds.length} sounds`);
