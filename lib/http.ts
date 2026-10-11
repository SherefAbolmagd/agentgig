import "server-only";
import { NextResponse } from "next/server";
import { isGatewayError } from "./errors";
import type { UploadedFile } from "./agents";

/** Converts any thrown error into a JSON response. Unknown errors are logged and hidden. */
export function errorResponse(err: unknown): NextResponse {
  if (isGatewayError(err)) return NextResponse.json(err.toJSON(), { status: err.status });
  console.error(err);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong on our side." } }, { status: 500 });
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
