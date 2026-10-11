"use client";
import { clientAuth } from "@/lib/firebase-client";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Calls one of our API routes as the signed-in user. Pass `json` for a JSON
 * body or `form` for multipart. Throws ApiError with the server's plain-English message.
 */
export async function api<T>(
  path: string,
  init: Omit<RequestInit, "body"> & { json?: unknown; form?: FormData } = {},
): Promise<T> {
  const user = clientAuth.currentUser;
  if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in to continue.", 401);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await user.getIdToken()}`);
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  } else if (init.form) {
    body = init.form;
  }

  const res = await fetch(path, { method: "POST", ...init, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(err.code ?? "INTERNAL", err.message ?? "Something went wrong. Try again.", res.status, err.details);
  }
  return data as T;
}
