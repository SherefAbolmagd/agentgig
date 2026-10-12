import { z } from "zod";
import { crmAddNote, crmNewLeads, type CrmSystem } from "@/lib/connectors/crm";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { deliverDrafts, type DraftEmail } from "./drafts";
import { defineAgent, documentParts, groundingPrompt } from "./types";

/** Lead Follow-up: a personal first email to each new lead in HubSpot, Pipedrive or Zoho CRM, plus a note on their record. */

export const LeadInput = z.object({ sinceDays: z.number().int().min(1).max(30).default(3) });
export type LeadInput = z.infer<typeof LeadInput>;

const ModelOutput = z.object({ emails: z.array(z.object({ ref: z.number().int(), subject: z.string(), body: z.string() })) });

export type LeadOutput = {
  system: CrmSystem;
  leads: { id: string; name: string; company: string | null; source: string | null; url: string }[];
  emails: (DraftEmail & { contactId: string })[];
};

export const leadFollowup = defineAgent<LeadInput, LeadOutput>({
  slug: "lead-followup",
  skillId: "leads.followup",
  tier: "flash",
  inputSchema: LeadInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    const found = await crmNewLeads(userId, input.sinceDays);
    if (!found) throw new GatewayError("INVALID_INPUT", "Connect HubSpot, Pipedrive or Zoho CRM so Lead Follow-up can see your new leads.");
    const leads = found.leads.filter((l) => l.email).slice(0, 15);
    const view = leads.map((l) => ({ id: l.id, name: `${l.firstName} ${l.lastName}`.trim() || "(no name)", company: l.company, source: l.source, url: l.url }));
    if (!leads.length) return { output: { system: found.system, leads: [], emails: [] }, model: "rules", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
    const res = await generateJson({
      tier: "flash",
      system:
        "Write a short, personal first follow-up email from a small business to each new lead (70–110 words). Reference what you know about them (company, role, what they wrote) and suggest one simple next step. Use only facts given. Sign off with the business name.",
      parts: [
        ...documentParts(grounding),
        textPart(`${groundingPrompt(grounding)}\n\nNew leads:\n${leads.map((l, ref) => `ref ${ref}: ${l.firstName} ${l.lastName}, ${l.jobTitle ?? "role unknown"} at ${l.company ?? "company unknown"}; came from ${l.source ?? "unknown"}${l.notes ? `; wrote: "${l.notes.slice(0, 300)}"` : ""}`).join("\n")}`),
      ],
      schema: ModelOutput,
      temperature: 0.5,
      thinkingBudget: 0,
    });
    const emails = res.data.emails.filter((e) => leads[e.ref]).map((e) => ({ to: leads[e.ref].email, subject: e.subject, body: e.body, label: view[e.ref].name, contactId: leads[e.ref].id }));
    return { ...res, output: { system: found.system, leads: view, emails }, notes: [`${leads.length} new leads in ${found.system} from the last ${input.sinceDays} days`] };
  },

  approval(o) {
    return {
      title: o.emails.length ? `${o.emails.length} lead follow-ups ready` : "No new leads",
      preview: o.leads.map((l) => l.name).slice(0, 4).join(", "),
      severity: "info",
      actions: [
        { id: "approve", label: `Save drafts and log in ${o.system ?? "your CRM"}`, kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }) {
    const result = await deliverDrafts(userId, o.emails, "follow-up emails");
    // Older results (HubSpot only) have no system field.
    const system = o.system ?? "HubSpot";
    if (result.delivered) for (const e of o.emails) await crmAddNote(userId, system, { kind: "lead", id: e.contactId }, `AgentGig drafted a follow-up email: “${e.subject}”`).catch(() => false);
    return result;
  },
});
