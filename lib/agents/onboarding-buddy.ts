import { z } from "zod";
import { createEmailDraft, notDelivered, type Delivery } from "@/lib/connectors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, documentParts, groundingPrompt } from "./types";

export const OnboardingInput = z.object({
  newHireName: z.string().trim().min(2).max(80),
  role: z.string().trim().min(2).max(80),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  managerName: z.string().trim().min(2).max(80),
  /** Used only to address the email draft; never sent to the model. */
  newHireEmail: z.email().optional(),
});
export type OnboardingInput = z.infer<typeof OnboardingInput>;

const ModelOutput = z.object({
  welcomeEmail: z.object({ subject: z.string(), body: z.string() }),
  firstWeek: z.array(z.object({ day: z.string(), task: z.string(), owner: z.enum(["new hire", "manager", "team"]) })).min(3),
  documentsToCollect: z.array(z.string()).describe("Right-to-work, bank details form, etc. Only what the business would need"),
  policyAnswers: z.array(z.object({ question: z.string(), answer: z.string() })).max(6).describe("Answers drawn only from the company documents; empty if none were given"),
});
export type OnboardingOutput = z.infer<typeof ModelOutput> & { newHireEmail: string | null; startDate: string };

const SYSTEM = `You are Onboarding Buddy for a small business. Write a warm welcome email to a new hire, a first-week checklist and a list of documents to collect.
- Use the company documents (handbook, policies) for facts like hours, dress code, breaks and holiday; never invent policies.
- If no documents were given, keep policy answers empty and keep the email general.`;

export const onboardingBuddy = defineAgent<OnboardingInput, OnboardingOutput>({
  slug: "onboarding-buddy",
  skillId: "docs.collect",
  tier: "flash",
  inputSchema: OnboardingInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding }) {
    const res = await generateJson({
      tier: "flash",
      system: SYSTEM,
      parts: [
        ...documentParts(grounding),
        textPart(`${groundingPrompt(grounding)}\n\nNew hire: ${input.newHireName}, ${input.role}. Starts ${input.startDate}. Manager: ${input.managerName}.`),
      ],
      schema: ModelOutput,
      temperature: 0.5,
      thinkingBudget: 0,
    });
    return { ...res, output: { ...res.data, newHireEmail: input.newHireEmail ?? null, startDate: input.startDate } };
  },

  approval(o) {
    return {
      title: "Welcome pack ready",
      preview: `“${o.welcomeEmail.subject}” · ${o.firstWeek.length} first-week tasks · ${o.documentsToCollect.length} documents to collect`,
      severity: "info",
      actions: [
        { id: "approve", label: "Save welcome email as a draft", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    const draft = await createEmailDraft(userId, { to: o.newHireEmail, subject: o.welcomeEmail.subject, body: o.welcomeEmail.body });
    if (!draft) return notDelivered("Welcome email ready. Connect Google or Microsoft 365 to save it as an email draft.");
    return { delivered: true, summary: `Welcome email saved as an ${draft.app} draft`, links: [{ label: "Open draft", url: draft.url }] };
  },
});
