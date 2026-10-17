/**
 * Audio for the demo video, all from Google Cloud:
 *   music  <out-dir>                       Lyria 2 on Vertex AI: background clips (30 s each)
 *   voice  <voice> <lines.json> <out-dir>  Gemini TTS through Cloud Text-to-Speech, with a style prompt
 *
 *   npx tsx scripts/video-audio.ts music <out-dir>
 *   npx tsx scripts/video-audio.ts voice Charon fixtures/video/narration.json <out-dir>
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "agentexchange-hackathon";
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

async function post<T>(url: string, body: unknown): Promise<T> {
  const client = await auth.getClient();
  const res = await client.request<T>({ url, method: "POST", data: body, headers: { "x-goog-user-project": PROJECT } });
  return res.data;
}

const MUSIC_PROMPT =
  "An original instrumental bed for a short film about a small coffee roaster's busy morning: bright marimba and plucked synth arpeggios over a soft round bass and brushed percussion, hopeful and forward-moving, light and uncluttered so a voice can sit on top";
const MUSIC_AVOID = "vocals, singing, speech, harsh drums, distortion, sudden drops";

/** Delivery direction for Gemini TTS. */
const STYLE =
  "Read this as the narrator of an exciting product launch video: warm, confident and upbeat, clearly smiling, with natural energy and crisp pacing. Not salesy, not robotic.";

async function music(out: string) {
  mkdirSync(out, { recursive: true });
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/us-central1/publishers/google/models/lyria-002:predict`;
  // Lyria returns 30 s clips and blocks any that sound too close to existing music, so try several seeds.
  let made = 0;
  for (const seed of [11, 23, 37, 41, 53, 67, 71, 89, 97, 101, 113, 127]) {
    try {
      const res = await post<{ predictions: { bytesBase64Encoded?: string; audioContent?: string }[] }>(url, {
        instances: [{ prompt: MUSIC_PROMPT, negative_prompt: MUSIC_AVOID, seed }],
        parameters: {},
      });
      const b64 = res.predictions?.[0]?.bytesBase64Encoded ?? res.predictions?.[0]?.audioContent;
      if (!b64) throw new Error("no audio in the response");
      writeFileSync(`${out}/music-${String(++made).padStart(2, "0")}.wav`, Buffer.from(b64, "base64"));
      console.log(`✓ clip ${made} (seed ${seed})`);
      if (made === 8) break;
    } catch (err) {
      const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
      console.log(`  seed ${seed} skipped: ${(e.response?.data?.error?.message ?? e.message ?? "").slice(0, 100)}`);
    }
  }
  if (made < 4) throw new Error(`Only ${made} music clips were generated.`);
}

async function voice(name: string, linesFile: string, out: string) {
  mkdirSync(out, { recursive: true });
  const lines = JSON.parse(readFileSync(linesFile, "utf8")) as Record<string, string>;
  for (const [key, text] of Object.entries(lines)) {
    const res = await post<{ audioContent: string }>("https://texttospeech.googleapis.com/v1beta1/text:synthesize", {
      input: { prompt: STYLE, text },
      voice: { languageCode: "en-GB", name, modelName: "gemini-2.5-pro-tts" },
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 48000 },
    });
    const wav = Buffer.from(res.audioContent, "base64");
    writeFileSync(`${out}/${key}.wav`, wav);
    console.log(`${key}  ${((wav.length - 44) / 96000).toFixed(1)} s`);
  }
}

const [mode, a, b, c] = process.argv.slice(2);
(mode === "music" ? music(a) : mode === "voice" ? voice(a, b, c) : Promise.reject(new Error("Usage: video-audio.ts music <out> | voice <name> <lines.json> <out>"))).catch((err) => {
  console.error(err?.response?.data ? JSON.stringify(err.response.data).slice(0, 600) : err);
  process.exit(1);
});
