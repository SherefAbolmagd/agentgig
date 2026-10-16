/**
 * Cuts the demo video from a raw take: scenes from marks.json, agent waits
 * sped up (and labelled) only as much as needed to land between 3:15 and
 * 3:50, cards, the narration clip at the start of each scene, and captions.
 *
 *   FFMPEG=<path> npx tsx scripts/video-edit.ts <take-dir> <narration-dir> <cards-dir> <out.mp4>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const [TAKE, NARR, CARDS, OUT] = process.argv.slice(2);
if (!OUT) throw new Error("Usage: video-edit.ts <take-dir> <narration-dir> <cards-dir> <out.mp4>");
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const WORK = `${TAKE}/edit`;
mkdirSync(WORK, { recursive: true });

const TARGET_MIN = 195;
const TARGET_MAX = 230;
const LEAD = 0.5; // narration starts this long after its scene
const TAIL = 1.2; // and the scene runs at least this long after it ends

const marks = JSON.parse(readFileSync(`${TAKE}/marks.json`, "utf8")) as { t: number; label: string }[];
const at = (label: string) => {
  const m = marks.find((x) => x.label === label);
  if (!m) throw new Error(`No mark "${label}" in the take`);
  return m.t;
};
const narration = JSON.parse(readFileSync("fixtures/video/narration.json", "utf8")) as Record<string, string>;
const wavSeconds = (key: string) => (statSync(`${NARR}/${key}.wav`).size - 44) / (48000 * 2);

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

/** A stretch of the raw take; `wait` stretches may be sped up. */
type Piece = { from: number; to: number; wait?: boolean } | { card: string; seconds: number };
interface Scene {
  key: string;
  pieces: Piece[];
}

function scenes(): Scene[] {
  const s = (a: string, b: string) => ({ from: at(a), to: at(b) });
  const w = (a: number, b: number) => ({ from: a, to: b, wait: true });
  return [
    { key: "01", pieces: [{ card: "title", seconds: wavSeconds("01") + LEAD + TAIL }] },
    { key: "02", pieces: [s("scene 2 home", "scene 3 knowledge")] },
    { key: "03", pieces: [s("scene 3 knowledge", "scene 4 hire")] },
    { key: "04", pieces: [s("scene 4 hire", "scene 5 invoices")] },
    { key: "05", pieces: [s("scene 5 invoices", "invoices dropped"), w(at("invoices dropped"), at("invoice draft in telegram"))] },
    { key: "06", pieces: [s("invoice draft in telegram", "scene 7 vat")] },
    { key: "07", pieces: [{ from: at("scene 7 vat"), to: at("scene 7 vat") + 4 }, w(at("scene 7 vat") + 4, at("vat posted")), s("vat posted", "scene 8 quote")] },
    { key: "08", pieces: [{ from: at("scene 8 quote"), to: at("scene 8 quote") + 3 }, w(at("scene 8 quote") + 3, at("quote posted")), s("quote posted", "scene 9 review")] },
    { key: "09", pieces: [{ from: at("scene 9 review"), to: at("scene 9 review") + 3 }, w(at("scene 9 review") + 3, at("review draft posted")), s("review draft posted", "scene 10 rota")] },
    { key: "10", pieces: [{ from: at("scene 10 rota"), to: at("scene 10 rota") + 7 }, w(at("scene 10 rota") + 7, at("rota ready")), s("rota ready", "scene 11 cost")] },
    { key: "11", pieces: [{ from: at("scene 11 cost"), to: at("scene 11 cost") + 3 }, w(at("scene 11 cost") + 3, at("cost answered")), s("cost answered", "end")] },
    { key: "12", pieces: [{ card: "architecture", seconds: wavSeconds("12") + LEAD + TAIL }, { card: "end", seconds: 4 }] },
  ];
}

const pieceSeconds = (p: Piece, speed: number) => ("card" in p ? p.seconds : (p.to - p.from) / (p.wait ? speed : 1));
/** A scene is never shorter than its narration needs. */
const sceneSeconds = (sc: Scene, speed: number) => Math.max(sc.pieces.reduce((n, p) => n + pieceSeconds(p, speed), 0), wavSeconds(sc.key) + LEAD + TAIL);

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

