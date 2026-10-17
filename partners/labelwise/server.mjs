/**
 * LabelWise Candle Label Checker: a second sample third-party A2A agent.
 *
 * Like Ledgerline, it stands in for an outside developer's service, known to
 * AgentGig only through its Agent Card. It's the one registered live on the
 * Developers page in the demo video.
 *
 *   GET  /.well-known/agent-card.json   Agent Card (A2A v0.3)
 *   POST /a2a                           JSON-RPC 2.0, method "message/send"
 *
 * Input: a DataPart with the products as text (any of: products, menu, items,
 * text, request), plus the business profile AgentGig sends.
 * Output: a completed Task whose artifact holds { title, summary, items[], labelNote }.
 * Gemini reads the fragrances; the allergen names it may use are fixed in code.
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

/** Fragrance allergens commonly declared on CLP labels for scented candles. */
const ALLERGENS = ["linalool", "limonene", "citral", "coumarin", "eugenol", "geraniol", "citronellol", "cinnamal", "hexyl cinnamal", "benzyl benzoate", "benzyl salicylate", "isoeugenol", "alpha-isomethyl ionone", "farnesol", "vanillin"];

const genai = process.env.GOOGLE_CLOUD_PROJECT
  ? new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1" })
  : null;

function agentCard(baseUrl) {
  return {
    protocolVersion: "0.3.0",
    name: "Candle Label Checker",
    description: "Reads your candle and wax melt range and drafts the CLP safety label for each: fragrance allergens to declare, warnings, and what to confirm with your fragrance supplier.",
    url: `${baseUrl}/a2a`,
    version: "1.0.0",
    preferredTransport: "JSONRPC",
    provider: { organization: "LabelWise", url: "https://labelwise.example" },
    capabilities: {
      streaming: false,
      extensions: [
        { uri: PRICING_URI, description: "AgentGig pricing", params: { tokensPerTask: 3, category: "E-Commerce" } },
        { uri: LISTING_URI, description: "AgentGig listing details", params: { tools: [], timeSaved: "2 h/month", estTasksPerWeek: 1 } },
      ],
    },
    securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
    security: [{ apiKey: [] }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "labels.check",
        name: "Draft candle safety labels",
        description: "Lists the fragrance allergens each scented product likely needs to declare and drafts its CLP label wording.",
        tags: ["candles", "labels", "compliance"],
        examples: ["Check labels for our autumn candle range"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          allergens: { type: "array", items: { type: "string", enum: ALLERGENS } },
          mayContain: { type: "array", items: { type: "string", enum: ALLERGENS } },
          check: { type: "string", description: "What to confirm on the supplier's safety data sheet, or empty" },
        },
        required: ["name", "allergens", "mayContain", "check"],
      },
    },
    labelNote: { type: "string", description: "Standard candle safety wording for the label, one or two sentences" },
  },
  required: ["items", "labelNote"],
};

function menuText(data) {
  for (const k of ["products", "menu", "items", "text", "request", "message", "details"]) {
    const v = data?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length) return v.map(String).join("\n");
  }
  return "";
}

async function check(menu, business) {
  if (!genai) throw new Error("Gemini is not configured");
  const res = await genai.models.generateContent({
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `You help a candle maker prepare CLP safety labels. For each scented product, list in "allergens" the fragrance allergens its scent notes typically contain, ` +
              `and in "mayContain" ones that depend on the exact fragrance oil. Use only the allowed names. Unscented items (matches, plain wax) have none. ` +
              `In "check", say what to confirm on the fragrance supplier's safety data sheet. This is a draft for checking, not a legal label. ` +
              `Business: ${business?.businessName ?? "a candle maker"}.\nProducts:\n${menu}`,
          },
        ],
      },
    ],
    config: { temperature: 0.1, responseMimeType: "application/json", responseSchema: SCHEMA, thinkingConfig: { thinkingBudget: 0 }, abortSignal: AbortSignal.timeout(30_000) },
  });
  return JSON.parse(res.text ?? "{}");
}

async function handleMessageSend(params) {
  const parts = params?.message?.parts ?? [];
  const data = parts.find((p) => p.kind === "data")?.data ?? {};
  const text = parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n");
  // AgentGig's registration check sends { verification: true } and no products: answer with a small sample.
  const menu = data.verification ? "Fig & Cedar candle\nLong matches" : menuText(data) || text.replace(/^Skill:[^\n]*\n?/, "").trim() || "Fig & Cedar candle";
  const result = await check(menu, data.business);
  const items = (result.items ?? []).map((i) => ({ ...i, allergens: [...new Set(i.allergens)], mayContain: [...new Set(i.mayContain)].filter((a) => !i.allergens.includes(a)) }));
  const withAllergens = items.filter((i) => i.allergens.length).length;
  const toCheck = items.filter((i) => i.check?.trim()).length;
  return {
    kind: "task",
    id: randomUUID(),
    contextId: params?.message?.contextId ?? randomUUID(),
    status: { state: "completed", timestamp: new Date().toISOString() },
    artifacts: [
      {
        artifactId: randomUUID(),
        name: "allergen-check",
        parts: [
          {
            kind: "data",
            data: {
              title: `Labels drafted for ${items.length} product${items.length === 1 ? "" : "s"}`,
              summary:
                items.map((i) => `${i.name}: ${i.allergens.length ? i.allergens.join(", ") : "nothing to declare"}`).join(" · ") +
                (toCheck ? ` (${toCheck} to confirm on safety data sheets)` : ""),
              items,
              itemsWithAllergens: withAllergens,
              labelNote: result.labelNote ?? "",
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
}).listen(PORT, () => console.log(`LabelWise Candle Label Checker listening on :${PORT}`));
