import type { Part } from "@google/genai";
import type { z } from "zod";
import { filePart, textPart, type GenerateJsonResult, type ModelTier } from "@/lib/vertex";
import type { Delivery } from "@/lib/connectors";
import type { ApprovalAction, ApprovalDoc, BusinessProfile } from "@/types/firestore";

export interface UploadedFile {
  name: string;
  mimeType: string;
  data: Buffer;
}

/** Company knowledge attached by the gateway's Ground step. */
export interface Grounding {
  businessName: string;
  profile: BusinessProfile | null;
  styleExamples: { draft: string; edited: string }[];
  /** Company knowledge files the owner shared with this agent. */
  documents: UploadedFile[];
}

/** Knowledge files as model parts: text files inline, PDFs as documents. */
export function documentParts(g: Grounding): Part[] {
  return g.documents.flatMap((d) =>
    d.mimeType === "application/pdf"
      ? [textPart(`Company document “${d.name}”:`), filePart(d.data, d.mimeType)]
      : [textPart(`Company document “${d.name}”:\n${d.data.toString("utf8")}`)],
  );
}

export interface AgentRunContext<I> {
  taskId: string;
  userId: string;
  input: I;
  files: UploadedFile[];
  grounding: Grounding;
}

export type AgentRunResult<O> = Omit<GenerateJsonResult<unknown>, "data"> & {
  output: O;
  /** Extra lines for the task log, e.g. what was handed over from another agent. */
  notes?: string[];
};

export type ApprovalDraft = Pick<ApprovalDoc, "title" | "preview" | "severity"> & { actions: ApprovalAction[] };

/**
 * A native agent: a TypeScript handler the gateway calls in its Run step.
 * Agents return results only; side effects happen in `deliver`, which the
 * gateway calls after charging (immediately, or once the owner approves).
 */
export interface NativeAgent<I extends Record<string, unknown>, O extends Record<string, unknown>> {
  slug: string;
  skillId: string;
  tier: ModelTier;
  inputSchema: z.ZodType<I>;
  /** Text inputs the Scrub step de-identifies before the run. */
  scrubFields: readonly (keyof I & string)[];
  files: { required: boolean; mimeTypes: readonly string[]; maxBytes: number } | null;
  run(ctx: AgentRunContext<I>): Promise<AgentRunResult<O>>;
  approval(output: O): ApprovalDraft;
  /** Performs the real-world action. Simulated for the hackathon. */
  deliver(output: O, ctx: { userId: string; taskId: string }): Promise<Delivery>;
  /** Output field the owner can edit before approving (e.g. the post text). */
  editableField?: keyof O & string;
}

export type AnyNativeAgent = NativeAgent<Record<string, unknown>, Record<string, unknown>>;

export function defineAgent<I extends Record<string, unknown>, O extends Record<string, unknown>>(
  agent: NativeAgent<I, O>,
): AnyNativeAgent {
  return agent as unknown as AnyNativeAgent;
}

/** Renders the grounding block shared by every native agent's prompt. */
export function groundingPrompt(g: Grounding): string {
  const p = g.profile;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: p?.timeZone ?? "Europe/London" });
  const weekday = new Date().toLocaleDateString("en-GB", { weekday: "long", timeZone: p?.timeZone ?? "Europe/London" });
  const lines = [
    `Today is ${weekday} ${today}. Resolve relative dates ("Friday", "next week") from this.`,
    "Never invent contact details (email addresses, phone numbers, postal addresses, links). If one is needed and not given, write a placeholder like [ADD: email to apply].",
    `Business: ${g.businessName}`,
  ];
  if (p) {
    lines.push(
      `About: ${p.description}`,
      `Products and prices: ${p.products}`,
      `Audience: ${p.audience}`,
      `Tone of voice: ${p.toneOfVoice}`,
    );
    if (p.avoidWords.length) lines.push(`Never use these words: ${p.avoidWords.join(", ")}`);
    if (p.website) lines.push(`Website: ${p.website}`);
    if (p.location) lines.push(`Location: ${p.location}`);
    if (p.openingHours) lines.push(`Opening hours: ${p.openingHours}`);
  }
  if (g.documents.length) {
    lines.push(`Company documents attached below: ${g.documents.map((d) => d.name).join(", ")}. Treat them as facts about the business.`);
  }
  if (g.styleExamples.length) {
    lines.push("", "The owner edited earlier drafts like this. Follow their edits' style:");
    g.styleExamples.forEach((ex, i) => lines.push(`Example ${i + 1} draft: ${ex.draft}`, `Example ${i + 1} owner's version: ${ex.edited}`));
  }
  return lines.join("\n");
}
