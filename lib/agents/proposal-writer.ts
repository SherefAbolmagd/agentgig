import { z } from "zod";
import { createEmailDraft, notDelivered, selfAddress, type Delivery } from "@/lib/connectors";
import { docsCreate } from "@/lib/connectors/google";
import { GatewayError } from "@/lib/errors";
import { filePart, generateJson, textPart } from "@/lib/vertex";
import { defineAgent, documentParts, groundingPrompt } from "./types";

/**
 * Proposal & Tender Writer: reads the buyer's brief (pasted or a PDF), lists
 * every requirement, and drafts a response that answers each one from the
 * owner's profile and documents. Gaps are flagged instead of invented.
 */

export const ProposalInput = z.object({
  brief: z.string().trim().max(20_000).default(""),
  buyer: z.string().trim().max(120).optional(),
  deadline: z.iso.date().optional(),
  wordLimit: z.number().int().min(200).max(10_000).optional(),
});
export type ProposalInput = z.infer<typeof ProposalInput>;

const ModelOutput = z.object({
  title: z.string(),
  requirements: z
    .array(
      z.object({
        requirement: z.string().describe("What the buyer asked for, in their words"),
        status: z.enum(["covered", "partly", "gap"]).describe("Whether the business's own information lets you answer it"),
        answeredIn: z.string().describe("Heading of the section that answers it, or empty"),
      }),
    )
    .min(1),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })).min(2).max(12),
  questionsForOwner: z.array(z.string()).max(8).describe("Facts you need from the owner to close the gaps"),
});

export type ProposalOutput = z.infer<typeof ModelOutput> & { buyer: string | null; deadline: string | null; wordCount: number; wordLimit: number | null; gaps: number };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function proposalHtml(p: ProposalOutput): string {
  const sections = p.sections.map((s) => `<h2>${esc(s.heading)}</h2>${s.body.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`).join("")}`).join("");
  const checklist = `<h2>Requirements checklist (delete before sending)</h2><ul>${p.requirements.map((r) => `<li>[${r.status.toUpperCase()}] ${esc(r.requirement)}${r.answeredIn ? ` → ${esc(r.answeredIn)}` : ""}</li>`).join("")}</ul>`;
  const questions = p.questionsForOwner.length ? `<h2>Questions for you (delete before sending)</h2><ul>${p.questionsForOwner.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : "";
  return `<html><body><h1>${esc(p.title)}</h1>${p.buyer ? `<p>Prepared for ${esc(p.buyer)}</p>` : ""}${sections}${checklist}${questions}</body></html>`;
}

export const proposalWriter = defineAgent<ProposalInput, ProposalOutput>({
  slug: "proposal-writer",
  skillId: "proposal.draft",
  tier: "pro",
  inputSchema: ProposalInput,
  scrubFields: ["brief"],
  files: { required: false, mimeTypes: ["application/pdf", "text/plain", "text/markdown"], maxBytes: 15 * 1024 * 1024 },

  async run({ input, files, grounding }) {
    const doc = files[0];
    if (!doc && input.brief.length < 30) throw new GatewayError("INVALID_INPUT", "Paste the brief or attach the tender document.");
    const res = await generateJson({
      tier: "pro",
      system: [
        "You write proposals and tender responses for a small business.",
        "First list every requirement, question and scoring criterion in the brief. Then write a response that answers each one, in the buyer's order, using only facts from the business profile and company documents.",
        "Where the business's information doesn't cover a requirement, mark it as a gap, write a clearly marked placeholder like [ADD: your insurance cover] in the text, and ask the owner for it. Never invent credentials, clients, figures or certifications.",
        input.wordLimit ? `Keep the whole response under ${input.wordLimit} words.` : "Be concise; buyers skim.",
      ].join(" "),
      parts: [
        ...documentParts(grounding),
        textPart(groundingPrompt(grounding)),
        ...(doc ? [textPart(`The buyer's brief (${doc.name}):`), doc.mimeType === "application/pdf" ? filePart(doc.data, doc.mimeType) : textPart(doc.data.toString("utf8").slice(0, 60_000))] : []),
        ...(input.brief ? [textPart(`Brief${doc ? " notes" : ""}:\n"""${input.brief}"""`)] : []),
        textPart(`${input.buyer ? `Buyer: ${input.buyer}. ` : ""}${input.deadline ? `Deadline: ${input.deadline}.` : ""}`),
      ],
      schema: ModelOutput,
      temperature: 0.4,
      thinkingBudget: 2048,
    });
    const wordCount = res.data.sections.reduce((n, s) => n + s.body.split(/\s+/).filter(Boolean).length, 0);
    const gaps = res.data.requirements.filter((r) => r.status !== "covered").length;
    return {
      ...res,
      output: { ...res.data, buyer: input.buyer ?? null, deadline: input.deadline ?? null, wordCount, wordLimit: input.wordLimit ?? null, gaps },
      notes: [`${res.data.requirements.length} requirements found; ${gaps} need your input`],
    };
  },

  approval(o) {
    return {
      title: `Proposal drafted: ${o.title}`,
      preview: o.gaps ? `${o.gaps} requirement${o.gaps > 1 ? "s need" : " needs"} facts from you before it's ready.` : `${o.wordCount} words, every requirement answered.`,
      severity: o.gaps ? "check" : "info",
      actions: [
        { id: "approve", label: "Save as a Google Doc", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    const doc = await docsCreate(userId, `${o.title}${o.buyer ? ` — ${o.buyer}` : ""}`, proposalHtml(o));
    if (!doc) {
      // Outlook users get the text as a draft to themselves instead of a Google Doc.
      const text = [o.title, ...o.sections.map((s) => `\n${s.heading}\n\n${s.body}`), "\nRequirements checklist (delete before sending):", ...o.requirements.map((r) => `[${r.status.toUpperCase()}] ${r.requirement}`)].join("\n");
      const draft = await createEmailDraft(userId, { to: await selfAddress(userId), subject: `Proposal draft: ${o.title}`, body: text });
      if (draft) return { delivered: true, summary: `Proposal saved as a draft to yourself in ${draft.app}`, links: [{ label: "Open draft", url: draft.url }] };
      return notDelivered("Proposal ready. Connect Google to get it as a Google Doc, or Microsoft 365 to get it by email.");
    }
    return { delivered: true, summary: "Saved as a Google Doc in your Drive, with the checklist at the end.", links: [{ label: "Open the doc", url: doc.url }] };
  },
});
