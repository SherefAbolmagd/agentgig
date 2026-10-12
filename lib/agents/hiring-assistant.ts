import { z } from "zod";
import { GatewayError } from "@/lib/errors";
import { filePart, generateJson, textPart } from "@/lib/vertex";
import { defineAgent, groundingPrompt } from "./types";

/**
 * Hiring Assistant: writes a job advert, or checks one CV against the owner's
 * must-haves with quoted evidence. It never rejects anyone: the owner decides.
 */

export const HiringInput = z.object({
  mode: z.enum(["advert", "screen"]),
  role: z.string().trim().min(2).max(120),
  mustHaves: z.string().trim().min(3).max(2000),
  niceToHaves: z.string().trim().max(2000).optional(),
  /** Pay, hours, location, start date and so on. */
  details: z.string().trim().max(2000).optional(),
});
export type HiringInput = z.infer<typeof HiringInput>;

const Advert = z.object({
  title: z.string(),
  summary: z.string(),
  responsibilities: z.array(z.string()).min(3).max(8),
  requirements: z.array(z.string()).min(1).max(8),
  niceToHave: z.array(z.string()).max(6),
  offer: z.array(z.string()).max(8).describe("Pay, hours, benefits; only what was given"),
  howToApply: z.string(),
  languageNotes: z.array(z.string()).max(5).describe("Wording in the brief that could put off or exclude applicants, and what you used instead"),
});

const Screen = z.object({
  candidateLabel: z.string().describe("First name and current role, e.g. 'Priya, barista at Pret'"),
  criteria: z
    .array(
      z.object({
        criterion: z.string(),
        mustHave: z.boolean(),
        met: z.enum(["yes", "partly", "no", "unclear"]),
        evidence: z.string().describe("Short quote or fact from the CV, or 'Not mentioned'"),
      }),
    )
    .min(1),
  strengths: z.array(z.string()).max(4),
  interviewQuestions: z.array(z.string()).min(2).max(6).describe("Questions that would settle the unclear or partly-met points"),
});

export type HiringOutput =
  | ({ mode: "advert"; role: string } & z.infer<typeof Advert>)
  | ({ mode: "screen"; role: string; mustHavesMet: number; mustHavesTotal: number; suggestion: string } & z.infer<typeof Screen>);

/** A suggestion, never a verdict. Unclear counts as "check", not "no". */
export function screenSuggestion(criteria: { mustHave: boolean; met: string }[]): { met: number; total: number; suggestion: string } {
  const must = criteria.filter((c) => c.mustHave);
  const met = must.filter((c) => c.met === "yes").length;
  const missing = must.filter((c) => c.met === "no").length;
  const suggestion = missing === 0 && met === must.length ? "Worth a call" : missing === 0 ? "Worth a call, check the unclear points" : "Check the gaps before deciding";
  return { met, total: must.length, suggestion };
}

export const hiringAssistant = defineAgent<HiringInput, HiringOutput>({
  slug: "hiring-assistant",
  skillId: "hiring.assist",
  tier: "flash",
  inputSchema: HiringInput,
  scrubFields: ["details"],
  files: { required: false, mimeTypes: ["application/pdf", "text/plain"], maxBytes: 5 * 1024 * 1024 },

  async run({ input, files, grounding }) {
    const brief = `Role: ${input.role}\nMust-haves:\n${input.mustHaves}${input.niceToHaves ? `\nNice to have:\n${input.niceToHaves}` : ""}${input.details ? `\nDetails: ${input.details}` : ""}`;
    if (input.mode === "advert") {
      const res = await generateJson({
        tier: "flash",
        system:
          "Write a clear, friendly job advert for a small business. Plain English, inclusive language, no jargon. Requirements are only the must-haves given; don't add degree or years-of-experience requirements that weren't asked for. Only state pay and benefits that were given.",
        parts: [textPart(`${groundingPrompt(grounding)}\n\n${brief}`)],
        schema: Advert,
        temperature: 0.5,
        thinkingBudget: 0,
      });
      return { ...res, output: { mode: "advert", role: input.role, ...res.data } };
    }
    const cv = files[0];
    if (!cv) throw new GatewayError("INVALID_INPUT", "Attach the CV (PDF or text) to check it.");
    const res = await generateJson({
      tier: "flash",
      system: [
        "Check a CV against a small business's hiring criteria. List every must-have and nice-to-have as a criterion and judge each one only on what the CV says, quoting short evidence.",
        "Use 'unclear' when the CV doesn't say, never 'no'. Ignore age, gender, ethnicity, nationality, religion, disability, marital status, photos and gaps in employment: they must not affect any judgement.",
      ].join(" "),
      parts: [textPart(brief), textPart(`CV (${cv.name}):`), cv.mimeType === "application/pdf" ? filePart(cv.data, cv.mimeType) : textPart(cv.data.toString("utf8").slice(0, 40_000))],
      schema: Screen,
      temperature: 0.1,
      thinkingBudget: 1024,
    });
    const s = screenSuggestion(res.data.criteria);
    return { ...res, output: { mode: "screen", role: input.role, ...res.data, mustHavesMet: s.met, mustHavesTotal: s.total, suggestion: s.suggestion } };
  },

  approval(o) {
    if (o.mode === "advert") {
      return { title: `Job advert ready: ${o.title}`, preview: o.summary, severity: "info", actions: [{ id: "approve", label: "Done", kind: "approve" }] };
    }
    return {
      title: `${o.candidateLabel}: ${o.mustHavesMet} of ${o.mustHavesTotal} must-haves clearly met`,
      preview: o.suggestion,
      severity: "info",
      actions: [{ id: "approve", label: "Done", kind: "approve" }],
    };
  },

  async deliver(o) {
    return { delivered: true, summary: o.mode === "advert" ? "Advert ready to copy into your job board" : "CV check ready. The decision is yours." };
  },
});
