/**
 * Ledgerline VAT Reconciler: a sample third-party A2A agent.
 *
 * It stands in for an outside developer's service: AgentGig only knows
 * it through its Agent Card and the A2A JSON-RPC method "message/send".
 *
 *   GET  /.well-known/agent-card.json   Agent Card (A2A v0.3)
 *   POST /a2a                           JSON-RPC 2.0, method "message/send"
 *
 * Input: a DataPart { invoices: [...], period: "2026-10", business?: {...} }
 * Output: a completed Task whose artifact holds a DataPart with the summary.
 * All money maths happens here in code; Gemini only writes the accountant's note.
 *
 * Env: API_KEY (required header X-API-Key), GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, PORT
 */
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { GoogleGenAI } from "@google/genai";

const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.API_KEY ?? "";
const PRICING_URI = "https://agentgig.si/ext/pricing/v1";
const LISTING_URI = "https://agentgig.si/ext/listing/v1";

const genai = process.env.GOOGLE_CLOUD_PROJECT
  ? new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1" })
  : null;

function agentCard(baseUrl) {
  return {
    protocolVersion: "0.3.0",
    name: "VAT Reconciler",
    description: "Turns a month of audited invoices into a VAT summary your accountant can file from, and holds back anything that needs checking.",
    url: `${baseUrl}/a2a`,
    version: "1.0.0",
    preferredTransport: "JSONRPC",
    provider: { organization: "Ledgerline", url: "https://ledgerline.example" },
    capabilities: {
      streaming: false,
      extensions: [
        { uri: PRICING_URI, description: "AgentGig pricing", params: { tokensPerTask: 6, category: "Finance" } },
        {
          uri: LISTING_URI,
          description: "AgentGig listing details",
          params: { tools: ["google_sheets"], timeSaved: "4 h/month", estTasksPerWeek: 1 },
        },
      ],
    },
    securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
    security: [{ apiKey: [] }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "vat.summary",
        name: "Prepare VAT summary",
        description: "Totals net, VAT and gross for a period's invoices, separates invoices with problems, and writes a note for the accountant.",
        tags: ["finance", "vat", "bookkeeping"],
        examples: ["Prepare the VAT summary for October"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */

const round = (n) => Math.round(n * 100) / 100;

function summarise({ invoices = [], period = "this period" }) {
  const rows = invoices.map((inv) => {
    const net = round(inv.subtotal ?? inv.lineItemsTotal ?? 0);
    const vat = round(inv.taxAmount ?? 0);
    return {
      vendor: inv.vendor?.name ?? "Unknown supplier",
      invoiceNumber: inv.invoiceNumber ?? null,
      date: inv.issueDate ?? null,
      currency: inv.currency ?? "GBP",
      net,
      vat,
      gross: round(inv.totalPrinted ?? net + vat),
      reason: (inv.flags ?? []).filter((f) => f.severity !== "low").map((f) => f.message)[0] ?? null,
    };
  });
  const included = rows.filter((r) => !r.reason);
  const heldBack = rows.filter((r) => r.reason);
  const sum = (list, key) => round(list.reduce((s, r) => s + r[key], 0));
  const currency = rows[0]?.currency ?? "GBP";
  return {
    period,
    currency,
    invoiceCount: rows.length,
    totals: { net: sum(included, "net"), vat: sum(included, "vat"), gross: sum(included, "gross") },
    reclaimableVat: sum(included, "vat"),
    heldBackVat: sum(heldBack, "vat"),
    included,
    heldBack,
  };
}

async function accountantNote(s, business) {
  const fallback =
    `${s.invoiceCount} invoices for ${s.period}. Input VAT of ${s.currency} ${s.reclaimableVat.toFixed(2)} is ready to reclaim` +
    (s.heldBack.length ? `; ${s.heldBack.length} invoice(s) with ${s.currency} ${s.heldBackVat.toFixed(2)} VAT are held back until corrected.` : ".");
  if (!genai || !s.invoiceCount) return fallback;
  try {
    const res = await genai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `Write a 2–3 sentence note to a small business's accountant about this VAT summary. Plain English, no greeting, no sign-off. ` +
                `These are purchase invoices, so their VAT is input VAT the business can reclaim; never call it VAT collected or output VAT. ` +
                `"reclaimableVat" is ready to claim; "heldBackVat" waits until the supplier corrects the invoice, and say why. ` +
                `Use only these figures and do not recalculate them.\nBusiness: ${business?.businessName ?? "the business"}\n${JSON.stringify(s)}`,
            },
          ],
        },
      ],
      config: { temperature: 0.3, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 }, abortSignal: AbortSignal.timeout(15_000) },
    });
    return res.text?.trim() || fallback;
  } catch (err) {
    console.error("note generation failed:", err.message);
    return fallback;
  }
}

async function handleMessageSend(params) {
  const parts = params?.message?.parts ?? [];
  const data = parts.find((p) => p.kind === "data")?.data ?? {};
  const s = summarise(data);
  const note = await accountantNote(s, data.business);
  const contextId = params?.message?.contextId ?? randomUUID();
  return {
    kind: "task",
    id: randomUUID(),
    contextId,
    status: { state: "completed", timestamp: new Date().toISOString() },
    artifacts: [
      {
        artifactId: randomUUID(),
        name: "vat-summary",
        parts: [
          {
            kind: "data",
            data: {
              title: `VAT summary for ${s.period} is ready`,
              summary: `${s.currency} ${s.reclaimableVat.toFixed(2)} VAT to reclaim from ${s.included.length} invoice(s)` + (s.heldBack.length ? `, ${s.heldBack.length} held back` : ""),
              ...s,
              accountantNote: note,
            },
          },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function keyMatches(given) {
  if (!API_KEY || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

createServer(async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const baseUrl = `${proto}://${req.headers.host}`;
  const path = new URL(req.url ?? "/", baseUrl).pathname;

  if (req.method === "GET" && (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json")) {
    return send(res, 200, agentCard(baseUrl));
  }
  if (req.method === "GET" && path === "/") return send(res, 200, { ok: true, card: "/.well-known/agent-card.json" });
  if (req.method !== "POST" || path !== "/a2a") return send(res, 404, { error: "not found" });

  let rpc;
  try {
    rpc = await readBody(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (!keyMatches(req.headers["x-api-key"])) {
    return send(res, 401, { jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32001, message: "Missing or wrong X-API-Key" } });
  }
  if (rpc?.jsonrpc !== "2.0" || rpc.method !== "message/send") {
    return send(res, 200, { jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32601, message: `Method not found: ${rpc?.method}` } });
  }
  try {
    const result = await handleMessageSend(rpc.params);
    send(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
  } catch (err) {
    console.error(err);
    send(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "Internal error" } });
  }
}).listen(PORT, () => console.log(`Ledgerline VAT Reconciler listening on :${PORT}`));
