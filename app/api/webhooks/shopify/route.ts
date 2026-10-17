import { NextResponse } from "next/server";
import { onShopifyOrder } from "@/lib/event-sources";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/shopify — Shopify's "orders/create" webhook. The order
 * is read back from the shop before anything runs (see onShopifyOrder).
 * Answers fast; Shopify retries anything slower than 5 s.
 */
export async function POST(req: Request) {
  try {
    const shop = req.headers.get("x-shopify-shop-domain") ?? "";
    const topic = req.headers.get("x-shopify-topic") ?? "";
    const body = (await req.json().catch(() => ({}))) as { admin_graphql_api_id?: string };
    if (topic !== "orders/create" || !shop || !body.admin_graphql_api_id?.startsWith("gid://shopify/Order/")) return NextResponse.json({ ok: true, outcome: "ignored" });
    return NextResponse.json({ ok: true, outcome: await onShopifyOrder(shop, body.admin_graphql_api_id) });
  } catch (err) {
    return errorResponse(err, req);
  }
}
