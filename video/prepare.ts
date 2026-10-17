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
const message = (match: RegExp) => {
  const e = events.find((x) => x.kind === "message" && match.test(x.text ?? ""));
  if (!e) throw new Error(`No Telegram message matching ${match}`);
  return e.t;
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

const firstMessage = message(/overcharged by/);
const approved = message(/drafted a correction/);
const tap = events.find((e) => e.kind === "click" && e.page === "tg" && e.t > firstMessage)!.t;

// Cold open: the overcharge arrives on Sam's phone and is fixed with one tap.
const cold: Piece[] = [p(firstMessage - 1.2, firstMessage + 1.6), p(firstMessage + 1.6, tap - 1.2, 4), p(tap - 1.2, tap + 0.8), p(tap + 0.8, approved - 0.4, 3), p(approved - 0.4, approved + 1.8)];

const scenes: { key: string; pieces: Piece[] }[] = [
  { key: "02", pieces: [p(at("scene 2 home"), at("scene 3 knowledge"))] },
  { key: "03", pieces: [p(at("scene 3 knowledge"), at("scene 4 hire"))] },
  { key: "04", pieces: [p(at("scene 4 hire"), at("scene 5 invoices"))] },
  { key: "05", pieces: [p(at("scene 5 invoices"), at("invoices dropped")), w(at("invoices dropped"), firstMessage - 1), p(firstMessage - 1, at("invoice draft in telegram"))] },
  { key: "06", pieces: [p(at("invoice draft in telegram"), at("scene 7 vat"))] },
  { key: "07", pieces: [p(at("scene 7 vat"), at("scene 7 vat") + 4), w(at("scene 7 vat") + 4, message(/VAT to reclaim/) - 1), p(message(/VAT to reclaim/) - 1, at("scene 8 quote"))] },
  { key: "08", pieces: [p(at("scene 8 quote"), at("scene 8 quote") + 3), w(at("scene 8 quote") + 3, message(/Quote Q-/) - 1), p(message(/Quote Q-/) - 1, at("scene 9 review"))] },
  { key: "09", pieces: [p(at("scene 9 review"), at("scene 9 review") + 3), w(at("scene 9 review") + 3, message(/review needs attention|Reply ready/) - 1), p(message(/review needs attention|Reply ready/) - 1, at("scene 10 rota"))] },
  { key: "10", pieces: [p(at("scene 10 rota"), at("scene 10 rota") + 7), w(at("scene 10 rota") + 7, at("rota ready") - 1), p(at("rota ready") - 1, at("scene 11 cost"))] },
  { key: "11", pieces: [p(at("scene 11 cost"), at("scene 11 cost") + 3), w(at("scene 11 cost") + 3, message(/tokens/) - 1), p(message(/tokens/) - 1, at("end"))] },
];

const piecesLen = (ps: Piece[], waitSpeed: number) => ps.reduce((n, x) => n + (x.to - x.from) / (x.wait ? waitSpeed : x.speed), 0);
const sceneLen = (sc: { key: string; pieces: Piece[] }, waitSpeed: number) => Math.max(piecesLen(sc.pieces, waitSpeed), voiceLen(sc.key) + LEAD + TAIL);
const TITLE = voiceLen("01") + LEAD + 1.0;
const ARCH = voiceLen("12") + LEAD + 0.6;
const STATS = 3.8;
const END = 4.0;
const fixed = piecesLen(cold, 1) + TITLE + ARCH + STATS + END;
const waitSpeed = [1, 1.5, 2, 3, 4, 6].find((s) => fixed + scenes.reduce((n, sc) => n + sceneLen(sc, s), 0) <= MAX_TOTAL) ?? 6;

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
place("cold", undefined, cold);
segments.push({ kind: "title", key: "01", start: t, dur: TITLE });
t += TITLE;
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

/** Every output time showing a moment of the take (the cold open repeats some). */
const toOutAll = (src: number): number[] =>
  segments.flatMap((s) => ("pieces" in s ? s.pieces.filter((x) => !x.hold && src >= x.from && src < x.to).map((x) => x.outStart + (src - x.from) / x.speed) : []));
/** When a moment of the take appears in the story's scenes, if it does. */
const toOut = (src: number): number | null => toOutAll(src).filter((o) => o >= sceneStart("02")).shift() ?? null;

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
  ...callout(sceneStart("03") + 1.5, "Grounded in your business", "Profile · files · shared memory"),
  ...callout(sceneStart("04") + 2, "Hire in a few clicks", "Priced per finished task"),
  ...callout(toOut(firstMessage), "£38.40 overcharge caught", "Gemini reads it · code checks the sums"),
  ...callout(toOut(approved), "Approved from Sam's phone", "Logged to Sheets · correction drafted in Gmail"),
  ...callout(toOut(message(/VAT to reclaim/)), "A partner company's agent", "Handed the work over A2A, never Sam's logins"),
  ...callout(toOut(message(/Quote Q-/)), "Priced from Sam's own list", "Saved as a Gmail draft"),
  ...callout(toOut(message(/Got it|I've saved|I've noted/i)), "Shared company memory", "Every agent knows it now"),
  ...callout(toOut(message(/review needs attention|Reply ready/)), "Nothing goes out without an OK", "Approve · Edit · Skip"),
  ...callout(toOut(at("rota ready")), "Every shift checked in code", "Availability and hours"),
  ...callout(toOut(message(/tokens/)), "Charged only for finished work", "Failed tasks are free"),
];

const sounds = [
  ...events.filter((e) => e.kind === "message").flatMap((e) => toOutAll(e.t).map((at) => ({ at, src: "ping" }))),
  ...events.filter((e) => e.kind === "click").flatMap((e) => toOutAll(e.t).map((at) => ({ at, src: "tap" }))),
  ...segments.filter((s) => s.kind !== "scene" || s.key === "02").slice(1).map((s) => ({ at: s.start - 0.25, src: "whoosh" })),
].filter((s): s is { at: number; src: string } => s.at !== null);

writeFileSync(
  `${ROOT}/src/timeline.json`,
  JSON.stringify({ total, waitSpeed, costTokens: Number(/(\d+) tokens/.exec(events.filter((e) => e.kind === "message").pop()?.text ?? "")?.[1] ?? 0), tasks: marks.filter((m) => /approved|posted|ready|answered/.test(m.label)).length, pages: { web: { w: even(webRect.w), h: even(webRect.h) }, tg: { w: even(tgRect.w), h: even(tgRect.h) } }, segments, voice, captions, callouts, sounds, events, musicSeconds: wavSeconds(`${ROOT}/public/audio/music.wav`) }, null, 1),
);
console.log(`✓ timeline: ${total.toFixed(1)} s, waits ×${waitSpeed}, ${callouts.length} callouts, ${sounds.length} sounds`);
