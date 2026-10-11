import "server-only";
import { ApiError, GoogleGenAI, type Part } from "@google/genai";
import { z } from "zod";
import { env } from "./env";
import { GatewayError } from "./errors";

/**
 * Gemini on Vertex AI. Every agent call asks for JSON that matches a Zod
 * schema: the schema is sent as `responseJsonSchema` so the model is
 * constrained to it, then the reply is validated again before use.
 */

export type ModelTier = "flash" | "pro";

let client: GoogleGenAI | undefined;

function genai(): GoogleGenAI {
  client ??= new GoogleGenAI({
    vertexai: true,
    project: env().GOOGLE_CLOUD_PROJECT,
    location: env().GOOGLE_CLOUD_LOCATION,
  });
  return client;
}

export function modelFor(tier: ModelTier): string {
  return tier === "pro" ? env().GEMINI_PRO_MODEL : env().GEMINI_FLASH_MODEL;
}

export function textPart(text: string): Part {
  return { text };
}

export function filePart(data: Buffer, mimeType: string): Part {
  return { inlineData: { data: data.toString("base64"), mimeType } };
}

export interface GenerateJsonOptions<S extends z.ZodType> {
  tier: ModelTier;
  system: string;
  parts: Part[];
  schema: S;
  temperature?: number;
  timeoutMs?: number;
  /** Name of a Vertex AI cached content resource (company knowledge, Milestone 2). */
  cachedContent?: string;
}

export interface GenerateJsonResult<T> {
  data: T;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export async function generateJson<S extends z.ZodType>(opts: GenerateJsonOptions<S>): Promise<GenerateJsonResult<z.output<S>>> {
  const model = modelFor(opts.tier);
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 60_000;

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await genai().models.generateContent({
        model,
        contents: [{ role: "user", parts: opts.parts }],
        config: {
          systemInstruction: opts.system,
          temperature: opts.temperature ?? 0.4,
          responseMimeType: "application/json",
          responseJsonSchema: toGeminiSchema(opts.schema),
          cachedContent: opts.cachedContent,
          abortSignal: AbortSignal.timeout(timeoutMs),
        },
      });

      const text = res.text;
      if (!text) {
        const reason = res.candidates?.[0]?.finishReason ?? "no candidates";
        throw new GatewayError("AGENT_FAILED", `The model returned no content (${reason}).`);
      }
      const parsed = opts.schema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new GatewayError("AGENT_FAILED", "The model's answer didn't match the expected format.", {
          issues: z.prettifyError(parsed.error),
        });
      }
      return {
        data: parsed.data,
        model,
        latencyMs: Date.now() - started,
        usage: {
          inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new GatewayError("AGENT_TIMEOUT", `The model didn't answer within ${timeoutMs / 1000} seconds.`);
      }
      const retryable = err instanceof ApiError && RETRYABLE.has(err.status);
      if (retryable && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      if (err instanceof GatewayError) throw err;
      if (err instanceof SyntaxError) throw new GatewayError("AGENT_FAILED", "The model returned invalid JSON.");
      const status = err instanceof ApiError ? ` (HTTP ${err.status})` : "";
      throw new GatewayError("AGENT_FAILED", `Vertex AI request failed${status}.`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Zod → JSON Schema for Gemini. Drops the keywords Gemini's schema subset
 * rejects; the Zod schema still enforces them on the reply.
 */
function toGeminiSchema(schema: z.ZodType): unknown {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === "$schema" || k === "additionalProperties" || k === "pattern" || k === "format") continue;
        out[k] = strip(v);
      }
      return out;
    }
    return node;
  };
  return strip(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }));
}
