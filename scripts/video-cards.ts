/**
 * Title, architecture and end cards for the demo video, plus the small
 * on-screen labels, rendered from HTML to 1920×1080 PNGs in the app's brand.
 *
 *   npx tsx scripts/video-cards.ts <out-dir>
 */
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const OUT = process.argv[2];
if (!OUT) throw new Error("Pass the output directory.");
mkdirSync(OUT, { recursive: true });

const wordmark = readFileSync("brand/agentgig-wordmark-dark.svg", "utf8").replace(/width="638" height="240"/, 'width="100%" height="100%"');

const BASE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=block');
* { box-sizing: border-box; margin: 0; padding: 0; }
:root { --bg: #0e1412; --card: #151d1a; --line: #24302b; --fg: #e6eeea; --muted: #93a49c; --green: #3cc79f; --spark: #e7b451; }
html, body { width: 1920px; height: 1080px; background: var(--bg); color: var(--fg); font-family: 'IBM Plex Sans', sans-serif; overflow: hidden; }
.display { font-family: 'Bricolage Grotesque', sans-serif; letter-spacing: -0.02em; }
.mono { font-family: 'IBM Plex Mono', monospace; }
.glow { position: absolute; inset: 0; background: radial-gradient(900px 600px at 78% 18%, rgba(60,199,159,.16), transparent 70%), radial-gradient(700px 500px at 12% 90%, rgba(231,180,81,.10), transparent 70%); }
`;

const title = `
<div class="glow"></div>
<div style="position:absolute; left:160px; top:150px; width:520px; height:196px">${wordmark}</div>
<h1 class="display" style="position:absolute; left:160px; top:400px; width:1500px; font-size:112px; font-weight:800; line-height:1.02">AI employees that<br>work as <span style="color:var(--green)">one team</span>.</h1>
<p style="position:absolute; left:164px; top:680px; font-size:36px; color:var(--muted); width:1300px">Hire agents for real jobs, pay per finished task, and run them from the web or Telegram.</p>
<div style="position:absolute; left:164px; bottom:120px; display:flex; gap:20px">
  ${["Bookkeeping", "Quotes", "Reviews", "Rotas", "VAT"].map((t) => `<span style="font-size:26px; padding:12px 26px; border:1px solid var(--line); border-radius:999px; background:var(--card)">${t}</span>`).join("")}
</div>`;

const steps: [string, string, string][] = [
  ["Verify", "Is the agent hired? Is the person allowed?", "Firebase Auth · Firestore"],
  ["Reserve", "Hold the tokens before any work", "Firestore transactions"],
  ["Scrub", "Remove personal data", "Cloud DLP"],
  ["Ground", "Business profile, files, shared memory", "Cloud Storage · Memory Bank"],
  ["Run", "Native agents, or partners over A2A", "Gemini 2.5 on Vertex AI"],
  ["Deliver", "Ask first, then act in your tools", "Gmail · Sheets · Telegram"],
];

const architecture = `
<div class="glow"></div>
<p class="mono" style="position:absolute; left:120px; top:96px; font-size:24px; color:var(--green); letter-spacing:.12em">UNDER THE HOOD</p>
<h1 class="display" style="position:absolute; left:120px; top:136px; font-size:76px; font-weight:800">One gateway on Cloud Run runs every task</h1>

<div style="position:absolute; left:120px; top:320px; width:1680px; display:grid; grid-template-columns:repeat(6, 1fr); gap:18px">
  ${steps
    .map(
      ([name, what, gcp], i) => `
  <div style="position:relative; background:var(--card); border:1px solid var(--line); border-radius:22px; padding:30px 26px 28px; height:330px">
    <div class="mono" style="font-size:22px; color:var(--muted)">0${i + 1}</div>
    <div class="display" style="font-size:44px; font-weight:700; margin-top:10px">${name}</div>
    <div style="font-size:24px; color:var(--muted); margin-top:14px; line-height:1.35">${what}</div>
    <div style="position:absolute; left:26px; right:26px; bottom:26px; font-size:21px; color:var(--green); font-weight:500; line-height:1.35">${gcp}</div>
    ${i < 5 ? `<div style="position:absolute; right:-17px; top:150px; width:16px; height:16px; border-top:3px solid var(--spark); border-right:3px solid var(--spark); transform:rotate(45deg); z-index:2"></div>` : ""}
  </div>`,
    )
    .join("")}
</div>

<div style="position:absolute; left:120px; top:730px; width:1680px; display:grid; grid-template-columns:1fr 1fr 1fr; gap:18px">
  ${[
    ["Work starts by itself", "Cloud Scheduler · Pub/Sub on Cloud Storage uploads · Cloud Tasks"],
    ["Team lead on Telegram", "Ada hands work to agents with Gemini function calling"],
    ["Fair billing", "Tokens held at the start, charged only for delivered work"],
  ]
    .map(
      ([h, d]) => `<div style="border:1px solid var(--line); border-radius:18px; padding:24px 28px">
      <div class="display" style="font-size:30px; font-weight:700">${h}</div>
      <div style="font-size:23px; color:var(--muted); margin-top:8px; line-height:1.35">${d}</div></div>`,
    )
    .join("")}
</div>`;

const end = `
<div class="glow"></div>
<div style="position:absolute; left:50%; top:300px; width:640px; height:241px; transform:translateX(-50%)">${wordmark}</div>
<h1 class="display" style="position:absolute; left:0; right:0; top:590px; text-align:center; font-size:72px; font-weight:800">AI employees that work as one team.</h1>
<p class="mono" style="position:absolute; left:0; right:0; top:720px; text-align:center; font-size:44px; color:var(--green)">agentgig.si</p>`;

/** A small pill shown in a corner while waiting is sped up. */
const label = (text: string) => `
<style>html, body { background: transparent; }</style>
<div style="position:absolute; right:40px; top:40px; display:flex; align-items:center; gap:14px; padding:14px 26px; border-radius:999px; background:rgba(14,20,18,.82); border:1px solid rgba(255,255,255,.14); font-size:28px; font-weight:500; color:#fff">
  <span style="width:14px; height:14px; border-radius:50%; background:var(--spark)"></span>${text}</div>`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const cards: [string, string, boolean][] = [
    ["title", title, false],
    ["architecture", architecture, false],
    ["end", end, false],
    ...[2, 4, 8].map((x) => [`label-x${x}`, label(`Real run, sped up ×${x}`), true] as [string, string, boolean]),
  ];
  for (const [name, body, transparent] of cards) {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${body}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}.png`, omitBackground: transparent });
    console.log(`✓ ${OUT}/${name}.png`);
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
