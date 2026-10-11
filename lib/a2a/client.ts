import "server-only";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Message, MessageSendResponse, Part, Task } from "@/types/a2a";

/**
 * Minimal A2A client: fetch an Agent Card, call message/send.
 *
 * Every outbound URL comes from a developer, so requests are only allowed to
 * public HTTPS hosts. Private, loopback and link-local addresses are refused
 * (on Cloud Run, 169.254.169.254 would hand out this service's credentials),
 * and redirects are not followed.
 */

export class A2AError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2AError";
  }
}

const CARD_LIMIT_BYTES = 64 * 1024;
const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new A2AError("That isn't a valid URL.");
  }
  if (url.protocol !== "https:") throw new A2AError("The URL must start with https://.");
  if (url.username || url.password) throw new A2AError("URLs with credentials aren't allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new A2AError(`We couldn't find the host ${host}.`);
  if (addresses.some(isPrivateAddress)) throw new A2AError("That URL points to a private network address.");
  return url;
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

async function readLimited(res: Response, limit: number): Promise<string> {
  const text = await res.text();
  if (Buffer.byteLength(text) > limit) throw new A2AError(`The response is larger than ${Math.round(limit / 1024)} KB.`);
  return text;
}

export async function fetchAgentCard(cardUrl: string): Promise<unknown> {
  const url = await assertPublicUrl(cardUrl);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  } catch (err) {
    throw new A2AError(err instanceof Error && err.name === "TimeoutError" ? "The card didn't load within 5 seconds." : "We couldn't connect to that URL.");
  }
  if (res.status >= 300 && res.status < 400) throw new A2AError("The card URL redirects. Give us the final URL.");
  if (!res.ok) throw new A2AError(`The card URL returned HTTP ${res.status}.`);
  const text = await readLimited(res, CARD_LIMIT_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw new A2AError("The card isn't valid JSON.");
  }
}

export interface SendOptions {
  apiKey?: { header: string; value: string };
  timeoutMs?: number;
}

/** Calls JSON-RPC message/send and returns the Task or Message result. */
export async function sendMessage(endpoint: string, parts: Part[], opts: SendOptions = {}): Promise<Task | Message> {
  const url = await assertPublicUrl(endpoint);
  const message: Message = { kind: "message", messageId: randomUUID(), role: "user", parts };
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (opts.apiKey) headers[opts.apiKey.header] = opts.apiKey.value;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "message/send", params: { message, configuration: { blocking: true } } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new A2AError(err instanceof Error && err.name === "TimeoutError" ? "The partner agent didn't answer in time." : "We couldn't reach the partner agent.");
  }
  if (res.status === 401 || res.status === 403) throw new A2AError("The partner agent rejected our credentials.");
  if (!res.ok) throw new A2AError(`The partner agent returned HTTP ${res.status}.`);
  let body: MessageSendResponse;
  try {
    body = JSON.parse(await readLimited(res, RESPONSE_LIMIT_BYTES));
  } catch (err) {
    throw err instanceof A2AError ? err : new A2AError("The partner agent's reply isn't valid JSON.");
  }
  if ("error" in body) throw new A2AError(`The partner agent reported an error: ${body.error.message}`);
  return body.result;
}

/** Pulls the structured result out of a completed Task (or a direct Message reply). */
export function resultData(result: Task | Message): Record<string, unknown> {
  const fromParts = (parts: Part[]) => {
    const data = parts.find((p) => p.kind === "data");
    if (data && data.kind === "data") return data.data;
    const text = parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n").trim();
    return text ? { summary: text } : null;
  };

  if (result.kind === "message") {
    const out = fromParts(result.parts);
    if (!out) throw new A2AError("The partner agent replied without a result.");
    return out;
  }
  if (result.status.state !== "completed") {
    const why = result.status.message ? fromParts(result.status.message.parts)?.summary : undefined;
    throw new A2AError(`The partner agent's task ended as “${result.status.state}”${why ? `: ${why}` : "."}`);
  }
  for (const artifact of result.artifacts ?? []) {
    const out = fromParts(artifact.parts);
    if (out) return out;
  }
  throw new A2AError("The partner agent finished without returning a result.");
}
