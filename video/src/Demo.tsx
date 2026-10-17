import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Audio, Easing, Freeze, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadDisplay } from "@remotion/google-fonts/BricolageGrotesque";
import { loadFont as loadSans } from "@remotion/google-fonts/IBMPlexSans";
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";
import timeline from "./timeline.json";

export const FPS = 60;

const display = loadDisplay("normal", { weights: ["500", "700", "800"], subsets: ["latin"] }).fontFamily;
const sans = loadSans("normal", { weights: ["400", "500", "600"], subsets: ["latin"] }).fontFamily;
const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

const C = { bg: "#0b110f", card: "#151d1a", line: "#24302b", fg: "#e6eeea", muted: "#93a49c", green: "#3cc79f", spark: "#e7b451" };

type Piece = { from: number; to: number; speed: number; hold?: number; outStart: number; outDur: number };
type Seg = { kind: string; key?: string; start: number; dur: number; pieces?: Piece[] };
type Ev = { t: number; page: "web" | "tg"; kind: "move" | "click" | "message"; x: number; y: number; w?: number; h?: number };
const T = timeline as unknown as {
  total: number;
  waitSpeed: number;
  costTokens: number;
  pages: { web: { w: number; h: number }; tg: { w: number; h: number } };
  segments: Seg[];
  voice: { key: string; start: number; dur: number }[];
  captions: { start: number; end: number; text: string }[];
  callouts: { start: number; end: number; text: string; sub?: string }[];
  sounds: { at: number; src: string }[];
  events: Ev[];
};
const f = (s: number) => Math.round(s * FPS);

/* ------------------------------------------------------------------ */
/* Stage layout: the website in a browser window, Telegram in a phone  */
/* ------------------------------------------------------------------ */

const WEB = { x: 56, y: 108, s: 0.86, bar: 38 };
const PHONE = { x: 1222, y: 112, s: 0.84, bezel: 14 };
const webSize = { w: T.pages.web.w * WEB.s, h: T.pages.web.h * WEB.s };
const tgSize = { w: T.pages.tg.w * PHONE.s, h: T.pages.tg.h * PHONE.s };
/** A point in a page, in canvas pixels. */
const toCanvas = (page: "web" | "tg", x: number, y: number) =>
  page === "web" ? { x: WEB.x + x * WEB.s, y: WEB.y + y * WEB.s } : { x: PHONE.x + PHONE.bezel + x * PHONE.s, y: PHONE.y + PHONE.bezel + y * PHONE.s };

/** Where in the take a moment of the video comes from (scenes only). */
function sourceAt(t: number): number | null {
  for (const s of T.segments) {
    if (s.kind !== "scene" || !s.pieces) continue;
    for (const p of s.pieces) if (t >= p.outStart && t < p.outStart + p.outDur) return p.hold ? p.to : p.from + (t - p.outStart) * p.speed;
  }
  return null;
}

type Cam = { z: number; x: number; y: number };
const OVERVIEW: Cam = { z: 1, x: 960, y: 540 };

/** Where the camera wants to be: on the latest action still in play, else the whole stage. */
function shot(t: number): Cam {
  const src = sourceAt(t);
  if (src === null) return OVERVIEW;
  let best: { start: number; cam: Cam } | null = null;
  for (const e of T.events) {
    const [before, after, z] =
      e.kind === "message" ? [0.2, 3.2, 1.7] : e.kind === "click" ? (e.page === "tg" ? [0.9, 1.3, 1.7] : [0.9, 1.6, 1.45]) : e.page === "web" ? [0.3, 1.2, 1.22] : [0, 0, 0];
    if (!z || src < e.t - before || src > e.t + after) continue;
    const p = toCanvas(e.page, e.x + (e.w ?? 0) / 2, e.y + (e.h ?? 0) / 2);
    if (!best || e.t - before > best.start) best = { start: e.t - before, cam: { z, x: p.x, y: p.y } };
  }
  return best?.cam ?? OVERVIEW;
}

