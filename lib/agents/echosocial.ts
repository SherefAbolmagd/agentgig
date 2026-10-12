import { z } from "zod";
import { generateJson, textPart } from "@/lib/vertex";
import { getConnection, linkedinPost, simulated, type Delivery } from "@/lib/connectors";
import { defineAgent, documentParts, groundingPrompt } from "./types";

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
  timeZone: string;
};

const MAX_CHARS = 1300; // stays above LinkedIn's "see more" fold on most posts

const SYSTEM = `You are EchoSocial, a LinkedIn copywriter for small businesses.
Write one LinkedIn company-page post for the business described below.
Rules:
- Write in the business's tone of voice and match the requested tone.
- Speak to the target audience's real day-to-day problem, then show how the business helps.
- Use only facts given about the business and its documents. Never invent products, features, materials, prices, awards, statistics or customers. If a detail isn't given, leave it out.
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
  editableField: "text",
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

    const res = await generateJson({ tier: "flash", system: SYSTEM, parts: [...documentParts(grounding), textPart(brief)], schema: ModelOutput, temperature: 0.6, thinkingBudget: 0 });
    const d = res.data;
    const timeZone = grounding.profile?.timeZone ?? DEFAULT_TIME_ZONE;
    const hashtags = d.hashtags.map((h) => h.replace(/^#/, "").replace(/\s+/g, ""));
    const text = `${d.hook}\n\n${d.body}\n\n${d.callToAction}\n\n${hashtags.map((h) => `#${h}`).join(" ")}`;

    return {
      ...res,
      output: {
        ...d,
        hashtags,
        text,
        characterCount: text.length,
        timeZone,
        scheduledFor: nextOccurrence(d.bestTime.day, d.bestTime.time, timeZone).toISOString(),
      },
    };
  },

  approval(output) {
    const when = new Date(output.scheduledFor).toLocaleString("en-GB", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: output.timeZone,
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

  // LinkedIn's API can't schedule, so a future post becomes a Cloud Task that publishes at that time.
  async deliver(output, { userId, taskId }): Promise<Delivery> {
    if (!(await getConnection(userId, "linkedin"))) {
      return simulated("Post approved. Connect LinkedIn so EchoSocial can publish it for you.");
    }
    const at = new Date(output.scheduledFor);
    if (at.getTime() > Date.now() + 2 * 60_000) {
      // Imported lazily: triggers → pipeline → agents would be a circular import at load time.
      const { schedulePublish } = await import("@/lib/triggers");
      await schedulePublish(taskId, userId, at);
      const when = at.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: output.timeZone });
      return { simulated: false, summary: `Scheduled to post on LinkedIn ${when}`, scheduledFor: output.scheduledFor };
    }
    const post = await linkedinPost(userId, output.text);
    return { simulated: false, summary: "Posted on LinkedIn", links: post ? [{ label: "View post", url: post.url }] : [] };
  },
});

const DEFAULT_TIME_ZONE = "Europe/London";

/** Next `day` at `HH:MM` in the business's time zone, at least one hour from now. */
export function nextOccurrence(day: (typeof DAYS)[number], time: string, timeZone: string, now = new Date()): Date {
  const [h, m] = /^(\d{1,2}):(\d{2})$/.test(time) ? time.split(":").map(Number) : [8, 30];
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const today = DAYS.indexOf(parts.weekday as (typeof DAYS)[number]);
  let add = (DAYS.indexOf(day) - today + 7) % 7;
  for (let attempt = 0; attempt < 2; attempt++, add += 7) {
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + add, h, m);
    const utc = wall - zoneOffsetMs(wall, timeZone);
    if (utc >= now.getTime() + 3_600_000) return new Date(utc);
  }
  return new Date(now.getTime() + 7 * 86_400_000);
}

/** How far `timeZone` is ahead of UTC at the given instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instant;
}
