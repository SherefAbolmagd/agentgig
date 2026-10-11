import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health — liveness for uptime checks. Deliberately touches no backing service. */
export function GET() {
  return NextResponse.json({ ok: true, revision: process.env.K_REVISION ?? "local" }, { headers: { "cache-control": "no-store" } });
}