/** The camera eases towards each shot: a weighted look back over the last 0.7 s. */
function camera(t: number): Cam {
  let w = 0;
  const acc = { z: 0, x: 0, y: 0 };
  for (let k = 0; k <= 28; k++) {
    const weight = 1 - k / 29;
    const c = shot(t - k * 0.025);
    acc.z += c.z * weight;
    acc.x += c.x * weight;
    acc.y += c.y * weight;
    w += weight;
  }
  const z = acc.z / w;
  // Keep the view on the window and the phone, not the empty stage around them.
  const box = { left: 30, top: 50, right: 1890, bottom: 975 };
  const hw = 960 / z;
  const hh = 540 / z;
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
  return { z, x: clamp(acc.x / w, box.left + hw, box.right - hw), y: clamp(acc.y / w, box.top + hh, box.bottom - hh) };
}

function Pieces({ pieces, page }: { pieces: Piece[]; page: "web" | "tg" }) {
  return (
    <>
      {pieces.map((p, i) => (
        <Sequence key={i} from={f(p.outStart)} durationInFrames={Math.max(1, f(p.outDur))} layout="none">
          {p.hold ? (
            <Freeze frame={0}>
              <OffthreadVideo src={staticFile(`take/${page}.mp4`)} startFrom={f(p.to) - 1} muted style={{ width: "100%", height: "100%" }} />
            </Freeze>
          ) : (
            <OffthreadVideo src={staticFile(`take/${page}.mp4`)} startFrom={f(p.from)} playbackRate={p.speed} muted style={{ width: "100%", height: "100%" }} />
          )}
        </Sequence>
      ))}
    </>
  );
}

function BrowserWindow({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: "absolute", left: WEB.x, top: WEB.y - WEB.bar, width: webSize.w, height: webSize.h + WEB.bar, borderRadius: 14, overflow: "hidden", background: "#f3f5f2", boxShadow: "0 40px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08)" }}>
      <div style={{ height: WEB.bar, background: "#e3e8e4", display: "flex", alignItems: "center", gap: 8, padding: "0 16px" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
        ))}
        <div style={{ marginLeft: 18, flex: 1, maxWidth: 460, height: 24, borderRadius: 12, background: "#fff", display: "flex", alignItems: "center", padding: "0 12px", fontFamily: sans, fontSize: 14, color: "#56655e" }}>🔒 agentgig.si</div>
      </div>
      <div style={{ position: "absolute", left: 0, top: WEB.bar, width: webSize.w, height: webSize.h }}>{children}</div>
    </div>
  );
}

function Phone({ children, x = PHONE.x, y = PHONE.y, s = PHONE.s }: { children: ReactNode; x?: number; y?: number; s?: number }) {
  const w = T.pages.tg.w * s;
  const h = T.pages.tg.h * s;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w + PHONE.bezel * 2, height: h + PHONE.bezel * 2, borderRadius: 58, background: "#101413", boxShadow: "0 40px 90px rgba(0,0,0,.6), inset 0 0 0 2px #2b3330" }}>
      <div style={{ position: "absolute", left: PHONE.bezel, top: PHONE.bezel, width: w, height: h, borderRadius: 44, overflow: "hidden", background: "#000" }}>{children}</div>
      <div style={{ position: "absolute", left: "50%", top: PHONE.bezel + 10, width: 110, height: 30, marginLeft: -55, borderRadius: 16, background: "#000" }} />
    </div>
  );
}

function Stage({ seg }: { seg: Seg }) {
  const frame = useCurrentFrame();
  const t = seg.start + frame / FPS;
  const cam = camera(t);
  const sped = seg.pieces!.some((p) => p.speed > 1 && t >= p.outStart && t < p.outStart + p.outDur);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transformOrigin: "0 0", transform: `translate(${960 - cam.x * cam.z}px, ${540 - cam.y * cam.z}px) scale(${cam.z})` }}>
        <BrowserWindow>
          <Pieces pieces={seg.pieces!.map((p) => ({ ...p, outStart: p.outStart - seg.start }))} page="web" />
        </BrowserWindow>
        <Phone>
          <Pieces pieces={seg.pieces!.map((p) => ({ ...p, outStart: p.outStart - seg.start }))} page="tg" />
        </Phone>
      </AbsoluteFill>
      {sped && <Badge text={`Real run, sped up ×${T.waitSpeed}`} />}
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------------------ */
/* Cold open                                                           */
/* ------------------------------------------------------------------ */

