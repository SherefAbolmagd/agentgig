import { z } from "zod";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, groundingPrompt } from "./types";

const TONES = ["Friendly", "Confident", "Expert", "Playful"] as const;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const EchoSocialInput = z.object({
  brandUrl: z.url({ protocol: /^https?$/ }),
  audience: z.string().trim().min(3).max(200),
  tone: z.enum(TONES),
  topic: z.string().trim().max(300).optional(),
});
export type EchoSocialInput = z.infer<typeof EchoSocialInput>;

/** What Gemini returns. */
const ModelOutput = z.object({
  hook: z.string().describe("First line, under 120 characters, written to stop the scroll"),
  body: z.string().describe("2–4 short paragraphs separated by blank lines"),
  callToAction: z.string().describe("One sentence telling the reader exactly what to do"),
  hashtags: z.array(z.string()).min(3).max(6).describe("Without the # sign"),
  alternativeHooks: z.array(z.string()).length(2),
  bestTime: z.object({ day: z.enum(DAYS), time: z.string().describe("24h HH:MM") }),
});

export type EchoSocialOutput = z.infer<typeof ModelOutput> & {
  text: string;
  characterCount: number;
  scheduledFor: string;
};

const MAX_CHARS = 1300; // stays above LinkedIn's "see more" fold on most posts

const SYSTEM = `You are EchoSocial, a LinkedIn copywriter for small businesses.
Write one LinkedIn company-page post for the business described below.
Rules:
- Write in the business's tone of voice and match the requested tone.
- Speak to the target audience's real day-to-day problem, then show how the business helps.
- Use only facts given about the business. Never invent prices, awards, statistics or customers.
- Hook, body and call to action together must stay under ${MAX_CHARS} characters.
- At most one emoji in the whole post. No bullet lists of more than three items.
- Hashtags: 3–6, specific to the audience and location, no generic ones like #business.
- Pick the best weekday and time for this audience to see the post.`;

export const echoSocial = defineAgent<EchoSocialInput, EchoSocialOutput>({
  slug: "echosocial",
  skillId: "linkedin.post",
  tier: "flash",
  inputSchema: EchoSocialInput,
  scrubFields: ["audience", "topic"],
  files: null,

  async run({ input, grounding }) {
    const brief = [
      groundingPrompt(grounding),
      "",
      `Brand website: ${input.brandUrl}`,
      `Target audience for this post: ${input.audience}`,
      `Tone for this post: ${input.tone}`,
      input.topic ? `What the post should be about: ${input.topic}` : "Topic: choose the most compelling offer from the products above.",
    ].join("\n");

    const res = await generateJson({ tier: "flash", system: SYSTEM, parts: [textPart(brief)], schema: ModelOutput, temperature: 0.8 });
    const d = res.data;
    const hashtags = d.hashtags.map((h) => h.replace(/^#/, "").replace(/\s+/g, ""));
    const text = `${d.hook}\n\n${d.body}\n\n${d.callToAction}\n\n${hashtags.map((h) => `#${h}`).join(" ")}`;

    return {
      ...res,
      output: {
        ...d,
        hashtags,
        text,
        characterCount: text.length,
        scheduledFor: nextOccurrence(d.bestTime.day, d.bestTime.time).toISOString(),
      },
    };
  },

  approval(output) {
    const when = new Date(output.scheduledFor).toLocaleString("en-GB", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return {
      title: "Your LinkedIn post is ready",
      preview: `“${output.hook}” · goes out ${when}`,
      severity: "info",
      actions: [
        { id: "approve", label: "Approve & schedule", kind: "approve" },
        { id: "edit", label: "Edit first", kind: "edit" },
        { id: "skip", label: "Skip", kind: "skip" },
      ],
    };
  },

  // LinkedIn's posting API needs partner approval, so publishing is simulated.
  async deliver(output) {
    return { channel: "linkedin", status: "scheduled", publishAt: output.scheduledFor, simulated: true };
  },
});

/** Next date (in server time) falling on `day` at `HH:MM`, at least one hour from now. */
function nextOccurrence(day: (typeof DAYS)[number], time: string): Date {
  const [h, m] = /^(\d{1,2}):(\d{2})$/.test(time) ? time.split(":").map(Number) : [8, 30];
  const target = (DAYS.indexOf(day) + 1) % 7; // JS: Sunday = 0
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(h, m);
  let add = (target - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() < Date.now() + 3_600_000) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}
