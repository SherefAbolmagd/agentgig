import { z } from "zod";
import { deliverEmail, emailSummary, notDelivered, slackPost, type Delivery } from "@/lib/connectors";
import { EmailSource, reSubject } from "./drafts";
import { keyFields } from "@/lib/connectors/keys";
import { storeFindOrders } from "@/lib/connectors/store";
import { stripeFindPayment, stripeRefund, type RefundablePayment } from "@/lib/connectors/stripe-data";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, documentParts, groundingPrompt } from "./types";

/**
 * Order Desk: answers "where's my order?" from real Shopify or WooCommerce
 * orders, and handles refund requests: it finds the payment in Stripe and
 * refunds only after the owner approves, never more than was paid.
 */

export const OrderDeskInput = z.object({
  question: z.string().trim().min(2).max(2000),
  orderNumber: z.string().trim().max(30).optional(),
  /** Used only to look the order and payment up; never sent to the model. */
  customerEmail: z.email().optional(),
  slack: z.object({ channel: z.string(), ts: z.string() }).optional(),
  /** Set when the question arrived by email: the reply goes in that thread. */
  email: EmailSource.optional(),
});
export type OrderDeskInput = z.infer<typeof OrderDeskInput>;

const ModelOutput = z.object({
  reply: z.string().describe("Reply to the customer, 2–4 sentences, using only the order facts given"),
  refundRequested: z.boolean().describe("True when the customer asks for their money back (damaged, faulty or wrong item, or a cancellation)"),
  refundLines: z.array(z.number().int()).describe("Indexes of the order lines to refund; empty means the whole order"),
  needsHuman: z.boolean().describe("True for anything you can't settle from the facts: missing parcels past the expected date, complaints, a refund with no payment to refund"),
  reason: z.string().describe("One line for the owner: what the customer wants"),
});

export interface PlannedRefund {
  chargeId: string;
  amount: number;
  currency: string;
  items: string[];
  dashboardUrl: string | null;
}

export type OrderDeskOutput = Omit<z.infer<typeof ModelOutput>, "refundLines"> & {
  found: number;
  orderSummary: string | null;
  refund?: PlannedRefund;
  slack?: { channel: string; ts: string };
  email?: EmailSource & { to: string };
};