function ColdOpen({ seg }: { seg: Seg }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pieces = seg.pieces!.map((p) => ({ ...p, outStart: p.outStart - seg.start }));
  const push = interpolate(frame, [0, f(seg.dur)], [1, 1.06], { easing: Easing.inOut(Easing.cubic) });
  const tapAt = pieces[2].outStart + 1.2;
  const lines = [
    { at: 0.6, text: "A supplier just overcharged Sam.", color: C.fg },
    { at: tapAt, text: "Fixed with one tap.", color: C.green },
  ];
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${push})` }}>
        <Phone x={1010} y={54} s={1.0}>
          <Pieces pieces={pieces} page="tg" />
        </Phone>
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 130, top: 330, width: 780 }}>
        {lines.map((l, i) => {
          const s = spring({ frame: frame - f(l.at), fps, config: { damping: 200 } });
          return (
            <div key={i} style={{ fontFamily: display, fontWeight: 800, fontSize: 76, lineHeight: 1.05, letterSpacing: "-0.02em", color: l.color, opacity: s, transform: `translateY(${(1 - s) * 30}px)`, marginBottom: 26 }}>
              {l.text}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

function Wordmark({ size = 64 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.28, fontFamily: display, fontWeight: 700, fontSize: size, color: C.fg }}>
      <svg width={size * 1.1} height={size * 1.1} viewBox="0 0 64 64">
        <circle cx="30" cy="27" r="14" fill="none" stroke={C.fg} strokeWidth="8.5" />
        <path d="M44 18v23q0 15-15 15-7 0-11-4" fill="none" stroke={C.fg} strokeWidth="8.5" strokeLinecap="round" />
        <path d="M54 1.5Q54 9 61.5 9Q54 9 54 16.5Q54 9 46.5 9Q54 9 54 1.5Z" fill={C.spark} />
      </svg>
      AgentGig
    </div>
  );
}

const rise = (frame: number, at: number, fps: number) => {
  const s = spring({ frame: frame - f(at), fps, config: { damping: 200 } });
  return { opacity: s, transform: `translateY(${(1 - s) * 40}px)` } as CSSProperties;
};

function Title() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = ["AI", "employees", "that", "work", "as", "one", "team."];
  return (
    <AbsoluteFill style={{ padding: "0 160px", justifyContent: "center" }}>
      <div style={rise(frame, 0.1, fps)}>
        <Wordmark size={60} />
      </div>
      <h1 style={{ fontFamily: display, fontWeight: 800, fontSize: 124, lineHeight: 1.02, letterSpacing: "-0.03em", color: C.fg, margin: "56px 0 0", maxWidth: 1300 }}>
        {words.map((w, i) => (
          <span key={i} style={{ display: "inline-block", marginRight: 30, color: i >= 5 ? C.green : C.fg, ...rise(frame, 0.35 + i * 0.12, fps) }}>
            {w}
          </span>
        ))}
      </h1>
      <div style={{ display: "flex", gap: 18, marginTop: 60 }}>
        {["Bookkeeping", "VAT", "Quotes", "Reviews", "Rotas", "on Telegram"].map((t, i) => (
          <span key={t} style={{ fontFamily: sans, fontSize: 28, padding: "12px 26px", borderRadius: 999, border: `1px solid ${C.line}`, background: C.card, color: C.fg, ...rise(frame, 1.4 + i * 0.1, fps) }}>
            {t}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
}

const STEPS: [string, string, string][] = [
  ["Verify", "Hired? Allowed?", "Firebase Auth · Firestore"],
  ["Reserve", "Hold the tokens", "Firestore transactions"],
  ["Scrub", "Remove personal data", "Cloud DLP"],
  ["Ground", "Profile, files, memory", "Cloud Storage · Memory Bank"],
  ["Run", "Native or partner (A2A)", "Gemini on Vertex AI"],
  ["Deliver", "Ask first, then act", "Gmail · Sheets · Telegram"],
];

function Architecture({ seg }: { seg: Seg }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  // A task travels the pipeline during the first two thirds of the narration.
  const travel = interpolate(t, [2.2, seg.dur * 0.62], [0, 6], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const colW = 268;
  return (
    <AbsoluteFill style={{ padding: "96px 120px" }}>
      <div style={{ fontFamily: mono, fontSize: 24, letterSpacing: "0.14em", color: C.green, ...rise(frame, 0.1, fps) }}>UNDER THE HOOD</div>
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 72, letterSpacing: "-0.02em", color: C.fg, marginTop: 10, ...rise(frame, 0.25, fps) }}>One gateway on Cloud Run runs every task</div>
      <div style={{ position: "relative", marginTop: 70, height: 330 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 165, height: 3, background: C.line }} />
        <div style={{ position: "absolute", left: 0, width: `${(travel / 6) * 100}%`, top: 165, height: 3, background: C.spark, boxShadow: `0 0 18px ${C.spark}` }} />
        {STEPS.map(([name, what, gcp], i) => {
          const lit = travel >= i + 0.5;
          return (
            <div key={name} style={{ position: "absolute", left: i * (colW + 14), top: 0, width: colW, height: 330, borderRadius: 22, padding: "28px 24px", background: lit ? "#17302a" : C.card, border: `1px solid ${lit ? C.green : C.line}`, boxShadow: lit ? `0 0 40px rgba(60,199,159,.25)` : "none", ...rise(frame, 0.5 + i * 0.12, fps) }}>
              <div style={{ fontFamily: mono, fontSize: 20, color: C.muted }}>0{i + 1}</div>
              <div style={{ fontFamily: display, fontWeight: 700, fontSize: 42, color: C.fg, marginTop: 8 }}>{name}</div>
              <div style={{ fontFamily: sans, fontSize: 23, color: C.muted, marginTop: 12, lineHeight: 1.3 }}>{what}</div>
              <div style={{ position: "absolute", left: 24, right: 20, bottom: 24, fontFamily: sans, fontWeight: 500, fontSize: 21, color: lit ? C.green : C.muted, lineHeight: 1.3 }}>{gcp}</div>
            </div>
          );
        })}
        <div style={{ position: "absolute", top: 152, left: `calc(${(travel / 6) * 100}% - 14px)`, width: 28, height: 28, borderRadius: 14, background: C.spark, boxShadow: `0 0 30px ${C.spark}`, opacity: travel > 0 && travel < 6 ? 1 : 0 }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, marginTop: 56 }}>
        {[
          ["Starts by itself", "Cloud Scheduler · Pub/Sub · Cloud Tasks"],
          ["Team lead on Telegram", "Ada uses Gemini function calling"],
          ["Fair billing", "Held at the start, charged on delivery"],
        ].map(([h, d], i) => (
          <div key={h} style={{ border: `1px solid ${C.line}`, borderRadius: 18, padding: "22px 26px", ...rise(frame, seg.dur * 0.62 + i * 0.25, fps) }}>
            <div style={{ fontFamily: display, fontWeight: 700, fontSize: 30, color: C.fg }}>{h}</div>
            <div style={{ fontFamily: sans, fontSize: 22, color: C.muted, marginTop: 6 }}>{d}</div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function Stats() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const stats: [number, string][] = [
    [6, "tasks done"],
    [5, "agents, one team"],
    [T.costTokens, "tokens in total"],
    [0, "passwords shared"],
  ];
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", gap: 90 }}>
        {stats.map(([n, label], i) => {
          const s = spring({ frame: frame - f(0.15 + i * 0.18), fps, config: { damping: 200 } });
          const shown = Math.round(interpolate(frame, [f(0.15 + i * 0.18), f(1.2 + i * 0.18)], [0, n], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
          return (
            <div key={label} style={{ textAlign: "center", opacity: s, transform: `translateY(${(1 - s) * 40}px)` }}>
              <div style={{ fontFamily: display, fontWeight: 800, fontSize: 170, lineHeight: 1, color: i === 3 ? C.green : C.fg }}>{shown}</div>
              <div style={{ fontFamily: sans, fontSize: 30, color: C.muted, marginTop: 14 }}>{label}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function End() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
      <div style={rise(frame, 0.1, fps)}>
        <Wordmark size={84} />
      </div>
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 72, color: C.fg, marginTop: 56, ...rise(frame, 0.35, fps) }}>AI employees that work as one team.</div>
      <div style={{ fontFamily: mono, fontSize: 46, color: C.green, marginTop: 34, ...rise(frame, 0.6, fps) }}>agentgig.si</div>
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------------------ */
/* Overlays                                                            */
/* ------------------------------------------------------------------ */

function Badge({ text }: { text: string }) {
  return (
    <div style={{ position: "absolute", right: 40, top: 34, display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderRadius: 999, background: "rgba(11,17,15,.82)", border: "1px solid rgba(255,255,255,.14)", fontFamily: sans, fontWeight: 500, fontSize: 24, color: "#fff" }}>
      <span style={{ width: 12, height: 12, borderRadius: 6, background: C.spark }} />
      {text}
    </div>
  );
}

function Callouts() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const c = T.callouts.find((x) => t >= x.start && t < x.end);
  if (!c) return null;
  const s = spring({ frame: frame - f(c.start), fps, config: { damping: 18, stiffness: 140 } });
  const out = interpolate(t, [c.end - 0.35, c.end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: 56, top: 30, opacity: Math.min(s, out), transform: `translateX(${(1 - s) * -60}px)`, display: "flex", alignItems: "stretch", borderRadius: 18, overflow: "hidden", background: "rgba(11,17,15,.9)", border: "1px solid rgba(255,255,255,.12)", boxShadow: "0 20px 50px rgba(0,0,0,.45)" }}>
      <div style={{ width: 8, background: C.green }} />
      <div style={{ padding: "16px 26px" }}>
        <div style={{ fontFamily: display, fontWeight: 700, fontSize: 36, color: "#fff" }}>{c.text}</div>
        {c.sub && <div style={{ fontFamily: sans, fontSize: 22, color: C.muted, marginTop: 4 }}>{c.sub}</div>}
      </div>
    </div>
  );
}

function Captions() {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const c = T.captions.find((x) => t >= x.start && t < x.end);
  if (!c) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 40, display: "flex", justifyContent: "center" }}>
      <div style={{ maxWidth: 1500, padding: "12px 26px", borderRadius: 14, background: "rgba(0,0,0,.72)", fontFamily: sans, fontWeight: 500, fontSize: 34, lineHeight: 1.3, color: "#fff", textAlign: "center" }}>{c.text}</div>
    </div>
  );
}

function Backdrop() {
  return (
    <AbsoluteFill style={{ background: `radial-gradient(1100px 700px at 80% 10%, rgba(60,199,159,.18), transparent 70%), radial-gradient(900px 600px at 8% 95%, rgba(231,180,81,.10), transparent 70%), ${C.bg}` }}>
      <AbsoluteFill style={{ backgroundImage: "radial-gradient(rgba(255,255,255,.05) 1px, transparent 1px)", backgroundSize: "28px 28px" }} />
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

function Sound() {
  const talking = (fr: number) => T.voice.some((v) => fr / FPS >= v.start - 0.3 && fr / FPS <= v.start + v.dur + 0.3);
  return (
    <>
      <Audio
        src={staticFile("audio/music.wav")}
        volume={(fr) => {
          const edge = interpolate(fr, [0, f(1), f(T.total - 3.5), f(T.total)], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return edge * (talking(fr) ? 0.11 : 0.3);
        }}
      />
      {T.voice.map((v) => (
        <Sequence key={v.key} from={f(v.start)} layout="none">
          <Audio src={staticFile(`audio/voice/${v.key}.wav`)} volume={1} />
        </Sequence>
      ))}
      {T.sounds.map((s, i) => (
        <Sequence key={i} from={Math.max(0, f(s.at))} durationInFrames={f(1)} layout="none">
          <Audio src={staticFile(`audio/${s.src}.wav`)} volume={s.src === "ping" ? 0.55 : s.src === "tap" ? 0.35 : 0.5} />
        </Sequence>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The video                                                           */
/* ------------------------------------------------------------------ */

export const Demo = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <Backdrop />
    {T.segments.map((s, i) => (
      <Sequence key={i} from={f(s.start)} durationInFrames={Math.max(1, f(s.dur))}>
        {s.kind === "cold" && <ColdOpen seg={s} />}
        {s.kind === "title" && <Title />}
        {s.kind === "scene" && <Stage seg={s} />}
        {s.kind === "arch" && <Architecture seg={s} />}
        {s.kind === "stats" && <Stats />}
        {s.kind === "end" && <End />}
      </Sequence>
    ))}
    <Callouts />
    <Captions />
    <Sound />
  </AbsoluteFill>
);
