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
  | { kind: "title" | "team" | "arch" | "stats" | "end"; key?: string; start: number; dur: number };

const voiceLen = (key: string) => wavSeconds(`${ROOT}/public/audio/voice/${key}.wav`);
const p = (from: number, to: number, speed = 1, wait = false): Piece => ({ from, to, speed, wait });
const w = (from: number, to: number) => p(from, to, 1, true);

// The story: every agent starts on an event; marks come from scripts/video-record.ts.
const has = (label: string) => marks.some((m) => m.label === label);

/**
 * One event, from the recorder's marks: the source app (its page load sped up), the wait while
 * the agent works (sped up), Sam reading and tapping on the phone, the delivery (sped up), Ada's
 * confirmation, then each result page (loads sped up) and the trip back (sped up).
 */
const event = (n: string, results: string[], next: string): Piece[] => {
  const ps = [
    w(at(`event ${n}`), at(`${n} source`) - 0.3),
    p(at(`${n} source`) - 0.3, at(`${n} source done`)),
    w(at(`${n} source done`), at(`${n} ready`) - 0.8),
    p(at(`${n} ready`) - 0.8, at(`${n} tapped`) + 0.6),
    w(at(`${n} tapped`) + 0.6, at(`${n} approved`) - 0.2),
    p(at(`${n} approved`) - 0.2, at(`${n} approved`) + 1.2),
  ];
  let from = at(`${n} approved`) + 1.2;
  for (const r of results.filter(has)) {
    ps.push(w(from, at(r) - 0.3), p(at(r) - 0.3, at(`${r} done`)));
    from = at(`${r} done`);
  }
  ps.push(w(from, at(next)));
  return ps.filter((x) => x.to > x.from);
};

// The hook: a Shopify order comes in and Sam's phone lights up, nobody asked.
const hook: Piece[] = [p(at("order source") - 0.3, at("order source done")), w(at("order source done"), at("order ready") - 0.8), p(at("order ready") - 0.8, at("order ready") + 2.6)];

const scenes: { key: string; pieces: Piece[]; chip?: [string, string, string] }[] = [
  // Page loads in the tour are skipped: each page appears once its content is in.
  {
    key: "03",
    pieces: has("tour memory go")
      ? [p(at("tour team"), at("tour memory go")), w(at("tour memory go"), at("tour memory")), p(at("tour memory"), at("tour marketplace go")), w(at("tour marketplace go"), at("tour marketplace")), p(at("tour marketplace"), at("tour telegram go"))]
      : [p(at("tour team"), at("tour telegram"))],
  },
  { key: "04", pieces: has("tour telegram go") ? [w(at("tour telegram go"), at("tour telegram")), p(at("tour telegram"), at("event order"))] : [p(at("tour telegram"), at("event order"))] },
  { key: "05", pieces: event("order", ["order result"], "event where"), chip: ["09:02", "Shopify", "New order"] },
  { key: "06", pieces: event("where", ["where result"], "event refund"), chip: ["09:40", "Gmail", "Customer email"] },
  { key: "07", pieces: event("refund", ["refund stripe", "refund result"], "event declined"), chip: ["10:30", "Gmail", "Refund request"] },
  { key: "08", pieces: event("declined", ["declined result"], "event invoice"), chip: ["11:15", "Stripe", "Card declined"] },
  // The 5-minute Drive check is skipped: the wait after the folder glance runs into the check.
  { key: "09", pieces: event("invoice", ["invoice result"], "event quote"), chip: ["12:05", "Google Drive", "Supplier invoice"] },
  { key: "10", pieces: event("quote", ["quote result"], "cost"), chip: ["14:20", "Gmail", "Wholesale enquiry"] },
  { key: "11", pieces: [p(at("cost"), at("cost") + 3), w(at("cost") + 3, at("cost answered") - 0.8), p(at("cost answered") - 0.8, Math.min(at("end"), at("cost answered") + 4))] },
];

const piecesLen = (ps: Piece[], waitSpeed: number) => ps.reduce((n, x) => n + (x.to - x.from) / (x.wait ? waitSpeed : x.speed), 0);
const sceneLen = (sc: { key: string; pieces: Piece[] }, waitSpeed: number) => Math.max(piecesLen(sc.pieces, waitSpeed), voiceLen(sc.key) + LEAD + TAIL);
const TITLE = voiceLen("01") + LEAD + 1.0;
const TEAM = voiceLen("02") + LEAD + 1.2;
const ARCH = voiceLen("12") + LEAD + 0.6;
const STATS = 3.8;
const END = 4.0;
const fixed = TITLE + TEAM + ARCH + STATS + END;
const hookLen = (s: number) => Math.max(piecesLen(hook, s), voiceLen("00") + LEAD + 0.6);
const waitSpeed = [1, 1.5, 2, 3, 4, 6, 8].find((s) => fixed + hookLen(s) + scenes.reduce((n, sc) => n + sceneLen(sc, s), 0) <= MAX_TOTAL) ?? 8;

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
place("scene", "00", hook, voiceLen("00") + LEAD + 0.6);
segments.push({ kind: "title", key: "01", start: t, dur: TITLE });
t += TITLE;
segments.push({ kind: "team", key: "02", start: t, dur: TEAM });
t += TEAM;
for (const sc of scenes) place("scene", sc.key, sc.pieces, voiceLen(sc.key) + LEAD + TAIL);
segments.push({ kind: "arch", key: "12", start: t, dur: ARCH });
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

