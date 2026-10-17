import { z } from "zod";
import { storeLapsedCustomers } from "@/lib/connectors/store";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { deliverDrafts, type DraftEmail } from "./drafts";
import { defineAgent, groundingPrompt } from "./types";

/** Win-back: finds customers who stopped ordering and drafts a personal email to each. */

export const WinbackInput = z.object({
  inactiveDays: z.number().int().min(14).max(730).default(60),
  offer: z.string().trim().max(200).optional(),
  maxCustomers: z.number().int().min(1).max(25).default(10),
  /** Only customers who agreed to marketing emails. */
  subscribedOnly: z.boolean().default(true),
});
export type WinbackInput = z.infer<typeof WinbackInput>;

const ModelOutput = z.object({
  emails: z.array(z.object({ ref: z.number().int(), subject: z.string(), body: z.string() })),
});

export type WinbackOutput = {
  customers: { firstName: string; orders: number; spent: number; currency: string; lastOrderAt: string }[];
  emails: DraftEmail[];
  skippedNoConsent: number;
  source: string;
};

export const winback = defineAgent<WinbackInput, WinbackOutput>({
  slug: "winback",
  skillId: "customers.winback",
  tier: "flash",
  inputSchema: WinbackInput,
  scrubFields: ["offer"],
  files: null,

  async run({ input, grounding, userId }) {
    const found = await storeLapsedCustomers(userId, input.inactiveDays);
    if (!found) throw new GatewayError("INVALID_INPUT", "Connect Shopify or WooCommerce so Win-back can find past customers.");
    const eligible = found.customers.filter((c) => !input.subscribedOnly || c.marketingConsent);
    const picked = eligible.sort((a, b) => b.spent - a.spent).slice(0, input.maxCustomers);
    const summary = picked.map((c, i) => ({ ...c, ref: i }));
    if (!picked.length) {
      return {
        output: { customers: [], emails: [], skippedNoConsent: found.customers.length - eligible.length, source: found.source },
        model: "rules",
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    // The model sees first names and purchase history only; email addresses are added afterwards.
    const res = await generateJson({
      tier: "flash",
      system:
        "Write short, warm win-back emails from a small business to past customers, one per customer. These customers have NOT ordered since their last order date, which is well before today: acknowledge it's been a while (e.g. \"since the summer\"), and never suggest a recent or new order. Mention their history naturally (not the exact amount spent). Include the offer if one is given; never invent one. Sign off with the business name. 80–120 words each.",
      parts: [
        textPart(
          `${groundingPrompt(grounding)}\n${input.offer ? `Offer: ${input.offer}\n` : ""}\nCustomers:\n${summary
            .map((c) => `ref ${c.ref}: ${c.firstName || "there"}, ${c.orders} orders, last order ${c.lastOrderAt.slice(0, 10)}`)
            .join("\n")}`,
        ),
      ],
      schema: ModelOutput,
      temperature: 0.6,
      thinkingBudget: 0,
    });
    const emails = res.data.emails
      .filter((e) => summary[e.ref])
      .map((e) => ({ to: summary[e.ref].email, subject: e.subject, body: e.body, label: summary[e.ref].firstName || summary[e.ref].email }));
    return {
      ...res,
      output: {
        customers: picked.map(({ firstName, orders, spent, currency, lastOrderAt }) => ({ firstName, orders, spent, currency, lastOrderAt })),
        emails,
        skippedNoConsent: found.customers.length - eligible.length,
        source: found.source,
      },
      notes: [`Found ${found.customers.length} customers with no order in ${input.inactiveDays} days; ${picked.length} chosen`],
    };
  },

  approval(o) {
    return {
      title: o.emails.length ? `${o.emails.length} win-back emails ready` : "No lapsed customers to email",
      preview: o.emails.length ? `To ${o.emails.map((e) => e.label).slice(0, 4).join(", ")}${o.emails.length > 4 ? "…" : ""}` : "Nobody matched.",
      severity: "info",
      actions: [
        { id: "approve", label: "Save as email drafts", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  deliver: (o, { userId }) => deliverDrafts(userId, o.emails, "win-back emails"),
});
