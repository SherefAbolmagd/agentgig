import "server-only";
import { NextResponse } from "next/server";
import { GatewayError, isGatewayError } from "./errors";
import { logError } from "./log";
import type { UploadedFile } from "./agents";

/** Converts any thrown error into a JSON response. Unknown errors are logged (with stack) and hidden. */
export function errorResponse(err: unknown, req?: Request): NextResponse {
  if (isGatewayError(err)) {
    const retry = err.details?.retryAfterSeconds;
    return NextResponse.json(err.toJSON(), { status: err.status, headers: retry ? { "retry-after": String(retry) } : undefined });
  }
  logError(err, req ? { httpRequest: { requestMethod: req.method, requestUrl: new URL(req.url).pathname } } : {});
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong on our side." } }, { status: 500 });
}

/** Wraps a route handler so any thrown error becomes a JSON error response. */
export function handle<C>(fn: (req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      const body = await fn(req, ctx);
      return body instanceof Response ? body : NextResponse.json(body ?? { ok: true });
    } catch (err) {
      return errorResponse(err, req);
    }
  };
}

/** Parses a JSON body with a Zod schema, as INVALID_INPUT on failure. */
export async function readJson<T>(req: Request, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }): Promise<T> {
  const parsed = schema.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new GatewayError("INVALID_INPUT", `${issue.path.join(".") || "Request"}: ${issue.message}`);
  }
  return parsed.data;
}

/**
 * Reads a task request as JSON (`{ agentId, input }`) or multipart form data
 * (fields `agentId`, `input` as a JSON string, and `file`).
 */
export async function readTaskBody(req: Request): Promise<{ agentId: unknown; input: unknown; files: UploadedFile[] }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const rawInput = form.get("input");
    const files = await Promise.all(
      form
        .getAll("file")
        .filter((f): f is File => f instanceof File && f.size > 0)
        .map(async (f) => ({ name: f.name, mimeType: f.type || "application/octet-stream", data: Buffer.from(await f.arrayBuffer()) })),
    );
    return { agentId: form.get("agentId"), input: typeof rawInput === "string" && rawInput ? safeJson(rawInput) : {}, files };
  }
  const body = (await req.json().catch(() => ({}))) as { agentId?: unknown; input?: unknown };
  return { agentId: body.agentId, input: body.input ?? {}, files: [] };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { __invalid: text };
  }
}
