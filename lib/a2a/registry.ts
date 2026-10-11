import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "@/lib/firebase-admin";
import { putSecret } from "@/lib/secrets";
import { TOOL_LABELS } from "@/lib/tools";
import { AgentCardSchema, PRICING_EXTENSION_URI, getListing, getPricing, type AgentCard } from "@/types/a2a";
import { COLLECTIONS, type AgentDoc, type ToolProvider } from "@/types/firestore";
import { A2AError, assertPublicUrl, fetchAgentCard, resultData, sendMessage } from "./client";

export const RegisterRequest = z.object({
  cardUrl: z.string().trim().min(1, "Paste your Agent Card URL"),
  apiKey: z.string().trim().max(500).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export interface Check {
  id: "fetch" | "schema" | "pricing" | "endpoint" | "index";
  label: string;
  ok: boolean;
  detail: string;
}

export interface RegisterResult {
  ok: boolean;
  checks: Check[];
  card?: AgentCard;
  agent?: { slug: string; name: string; replacedPreview: boolean };
}

/**
 * Registers an A2A agent: fetch the card, validate it, read its price, send it
 * a test task, then list it. Stops at the first failed check and says why.
 */
export async function registerAgent(ownerUid: string, req: RegisterRequest): Promise<RegisterResult> {
  const checks: Check[] = [];
  const pass = (id: Check["id"], label: string, detail: string) => checks.push({ id, label, ok: true, detail });
  const fail = (id: Check["id"], label: string, detail: string): RegisterResult => {
    checks.push({ id, label, ok: false, detail });
    return { ok: false, checks };
  };

  // 1. Fetch
  const fetchLabel = "Card is reachable over HTTPS";
  if (!/\/agent(-card)?\.json$/.test(new URL(req.cardUrl, "https://x").pathname)) {
    return fail("fetch", fetchLabel, "Serve your card at /.well-known/agent-card.json (A2A v0.3) or the older /.well-known/agent.json.");
  }
  let raw: unknown;
  try {
    raw = await fetchAgentCard(req.cardUrl);
  } catch (err) {
    return fail("fetch", fetchLabel, err instanceof A2AError ? err.message : "We couldn't fetch the card.");
  }
  pass("fetch", fetchLabel, "Fetched and parsed as JSON.");

  // 2. Schema
  const schemaLabel = "Valid A2A Agent Card";
  const parsed = AgentCardSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "card"}: ${i.message}`);
    return fail("schema", schemaLabel, issues.join("; "));
  }
  const card = parsed.data;
  pass("schema", schemaLabel, `${card.name} v${card.version}, protocol ${card.protocolVersion}, ${card.skills.length} skill${card.skills.length > 1 ? "s" : ""}.`);

  // 3. Pricing
  const pricingLabel = "Pricing extension";
  const pricing = getPricing(card);
  if (!pricing) {
    return fail(
      "pricing",
      pricingLabel,
      `Add an entry to capabilities.extensions with uri "${PRICING_EXTENSION_URI}" and params { "tokensPerTask": 1–1000, "category": "Marketing" | "E-Commerce" | "Finance" | "HR/Ops" }.`,
    );
  }
  pass("pricing", pricingLabel, `${pricing.tokensPerTask} tokens per task, listed under ${pricing.category}.`);

  // 4. Endpoint answers a test task
  const endpointLabel = "Endpoint completes a test task";
  const scheme = Object.values(card.securitySchemes ?? {}).find((s) => s.type === "apiKey") as { in?: string; name?: string } | undefined;
  const needsKey = !!scheme && (card.security?.length ?? 0) > 0;
  if (scheme && scheme.in !== "header") return fail("endpoint", endpointLabel, "Only API keys sent in a header are supported.");
  if (needsKey && !req.apiKey) return fail("endpoint", endpointLabel, `This card asks for an API key in the ${scheme?.name} header. Paste it above.`);
  const apiKey = needsKey && req.apiKey ? { header: scheme!.name ?? "X-API-Key", value: req.apiKey } : undefined;
  try {
    await assertPublicUrl(card.url);
    const started = Date.now();
    const result = await sendMessage(
      card.url,
      [
        { kind: "text", text: "AgentExchange verification task. Reply with a completed example result; nothing will be delivered." },
        { kind: "data", data: { verification: true } },
      ],
      { apiKey, timeoutMs: 30_000 },
    );
    resultData(result);
    pass("endpoint", endpointLabel, `message/send completed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  } catch (err) {
    return fail("endpoint", endpointLabel, err instanceof A2AError ? err.message : "The test task failed.");
  }

  // 5. Index
  const indexLabel = "Listed in the marketplace";
  const slug = slugify(card.name);
  const ref = db().collection(COLLECTIONS.agents).doc(slug);
  const existing = (await ref.get()).data() as AgentDoc | undefined;
  if (existing?.ownerUid && existing.ownerUid !== ownerUid) {
    return fail("index", indexLabel, `Another developer already lists an agent called “${card.name}”. Rename yours.`);
  }
  if (existing?.source === "native") return fail("index", indexLabel, `“${card.name}” is reserved. Rename your agent.`);

  const listing = getListing(card);
  const tools = (listing.tools ?? existing?.tools ?? []).filter((t): t is ToolProvider => t in TOOL_LABELS);
  const secretRef = apiKey ? await putSecret(`partner-${slug}`, apiKey.value) : null;
  await ref.set(
    {
      slug,
      name: card.name,
      initials: initials(card.name),
      category: pricing.category,
      description: card.description,
      provider: { name: card.provider?.organization ?? "Independent developer", ...(card.provider?.url && { url: card.provider.url }) },
      tokensPerTask: pricing.tokensPerTask,
      source: "a2a",
      cardUrl: req.cardUrl,
      endpointUrl: card.url,
      skills: card.skills,
      tools,
      triggers: existing?.triggers ?? [{ id: "manual", label: "Only when I click Run", type: "manual" }],
      timeSaved: listing.timeSaved ?? existing?.timeSaved ?? "time",
      estTasksPerWeek: listing.estTasksPerWeek ?? existing?.estTasksPerWeek ?? 1,
      rating: existing?.rating ?? null,
      taskCount: existing?.taskCount ?? 0,
      status: "listed",
      ownerUid,
      auth: secretRef ? { type: "apiKey", header: apiKey!.header, secretRef } : null,
      version: card.version,
      protocolVersion: card.protocolVersion,
      listedAt: existing?.listedAt ?? FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  const replacedPreview = !!existing && !existing.endpointUrl;
  pass("index", indexLabel, replacedPreview ? `The “${card.name}” preview listing is now live.` : `Listed as “${card.name}”.`);
  return { ok: true, checks, card, agent: { slug, name: card.name, replacedPreview } };
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "agent";

const initials = (s: string) =>
  s
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