export const money = (amount: number, currency: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(amount);

export const orderDesk = defineAgent<OrderDeskInput, OrderDeskOutput>({
  slug: "order-desk",
  skillId: "order.status",
  tier: "flash",
  inputSchema: OrderDeskInput,
  scrubFields: ["question"],
  editableField: "reply",
  files: null,

  async run({ input, grounding, userId }) {
    const orderNumber = input.orderNumber ?? input.question.match(/#?\b(\d{3,10})\b/)?.[1];
    const lookup = await storeFindOrders(userId, { orderNumber, email: input.customerEmail });
    if (!lookup) throw new GatewayError("INVALID_INPUT", "Connect Shopify or WooCommerce so Order Desk can look orders up.");
    const o = lookup.orders[0];
    // The payment a refund would go back to (Stripe connected, and we know who's asking).
    const payment: RefundablePayment | null = o && input.customerEmail ? await stripeFindPayment(userId, { email: input.customerEmail, orderNumber: o.number }).catch(() => null) : null;
    const lines = o?.lines ?? [];
    const facts = o
      ? [
          `Order ${o.number} placed ${o.createdAt.slice(0, 10)}`,
          `Payment: ${o.paymentStatus}. Fulfilment: ${o.fulfilmentStatus}.`,
          lines.length ? `Lines:\n${lines.map((l, i) => `  ${i}: ${l.quantity} × ${l.name} at ${l.unitPrice} ${o.currency} each`).join("\n")}` : `Items: ${o.items.join("; ")}.`,
          `Total ${o.total} ${o.currency}.`,
          o.tracking.length ? `Tracking: ${o.tracking.map((t) => `${t.company ?? "carrier"} ${t.number ?? ""} ${t.url ?? ""}`).join("; ")}` : "No tracking number yet.",
          payment
            ? `Refunds: possible. The card payment can be refunded up to ${payment.refundable} ${payment.currency.toUpperCase()}. If the customer asks for one, write the reply as if the refund has been made (it is only sent once the owner has refunded it), saying it reaches their card in 5–10 working days.`
            : "Refunds: no card payment found to refund, so never say a refund has been made.",
        ].join("\n")
      : "No matching order was found.";
    const res = await generateJson({
      tier: "flash",
      system:
        "You answer customer emails about their order for a small online shop. Use only the order facts given. If no order was found, ask for the order number politely. Never promise refunds, dates or compensation that aren't in the facts. Sign off with the business name.",
      parts: [...documentParts(grounding), textPart(`${groundingPrompt(grounding)}\n\nOrder facts (from ${lookup.source}):\n${facts}\n\nCustomer wrote:\n"""${input.question}"""`)],
      schema: ModelOutput,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    const { refundLines, ...answer } = res.data;
    let refund: PlannedRefund | undefined;
    if (answer.refundRequested && o && payment) {
      // Code works out the amount: the chosen lines (or the whole order), never more than was paid.
      const picked = refundLines.filter((i) => lines[i]).map((i) => lines[i]);
      const itemsTotal = picked.length ? picked.reduce((t, l) => t + l.quantity * l.unitPrice, 0) : o.total;
      const amount = Math.round(Math.min(itemsTotal, o.total, payment.refundable) * 100) / 100;
      const test = (await keyFields(userId, "stripe"))?.conn.meta?.mode === "test";
      refund = {
        chargeId: payment.chargeId,
        amount,
        currency: payment.currency,
        items: picked.length ? picked.map((l) => `${l.quantity} × ${l.name}`) : o.items,
        dashboardUrl: payment.paymentIntentId ? `https://dashboard.stripe.com/${test ? "test/" : ""}payments/${payment.paymentIntentId}` : null,
      };
    } else if (answer.refundRequested) {
      answer.needsHuman = true;
      answer.reason = `${answer.reason} No card payment was found to refund.`;
    }
    return {
      ...res,
      output: {
        ...answer,
        found: lookup.orders.length,
        orderSummary: o ? facts : null,
        ...(refund && { refund }),
        ...(input.slack && { slack: input.slack }),
        ...(input.email && input.customerEmail && { email: { ...input.email, to: input.customerEmail } }),
      },
      notes: [o ? `Found order ${o.number} in ${lookup.source}` : `No matching order in ${lookup.source}`, ...(refund ? [`Refund of ${money(refund.amount, refund.currency)} planned`] : [])],
    };
  },

  approval(o) {
    const who = o.email?.fromName ?? "A customer";
    if (o.refund) {
      const amount = money(o.refund.amount, o.refund.currency);
      return {
        title: `${who} asked for a refund: ${amount}`,
        preview: `${o.reason}\nRefund ${amount} in Stripe for ${o.refund.items.join(", ")}, then reply:\n“${o.reply.slice(0, 160)}”`,
        severity: "check",
        actions: [
          { id: "approve", label: `Refund ${amount} and reply`, kind: "approve" },
          { id: "edit", label: "Edit reply first", kind: "edit" },
          { id: "skip", label: "I'll handle it", kind: "skip" },
        ],
      };
    }
    return {
      title: o.needsHuman ? `${o.email ? `${who} emailed: ` : ""}an order question needs you` : o.email ? `${who} emailed about an order. Reply ready` : "Order reply ready",
      preview: o.needsHuman ? o.reason : `“${o.reply.slice(0, 140)}”`,
      severity: o.needsHuman ? "check" : "info",
      actions: [
        { id: "approve", label: "Send reply", kind: "approve" },
        { id: "edit", label: "Edit first", kind: "edit" },
        { id: "skip", label: "I'll handle it", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId, taskId }): Promise<Delivery> {
    const links: { label: string; url: string }[] = [];
    let refunded = "";
    if (o.refund) {
      // Keyed by task, so an approval retried after a timeout can't refund twice.
      const r = await stripeRefund(userId, o.refund.chargeId, o.refund.amount, `refund-${taskId}`);
      if (!r) return notDelivered("Connect Stripe so Order Desk can make the refund.");
      refunded = `Refunded ${money(r.amount, o.refund.currency)} in Stripe. `;
      if (o.refund.dashboardUrl) links.push({ label: "Refund in Stripe", url: o.refund.dashboardUrl });
    }
    if (o.slack) {
      const posted = await slackPost(userId, { channel: o.slack.channel, threadTs: o.slack.ts, text: o.reply });
      if (posted) return { delivered: true, summary: `${refunded}Replied in the Slack thread`, links: [...links, ...(posted.url ? [{ label: "Open in Slack", url: posted.url }] : [])] };
    }
    if (o.email) {
      const mail = await deliverEmail(userId, { to: o.email.to, subject: reSubject(o.email.subject), body: o.reply, replyTo: o.email });
      if (mail) return { delivered: true, summary: `${refunded}${emailSummary([mail], "reply")}`, links: [...links, { label: mail.sent ? "Open sent reply" : "Open draft", url: mail.url }] };
    }
    return refunded ? { delivered: true, summary: `${refunded}Copy the reply from the result.`, links } : notDelivered("Reply ready to send. Copy it from the result.");
  },
});