const ff = (args: string[]) => execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const VOPTS = ["-r", "60", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-an"];

function renderScene(sc: Scene, speed: number): string {
  const parts: string[] = [];
  sc.pieces.forEach((p, i) => {
    const file = `${WORK}/${sc.key}-${i}.mp4`;
    if ("card" in p) {
      ff(["-loop", "1", "-t", p.seconds.toFixed(3), "-i", `${CARDS}/${p.card}.png`, "-vf", "scale=1920:1080,fps=60", ...VOPTS, file]);
    } else if (p.wait && speed > 1) {
      ff([
        "-ss", p.from.toFixed(3), "-to", p.to.toFixed(3), "-i", `${TAKE}/raw.mp4`,
        "-loop", "1", "-i", `${CARDS}/label-x${speed}.png`,
        "-filter_complex", `[0:v]setpts=PTS/${speed},fps=60[v];[v][1:v]overlay=0:0:shortest=1`,
        ...VOPTS, file,
      ]);
    } else {
      ff(["-ss", p.from.toFixed(3), "-to", p.to.toFixed(3), "-i", `${TAKE}/raw.mp4`, "-vf", "fps=60", ...VOPTS, file]);
    }
    parts.push(file);
  });
  // Hold the last frame if the narration needs longer than the pictures.
  const pictures = sc.pieces.reduce((n, p) => n + pieceSeconds(p, speed), 0);
  const hold = sceneSeconds(sc, speed) - pictures;
  const list = `${WORK}/${sc.key}.txt`;
  writeFileSync(list, parts.map((f) => `file '${f.split("/").pop()}'`).join("\n"));
  const out = `${WORK}/scene-${sc.key}.mp4`;
  ff(["-f", "concat", "-safe", "0", "-i", list, "-vf", `tpad=stop_mode=clone:stop_duration=${Math.max(0, hold).toFixed(3)}`, ...VOPTS, out]);
  return out;
}

/** Captions: each narration line split into sentences, timed by length. */
function srt(starts: Record<string, number>): string {
  const ts = (s: number) => {
    const ms = Math.round(s * 1000);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  const cues: string[] = [];
  for (const [key, text] of Object.entries(narration)) {
    const sentences = text.match(/[^.!?:]+[.!?:]+/g)?.map((x) => x.trim()) ?? [text];
    const total = sentences.reduce((n, x) => n + x.length, 0);
    let t = starts[key] + LEAD;
    const len = wavSeconds(key);
    for (const sentence of sentences) {
      const d = (sentence.length / total) * len;
      cues.push(`${cues.length + 1}\n${ts(t)} --> ${ts(t + d - 0.05)}\n${sentence}\n`);
      t += d;
    }
  }
  return cues.join("\n");
}

async function main() {
  const list = scenes();
  // The least speed-up that fits; real time when it already does.
  const speed = [1, 2, 4, 8].find((s) => list.reduce((n, sc) => n + sceneSeconds(sc, s), 0) <= TARGET_MAX) ?? 8;
  const total = list.reduce((n, sc) => n + sceneSeconds(sc, speed), 0);
  console.log(`Waits at ×${speed}; cut is ${total.toFixed(1)} s`);
  if (total < TARGET_MIN) console.log(`⚠ Under ${TARGET_MIN} s: scenes will hold on their last frame longer.`);

  const files: string[] = [];
  const starts: Record<string, number> = {};
  let t = 0;
  for (const sc of list) {
    starts[sc.key] = t;
    files.push(renderScene(sc, speed));
    t += sceneSeconds(sc, speed);
    console.log(`  scene ${sc.key} → ${t.toFixed(1)} s`);
  }

  // Short cuts get a little more air after each scene so the video reaches the minimum.
  const video = `${WORK}/video.mp4`;
  writeFileSync(`${WORK}/scenes.txt`, files.map((f) => `file '${f.split("/").pop()}'`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", `${WORK}/scenes.txt`, "-c", "copy", video]);

  const captions = `${WORK}/captions.srt`;
  writeFileSync(captions, srt(starts));
  writeFileSync(OUT.replace(/\.mp4$/, ".srt"), srt(starts));

  const keys = Object.keys(narration);
  const audioInputs = keys.flatMap((k) => ["-i", `${NARR}/${k}.wav`]);
  const delays = keys.map((k, i) => `[${i + 1}:a]adelay=${Math.round((starts[k] + LEAD) * 1000)}:all=1[a${i}]`).join(";");
  const mix = `${keys.map((_, i) => `[a${i}]`).join("")}amix=inputs=${keys.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${total.toFixed(3)}[aud]`;
  // Subtitles filter paths need escaped colons on Windows.
  const subPath = captions.replace(/\\/g, "/").replace(/:/g, "\\:");
  const style = "FontName=Arial,FontSize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&H40000000,BackColour=&H40000000,BorderStyle=3,Outline=6,Shadow=0,MarginV=22";
  ff([
    "-i", video, ...audioInputs,
    "-filter_complex", `${delays};${mix};[0:v]subtitles='${subPath}':force_style='${style}'[v]`,
    "-map", "[v]", "-map", "[aud]", "-t", total.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart",
    OUT,
  ]);
  console.log(`✓ ${OUT} (${total.toFixed(1)} s) and ${OUT.replace(/\.mp4$/, ".srt")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
