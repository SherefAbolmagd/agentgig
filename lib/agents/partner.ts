import "server-only";
import { z } from "zod";
import { A2AError, resultData, sendMessage } from "@/lib/a2a/client";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { readSecret } from "@/lib/secrets";
import { COLLECTIONS, type AgentDoc, type TaskDoc } from "@/types/firestore";
import type { AnyNativeAgent, Grounding } from "./types";

/**
 * Wraps a partner's A2A endpoint so the gateway runs it exactly like a native
 * agent: same verify, reserve, scrub and charge steps.
 *
 * Partners get less than our own agents: the scrubbed task input, the business
 * name and (if ticked) profile, and whatever context their skill needs. Never
 * uploaded knowledge files, never OAuth tokens.
 */
export function partnerAgent(agent: AgentDoc, rawInput?: unknown): AnyNativeAgent {
  const skill = agent.skills[0];
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;

  return {
    slug: agent.slug,
    skillId: skill.id,
    tier: "flash",
    inputSchema: z.record(z.string(), z.unknown()) as unknown as AnyNativeAgent["inputSchema"],
    scrubFields: Object.keys(input).filter((k) => typeof input[k] === "string"),
    files: null,

    async run({ userId, input, grounding }) {
      if (!agent.endpointUrl) throw new GatewayError("AGENT_UNAVAILABLE", `${agent.name} isn't connected yet.`);
      const context = await HANDOFFS[skill.id]?.(userId, input);
      const apiKey = agent.auth ? { header: agent.auth.header, value: await readSecret(agent.auth.secretRef) } : undefined;

      const started = Date.now();
      try {
        const result = await sendMessage(
          agent.endpointUrl,
          [
            { kind: "text", text: `Skill: ${skill.name}. ${skill.description}` },
            { kind: "data", data: { ...input, ...(context?.data ?? {}), business: businessFor(grounding) } },
          ],
          // One A2A context per account, so a partner can tell one business's tasks apart from another's.
          { apiKey, timeoutMs: 60_000, contextId: `acct-${userId}` },
        );
        return {
          output: resultData(result),
          model: `${agent.provider.name} over A2A`,
          latencyMs: Date.now() - started,
          usage: { inputTokens: 0, outputTokens: 0 },
          notes: context?.note ? [context.note] : [],
        };
      } catch (err) {
        if (err instanceof A2AError) throw new GatewayError("AGENT_FAILED", err.message);
        throw err;
      }
    },

    approval(output) {
      return {
        title: typeof output.title === "string" ? output.title : `${agent.name} finished a task`,
        preview: typeof output.summary === "string" ? output.summary : "Open the task to review the result.",
        severity: Array.isArray(output.heldBack) && output.heldBack.length ? "check" : "info",
        actions: [
          { id: "approve", label: "Approve", kind: "approve" },
          { id: "skip", label: "Discard", kind: "skip" },
        ],
      };
    },

    // Partner results are shown in AgentGig; nothing is posted on the owner's behalf yet.
    async deliver() {
      return { delivered: true, summary: "Result saved in AgentGig" };
    },
  };
}

function businessFor(g: Grounding) {
  const memory = g.memory.length ? { companyMemory: g.memory } : {};
  return g.profile ? { businessName: g.businessName, ...g.profile, ...memory } : { businessName: g.businessName, ...memory };
}

/* ------------------------------------------------------------------ */
/* Agent-to-agent handoffs: context one agent's skill takes from another */
/* ------------------------------------------------------------------ */

type Handoff = (userId: string, input: Record<string, unknown>) => Promise<{ data: Record<string, unknown>; note: string }>;

const HANDOFFS: Record<string, Handoff> = {
  /** VAT Reconciler gets the period's invoices that ReceiptHero has audited. */
  "vat.summary": async (userId, input) => {
    const { start, end, label } = periodRange(String(input.period ?? "this-month"));
    const snap = await db().collection(COLLECTIONS.tasks).where("userId", "==", userId).where("agentId", "==", "receipthero").get();
    const seen = new Set<string>();
    const invoices = snap.docs
      .map((d) => d.data() as TaskDoc)
      .filter((t) => t.settlement === "charged" && t.output)
      .filter((t) => {
        const issued = typeof t.output!.issueDate === "string" ? Date.parse(t.output!.issueDate) : NaN;
        const when = Number.isNaN(issued) ? t.createdAt.toMillis() : issued;
        return when >= start && when < end;
      })
      .filter((t) => {
        const key = t.output!.invoiceKey as string | null;
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((t) => {
        const o = t.output!;
        return {
          vendor: o.vendor,
          invoiceNumber: o.invoiceNumber,
          issueDate: o.issueDate,
          currency: o.currency,
          subtotal: o.subtotal,
          lineItemsTotal: o.lineItemsTotal,
          taxAmount: o.taxAmount,
          totalPrinted: o.totalPrinted,
          flags: o.flags,
        };
      });
    return {
      data: { period: label, invoices },
      note: `Handed ${invoices.length} invoice${invoices.length === 1 ? "" : "s"} audited by ReceiptHero (${label}) to the partner over A2A`,
    };
  },
};

function periodRange(period: string): { start: number; end: number; label: string } {
  const now = new Date();
  const offset = period === "last-month" ? -1 : 0;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  return { start: start.getTime(), end: end.getTime(), label: start.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) };
}
