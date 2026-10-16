/**
 * Narration for the demo video with Google Cloud Text-to-Speech (Chirp 3 HD),
 * as 48 kHz WAV clips; prints each clip's length for timing the edit.
 *
 *   npx tsx scripts/video-tts.ts voices <out-dir>              a sample of each candidate voice
 *   npx tsx scripts/video-tts.ts lines <voice> <lines.json> <out-dir>
 *                                                             one WAV per line: {"01": "text", ...}
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

const SAMPLE =
  "This is Sam, who runs Café Lumen, a coffee roaster supplying offices in Manchester. Sam's team has six agents, a token balance and a memory they all share.";

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

async function call<T>(path: string, body?: unknown): Promise<T> {
  const client = await auth.getClient();
  const res = await client.request<T>({
    url: `https://texttospeech.googleapis.com/v1/${path}`,
    method: body ? "POST" : "GET",
    data: body,
    headers: { "x-goog-user-project": process.env.GOOGLE_CLOUD_PROJECT ?? "agentexchange-hackathon" },
  });
  return res.data;
}

async function speak(voice: string, text: string, file: string) {
  const languageCode = voice.split("-").slice(0, 2).join("-");
  const { audioContent } = await call<{ audioContent: string }>("text:synthesize", {
    input: { text },
    voice: { languageCode, name: voice },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 48000 },
  });
  const wav = Buffer.from(audioContent, "base64");
  writeFileSync(file, wav);
  return (wav.length - 44) / (48000 * 2);
}

async function main() {
  const [mode, a, b, c] = process.argv.slice(2);
  if (mode === "voices") {
    mkdirSync(a, { recursive: true });
    const { voices } = await call<{ voices: { name: string; ssmlGender: string }[] }>("voices?languageCode=en-GB");
    const chirp = voices.filter((v) => v.name.includes("Chirp3-HD"));
    console.log(chirp.map((v) => `${v.name} (${v.ssmlGender.toLowerCase()})`).join("\n"));
    const picks = ["Charon", "Kore", "Puck", "Aoede", "Fenrir", "Leda"].map((n) => chirp.find((v) => v.name.endsWith(n))).filter(Boolean);
    for (const v of picks) {
      await speak(v!.name, SAMPLE, `${a}/${v!.name}.wav`);
      console.log(`✓ ${a}/${v!.name}.wav`);
    }
  } else if (mode === "lines") {
    mkdirSync(c, { recursive: true });
    const lines = JSON.parse(readFileSync(b, "utf8")) as Record<string, string>;
    for (const [key, text] of Object.entries(lines)) {
      const seconds = await speak(a, text, `${c}/${key}.wav`);
      console.log(`${key}  ${seconds.toFixed(1)} s`);
    }
  } else {
    console.log("Usage: video-tts.ts voices <out-dir> | lines <voice> <lines.json> <out-dir>");
  }
}

main().catch((err) => {
  console.error(err?.response?.data ?? err);
  process.exit(1);
});
