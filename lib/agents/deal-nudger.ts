import { z } from "zod";
import { crmAddNote, crmOpenDeals, type CrmSystem } from "@/lib/connectors/crm";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { deliverDrafts, type DraftEmail } from "./drafts";
import { defineAgent, documentParts, groundingPrompt } from "./types";

/** Deal Nudger: finds open deals that have gone quiet in Pipedrive or Zoho CRM and drafts the next-step email for each. */

export const DealInput = z.object({
  quietDays: z.number().int().min(3).max(120).default(14),
  maxDeals: z.number().int().min(1).max(20).default(10),
});
export type DealInput = z.infer<typeof DealInput>;

const ModelOutput = z.object({
  nudges: z.array(z.object({ ref: z.number().int(), nextStep: z.string().describe("What the owner should do, one sentence"), subject: z.string(), body: z.string() })),
});

export type DealOutput = {
  system: CrmSystem;
  totalOpen: number;
  deals: { id: string; title: string; stage: string | null; value: number | null; currency: string | null; company: string | null; daysQuiet: number; url: string; nextStep: string | null; hasEmail: boolean }[];
  emails: (DraftEmail & { dealId: string })[];
};

export const dealNudger = defineAgent<DealInput, DealOutput>({
  slug: "deal-nudger",
  skillId: "deals.nudge",
  tier: "flash",
  inputSchema: DealInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding, userId }) {
    const found = await crmOpenDeals(userId);
    if (!found) throw new GatewayError("INVALID_INPUT", "Connect Pipedrive or Zoho CRM so Deal Nudger can see your deals.");
    const today = Date.now();
    const quiet = found.deals
      .map((d) => ({ ...d, daysQuiet: Math.floor((today - Date.parse(d.lastActivity)) / 86_400_000) }))
      .filter((d) => d.daysQuiet >= input.quietDays)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || b.daysQuiet - a.daysQuiet)
      .slice(0, input.maxDeals);
    const view = quiet.map((d) => ({ id: d.id, title: d.title, stage: d.stage, value: d.value, currency: d.currency, company: d.company, daysQuiet: d.daysQuiet, url: d.url, nextStep: null as string | null, hasEmail: !!d.contactEmail }));
    if (!quiet.length) return { output: { system: found.system, totalOpen: found.deals.length, deals: [], emails: [] }, model: "rules", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };

    const res = await generateJson({
      tier: "flash",
      system: [
        "You help a small business owner restart sales conversations that have gone quiet. For each deal, suggest the single most useful next step, then write a short email (50–100 words) to the contact that moves it forward:",
        "reference where things were (the stage), offer something genuinely useful or a simple question, and make replying easy. No guilt-tripping, no fake urgency, no invented discounts. Sign off with the business name.",
      ].join(" "),
      parts: [
        ...documentParts(grounding),
        textPart(
          `${groundingPrompt(grounding)}\n\nQuiet deals:\n${quiet
            .map((d, ref) => `ref ${ref}: "${d.title}" with ${d.contactName?.split(" ")[0] ?? "the contact"} at ${d.company ?? "their company"}; stage ${d.stage ?? "unknown"}; ${d.value ? `worth ${d.value}${d.currency ? ` ${d.currency}` : ""}; ` : ""}no activity for ${d.daysQuiet} days`)
            .join("\n")}`,
        ),
      ],
      schema: ModelOutput,
      temperature: 0.5,
      thinkingBudget: 0,
    });
    const emails: DealOutput["emails"] = [];
    for (const n of res.data.nudges) {
      const d = quiet[n.ref];
      if (!d) continue;
      view[n.ref].nextStep = n.nextStep;
      if (d.contactEmail) emails.push({ to: d.contactEmail, subject: n.subject, body: n.body, label: `${d.contactName ?? d.company ?? "Contact"} · ${d.title}`, dealId: d.id });
    }
    return { ...res, output: { system: found.system, totalOpen: found.deals.length, deals: view, emails }, notes: [`${quiet.length} of ${found.deals.length} open deals quiet for ${input.quietDays}+ days in ${found.system}`] };
  },

  approval(o) {
    const noEmail = o.deals.filter((d) => !d.hasEmail).length;
    return {
      title: o.deals.length ? `${o.deals.length} quiet deal${o.deals.length > 1 ? "s" : ""}, ${o.emails.length} nudge${o.emails.length === 1 ? "" : "s"} drafted` : "No deals have gone quiet",
      preview: noEmail ? `${noEmail} deal${noEmail > 1 ? "s have" : " has"} no contact email in ${o.system}.` : o.deals.map((d) => d.title).slice(0, 3).join(", "),
      severity: "info",
      actions: [
        { id: "approve", label: `Save drafts and log in ${o.system}`, kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }) {
    const result = await deliverDrafts(userId, o.emails, "deal follow-ups");
    if (result.delivered) for (const e of o.emails) await crmAddNote(userId, o.system, { kind: "deal", id: e.dealId }, `AgentGig drafted a follow-up email: “${e.subject}”`).catch(() => false);
    return result;
  },
});
