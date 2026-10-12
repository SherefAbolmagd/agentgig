import { z } from "zod";
import { notDelivered, slackPost, type Delivery } from "@/lib/connectors";
import { storeFindOrders } from "@/lib/connectors/store";
import { GatewayError } from "@/lib/errors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, documentParts, groundingPrompt } from "./types";

/** Order Desk: answers "where's my order?" from real Shopify or WooCommerce orders. */

export const OrderDeskInput = z.object({
  question: z.string().trim().min(2).max(2000),
  orderNumber: z.string().trim().max(30).optional(),
  /** Used only to look the order up; never sent to the model. */
  customerEmail: z.email().optional(),
  slack: z.object({ channel: z.string(), ts: z.string() }).optional(),
});
export type OrderDeskInput = z.infer<typeof OrderDeskInput>;

const ModelOutput = z.object({
  reply: z.string().describe("Reply to the customer, 2–4 sentences, using only the order facts given"),
  needsHuman: z.boolean().describe("True for refunds, damage, missing parcels past the expected date, or anything not in the facts"),
  reason: z.string(),
});

export type OrderDeskOutput = z.infer<typeof ModelOutput> & { found: number; orderSummary: string | null; slack?: { channel: string; ts: string } };

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
    const facts = o
      ? [
          `Order ${o.number} placed ${o.createdAt.slice(0, 10)}`,
          `Payment: ${o.paymentStatus}. Fulfilment: ${o.fulfilmentStatus}.`,
          `Items: ${o.items.join("; ")}. Total ${o.total} ${o.currency}.`,
          o.tracking.length ? `Tracking: ${o.tracking.map((t) => `${t.company ?? "carrier"} ${t.number ?? ""} ${t.url ?? ""}`).join("; ")}` : "No tracking number yet.",
        ].join("\n")
      : "No matching order was found.";
    const res = await generateJson({
      tier: "flash",
      system:
        "You answer customer questions about their order for a small online shop. Use only the order facts given. If no order was found, ask for the order number politely. Never promise refunds, dates or compensation that aren't in the facts.",
      parts: [...documentParts(grounding), textPart(`${groundingPrompt(grounding)}\n\nOrder facts (from ${lookup.source}):\n${facts}\n\nCustomer asked:\n"""${input.question}"""`)],
      schema: ModelOutput,
      temperature: 0.3,
      thinkingBudget: 0,
    });
    return {
      ...res,
      output: { ...res.data, found: lookup.orders.length, orderSummary: o ? facts : null, ...(input.slack && { slack: input.slack }) },
      notes: [o ? `Found order ${o.number} in ${lookup.source}` : `No matching order in ${lookup.source}`],
    };
  },

  approval(o) {
    return {
      title: o.needsHuman ? "An order question needs you" : "Order reply ready",
      preview: o.needsHuman ? o.reason : `“${o.reply.slice(0, 140)}”`,
      severity: o.needsHuman ? "check" : "info",
      actions: [
        { id: "approve", label: "Send reply", kind: "approve" },
        { id: "edit", label: "Edit first", kind: "edit" },
        { id: "skip", label: "I'll handle it", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    if (o.slack) {
      const posted = await slackPost(userId, { channel: o.slack.channel, threadTs: o.slack.ts, text: o.reply });
      if (posted) return { delivered: true, summary: "Replied in the Slack thread", links: posted.url ? [{ label: "Open in Slack", url: posted.url }] : [] };
    }
    return notDelivered("Reply ready to send. Copy it from the result.");
  },
});
