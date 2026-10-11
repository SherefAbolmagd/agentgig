/**
 * Agent2Agent (A2A) protocol types, v0.3.
 *
 * The Agent Card schema is written in Zod so the same definition types our
 * code and validates cards submitted through /api/a2a/register.
 * Spec: https://a2a-protocol.org/latest/specification/
 */
import { z } from "zod";

export const A2A_PROTOCOL_VERSION = "0.3.0";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
/** Pre-0.3 cards were served here; the registry still accepts it. */
export const LEGACY_AGENT_CARD_PATH = "/.well-known/agent.json";

/** A2A has no pricing field, so listings declare price through this extension. */
export const PRICING_EXTENSION_URI = "https://agentexchange.dev/ext/pricing/v1";

export const AGENT_CATEGORIES = ["Marketing", "E-Commerce", "Finance", "HR/Ops"] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/* ------------------------------------------------------------------ */
/* Agent Card                                                          */
/* ------------------------------------------------------------------ */

export const AgentExtensionSchema = z.object({
  uri: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const PricingParamsSchema = z.object({
  tokensPerTask: z.number().int().min(1).max(1000),
  category: z.enum(AGENT_CATEGORIES),
});

export const AgentSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  stateTransitionHistory: z.boolean().optional(),
  extensions: z.array(AgentExtensionSchema).optional(),
});

export const AgentProviderSchema = z.object({
  organization: z.string().min(1),
  url: z.url(),
});

/** Security schemes follow OpenAPI 3; we only need to read their type. */
export const SecuritySchemeSchema = z
  .object({ type: z.enum(["apiKey", "http", "oauth2", "openIdConnect", "mutualTLS"]) })
  .loose();

export const AgentCardSchema = z
  .object({
    protocolVersion: z.string().min(1),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(1000),
    url: z.url({ protocol: /^https$/ }),
    version: z.string().min(1),
    preferredTransport: z.enum(["JSONRPC", "GRPC", "HTTP+JSON"]).optional(),
    provider: AgentProviderSchema.optional(),
    iconUrl: z.url().optional(),
    documentationUrl: z.url().optional(),
    capabilities: AgentCapabilitiesSchema,
    securitySchemes: z.record(z.string(), SecuritySchemeSchema).optional(),
    security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
    defaultInputModes: z.array(z.string()).min(1),
    defaultOutputModes: z.array(z.string()).min(1),
    skills: z.array(AgentSkillSchema).min(1),
  })
  .loose();

export type AgentExtension = z.infer<typeof AgentExtensionSchema>;
export type PricingParams = z.infer<typeof PricingParamsSchema>;
export type AgentSkill = z.infer<typeof AgentSkillSchema>;
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;
export type AgentCard = z.infer<typeof AgentCardSchema>;

/** Reads the pricing extension from a card, or null if it is missing or malformed. */
export function getPricing(card: AgentCard): PricingParams | null {
  const ext = card.capabilities.extensions?.find((e) => e.uri === PRICING_EXTENSION_URI);
  const parsed = PricingParamsSchema.safeParse(ext?.params);
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ */
/* Messages and tasks (JSON-RPC method "message/send")                 */
/* ------------------------------------------------------------------ */

export type TextPart = { kind: "text"; text: string; metadata?: Record<string, unknown> };
export type FilePart = {
  kind: "file";
  file: { name?: string; mimeType?: string } & ({ bytes: string } | { uri: string });
  metadata?: Record<string, unknown>;
};
export type DataPart = { kind: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> };
export type Part = TextPart | FilePart | DataPart;

export type Message = {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: Part[];
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
};

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

export type Artifact = {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
};

export type Task = {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; message?: Message; timestamp?: string };
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
};

export type MessageSendParams = {
  message: Message;
  configuration?: {
    acceptedOutputModes?: string[];
    blocking?: boolean;
    historyLength?: number;
  };
  metadata?: Record<string, unknown>;
};

export type JsonRpcRequest<P> = { jsonrpc: "2.0"; id: string | number; method: string; params: P };
export type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcResponse<R> =
  | { jsonrpc: "2.0"; id: string | number | null; result: R }
  | { jsonrpc: "2.0"; id: string | number | null; error: JsonRpcError };

export type MessageSendRequest = JsonRpcRequest<MessageSendParams> & { method: "message/send" };
export type MessageSendResponse = JsonRpcResponse<Task | Message>;
