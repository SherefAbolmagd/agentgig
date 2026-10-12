import { z } from "zod";
import { GatewayError } from "@/lib/errors";
import { filePart, generateJson, textPart } from "@/lib/vertex";
import { combine, deliverDrafts, deliverTasks } from "./drafts";
import { defineAgent, groundingPrompt } from "./types";

/** Meeting Notes to Actions: summary, decisions, owners and follow-up emails from rough notes. */

export const MeetingInput = z.object({
  notes: z.string().trim().max(30_000).default(""),
  meetingTitle: z.string().trim().max(120).optional(),
});
export type MeetingInput = z.infer<typeof MeetingInput>;

const ModelOutput = z.object({
  title: z.string(),
  summary: z.string().describe("Three to five sentences"),
  decisions: z.array(z.string()).max(10),
  actions: z.array(z.object({ owner: z.string().describe("Name, or 'Unassigned'"), task: z.string(), due: z.string().describe("YYYY-MM-DD if the notes give a date, else the timeframe in words, or 'Not set'") })).max(20),
  openQuestions: z.array(z.string()).max(8),
  followUps: z.array(z.object({ to: z.string().describe("Who it's for, by name"), subject: z.string(), body: z.string() })).max(6),
});

export type MeetingOutput = z.infer<typeof ModelOutput>;

export const meetingActions = defineAgent<MeetingInput, MeetingOutput>({
  slug: "meeting-actions",
  skillId: "meetings.actions",
  tier: "flash",
  inputSchema: MeetingInput,
  scrubFields: ["notes"],
  files: { required: false, mimeTypes: ["application/pdf", "text/plain", "text/markdown"], maxBytes: 10 * 1024 * 1024 },

  async run({ input, files, grounding }) {
    const doc = files[0];
    if (!doc && input.notes.length < 30) throw new GatewayError("INVALID_INPUT", "Paste the meeting notes or attach them as a file.");
    const res = await generateJson({
      tier: "flash",
      system: [
        "Turn rough meeting notes into a clear record for a small business owner: summary, decisions, actions with an owner and due date, and open questions.",
        "Only include what's in the notes; mark owners or dates as 'Unassigned' or 'Not set' rather than guessing.",
        "Then write a short follow-up email per external person or group who has actions or needs the decisions (up to 6), plus one recap for the team if there was a team.",
      ].join(" "),
      parts: [
        textPart(groundingPrompt(grounding)),
        ...(input.meetingTitle ? [textPart(`Meeting: ${input.meetingTitle}`)] : []),
        ...(doc ? [doc.mimeType === "application/pdf" ? filePart(doc.data, doc.mimeType) : textPart(doc.data.toString("utf8").slice(0, 60_000))] : []),
        ...(input.notes ? [textPart(`Notes:\n"""${input.notes}"""`)] : []),
      ],
      schema: ModelOutput,
      temperature: 0.2,
      thinkingBudget: 512,
    });
    return { ...res, output: res.data };
  },

  approval(o) {
    return {
      title: `${o.title}: ${o.actions.length} action${o.actions.length === 1 ? "" : "s"}, ${o.followUps.length} follow-up${o.followUps.length === 1 ? "" : "s"}`,
      preview: o.decisions[0] ?? o.summary.slice(0, 140),
      severity: "info",
      actions: [
        { id: "approve", label: "Save follow-ups and add actions to your task board", kind: "approve" },
        { id: "skip", label: "Just keep the notes", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }) {
    // Addresses aren't in the notes (they're removed before the run), so drafts have no recipient yet.
    const drafts = o.followUps.length ? await deliverDrafts(userId, o.followUps.map((f) => ({ to: null, subject: f.subject, body: f.body, label: f.to })), "follow-up emails") : null;
    const due = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
    const tasks = await deliverTasks(
      userId,
      o.actions.map((a) => ({ title: a.owner && a.owner !== "Unassigned" ? `${a.owner}: ${a.task}` : a.task, notes: `From “${o.title}”`, due: due(a.due) })),
    );
    return combine([drafts, tasks]);
  },
});
