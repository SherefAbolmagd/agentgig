import { z } from "zod";
import { deliverEmail, emailSummary, notDelivered, type Delivery } from "@/lib/connectors";
import { stripeFailedPayment, stripePaymentLink } from "@/lib/connectors/stripe-data";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { money } from "./order-desk";
import { defineAgent, groundingPrompt } from "./types";

/**
 * Payment Rescue: when a card is declined in Stripe, writes the customer a
 * kind note with a fresh link to pay. The link is made only once the owner
 * approves, so nothing reaches the customer before then.
 */

export const PaymentRescueInput = z.object({
  paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9]+$/),
});
export type PaymentRescueInput = z.infer<typeof PaymentRescueInput>;

const LINK = "[PAYMENT LINK]";

const ModelOutput = z.object({
  subject: z.string(),
  body: z.string().describe(`The email. Put ${LINK} on its own line where the payment link goes.`),
  ownerNote: z.string().describe("One line for the owner: who, how much, and why it failed"),
});

export type PaymentRescueOutput = {
  paymentIntentId: string;
  customerName: string | null;
  customerEmail: string | null;
  amount: number;
  currency: string;
  description: string;
  reason: string | null;
  subject: string;
  body: string;
  ownerNote: string;
  website: string | null;
};

export const paymentRescue = defineAgent<PaymentRescueInput, PaymentRescueOutput>({
  slug: "payment-rescue",
  skillId: "payments.rescue",
  tier: "flash",
  inputSchema: PaymentRescueInput,
  scrubFields: [],
  editableField: "body",
  files: null,

  async run({ input, grounding, userId }) {
    const p = await stripeFailedPayment(userId, input.paymentIntentId);
    if (!p) throw new GatewayError("INVALID_INPUT", "Connect Stripe so Payment Rescue can see failed payments.");
    if (!p.customerEmail) throw new GatewayError("INVALID_INPUT", "This payment has no customer email to write to.");
    const description = p.description ?? `Your ${grounding.businessName} order`;
    const res = await generateJson({
      tier: "flash",
      system: `Write a short, kind email to a customer whose card payment didn't go through. Never blame them or mention fraud; banks decline cards for ordinary reasons. Say what they were buying and the amount, and that they can try again with the link. Put ${LINK} on its own line where the link goes and say it works for 24 hours. Sign off with the business name. 60–100 words.`,
      parts: [
        textPart(
          `${groundingPrompt(grounding)}\n\nCustomer first name: ${p.customerName?.split(" ")[0] ?? "unknown"}\nWhat they were buying: ${description}\nAmount: ${money(p.amount, p.currency)}\nWhy it failed (from the bank): ${p.reason ?? "not given"}`,
        ),
      ],
      schema: ModelOutput,
      temperature: 0.4,
      thinkingBudget: 0,
    });
    return {
      ...res,
      output: {
        paymentIntentId: p.id,
        customerName: p.customerName,
        customerEmail: p.customerEmail,
        amount: p.amount,
        currency: p.currency,
        description,
        reason: p.reason,
        ...res.data,
        website: grounding.profile?.website ?? null,
      },
      notes: [`Failed payment ${p.id}: ${money(p.amount, p.currency)}`],
    };
  },

  approval(o) {
    const who = o.customerName ?? o.customerEmail ?? "A customer";
    return {
      title: `${who}'s card was declined (${money(o.amount, o.currency)})`,
      preview: `${o.ownerNote}\nEmail with a new payment link:\n“${o.body.replace(LINK, "[link]").slice(0, 160)}”`,
      severity: "info",
      actions: [
        { id: "approve", label: "Approve email with payment link", kind: "approve" },
        { id: "edit", label: "Edit first", kind: "edit" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId, taskId }): Promise<Delivery> {
    const url = await stripePaymentLink(
      userId,
      { amount: o.amount, currency: o.currency, description: o.description, email: o.customerEmail, returnUrl: o.website ?? "https://stripe.com" },
      `rescue-${taskId}`,
    );
    if (!url) return notDelivered("Connect Stripe so Payment Rescue can make a payment link.");
    const body = o.body.includes(LINK) ? o.body.replace(LINK, url) : `${o.body}\n\nPay here: ${url}`;
    const mail = await deliverEmail(userId, { to: o.customerEmail, subject: o.subject, body });
    if (!mail) return notDelivered("Connect Google or Microsoft 365 to email the customer.");
    return { delivered: true, summary: `Payment link made in Stripe. ${emailSummary([mail], "email")}`, links: [{ label: mail.sent ? "Open sent email" : "Open draft", url: mail.url }] };
  },
});