/** Every output time showing a moment of the take (the hook repeats some). */
const toOutAll = (src: number): number[] =>
  segments.flatMap((s) => ("pieces" in s ? s.pieces.filter((x) => !x.hold && src >= x.from && src < x.to).map((x) => x.outStart + (src - x.from) / x.speed) : []));
/** When a moment of the take appears in the story after the hook, if it does. */
const toOut = (src: number): number | null => toOutAll(src).filter((o) => o >= sceneStart("03")).shift() ?? null;

const sceneStart = (key: string) => segments.find((s) => s.key === key)!.start;
const sceneEnd = (key: string) => {
  const s = segments.find((x) => x.key === key)!;
  return s.start + s.dur;
};
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

const chips = [
  { start: sceneStart("00") + 0.3, end: sceneEnd("00") - 0.2, clock: "09:02", source: "Shopify", what: "New order" },
  ...scenes.filter((sc) => sc.chip).map((sc) => ({ start: sceneStart(sc.key) + 0.3, end: sceneEnd(sc.key) - 0.2, clock: sc.chip![0], source: sc.chip![1], what: sc.chip![2] })),
];

const callout = (outT: number | null, text: string, sub?: string) => (outT === null ? [] : [{ start: outT, end: outT + 3.4, text, sub }]);
const callouts = [
  ...callout(toOutAll(at("order ready"))[0] ?? null, "Nobody asked. The order did.", "Inventory Guardian picked it up by itself"),
  ...callout(sceneStart("03") + 1.2, "What starts each agent", "Chosen when Sam hires it"),
  ...callout(toOut(at("tour memory")), "One memory for the whole team", "Customer and money facts need Sam's OK"),
  ...callout(toOut(at("tour marketplace")), "Hire more from the marketplace", "Paid per finished task"),
  ...callout(sceneStart("04") + 1.0, "Link Telegram once", "Ada brings every draft to Sam's phone"),
  ...callout(toOut(at("order ready")), "Fig & Cedar down to 2", "Reorder to Calder Candle Co. written"),
  ...callout(toOut(at("order result")), "Sent from Sam's Gmail", "Only after Sam's tap"),
  ...callout(toOut(at("where source")), "A customer emails", "Nobody forwards it"),
  ...callout(toOut(at("where ready")), "Found in Shopify", "Tracking included"),
  ...callout(toOut(at("refund ready")), "Refund £24.00?", "Only the cracked candle, never more than was paid"),
  ...callout(toOut(at("refund stripe")), "Refunded in Stripe", "Apology sent in the same thread"),
  ...callout(toOut(at("declined source")), "Card declined in Stripe", "Stripe tells AgentGig straight away"),
  ...callout(toOut(at("declined ready")), "A kind note, a new payment link", "The sale isn't lost"),
  ...callout(toOut(at("invoice source")), "Lands in Google Drive", "The folder is checked every 5 minutes"),
  ...callout(toOut(at("invoice ready")), "£22.00 overcharge caught", "Gemini reads it · code checks the sums"),
  ...callout(toOut(at("quote source")), "A wholesale enquiry", "Quote Builder picks it up from the inbox"),
  ...callout(toOut(at("quote ready")), "Priced from Sam's own list", "And it remembers Northside pays late"),
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
  ...segments.filter((s, i) => i > 0 && (s.kind !== "scene" || s.key === "03" || s.key === "05")).map((s) => ({ at: s.start - 0.25, src: "whoosh" })),
].filter((s): s is { at: number; src: string } => s.at !== null);

writeFileSync(
  `${ROOT}/src/timeline.json`,
  JSON.stringify({ total, waitSpeed, costTokens: Number(/(\d+) tokens/.exec(events.filter((e) => e.kind === "message").pop()?.text ?? "")?.[1] ?? 0), tasks: marks.filter((m) => / approved$/.test(m.label)).length, chips, pages: { web: { w: even(webRect.w), h: even(webRect.h) }, tg: { w: even(tgRect.w), h: even(tgRect.h) } }, segments, camera, voice, captions, callouts, sounds, events, musicSeconds: wavSeconds(`${ROOT}/public/audio/music.wav`) }, null, 1),
);
console.log(`✓ timeline: ${total.toFixed(1)} s, waits ×${waitSpeed}, ${callouts.length} callouts, ${sounds.length} sounds`);
