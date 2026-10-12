import "server-only";
import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { assertPublicUrl } from "@/lib/a2a/client";
import { env } from "@/lib/env";
import { GatewayError } from "@/lib/errors";
import { db } from "@/lib/firebase-admin";
import { keyFields, saveKeyConnection, vendorFetch, type KeyTester } from "./keys";
import { inWindow, type StoreCustomer, type StoreDeliveredOrder, type StoreOrder, type StoreProduct } from "./store";

/**
 * WooCommerce REST API (wc/v3) with consumer key/secret. Owners connect with
 * WooCommerce's built-in authorisation endpoint (/wc-auth/v1/authorize): their
 * own WordPress site asks them to approve, then POSTs the keys to our callback.
 */

async function siteBase(raw: string): Promise<string> {
  const url = await assertPublicUrl(raw.trim().replace(/\/+$/, "").replace(/^(?!https?:\/\/)/, "https://")).catch(() => {
    throw new GatewayError("INVALID_INPUT", "Enter your store's public https:// address.");
  });
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function auth(fields: Record<string, string>) {
  return { authorization: `Basic ${Buffer.from(`${fields.consumerKey}:${fields.consumerSecret}`).toString("base64")}` };
}

async function wc<T>(fields: Record<string, string>, path: string): Promise<T> {
  const base = await siteBase(fields.siteUrl);
  return vendorFetch<T>("WooCommerce", `${base}/wp-json/wc/v3${path}`, { headers: { ...auth(fields), accept: "application/json" } });
}

export const testWoo: KeyTester = async (f) => {
  if (!f.consumerKey?.startsWith("ck_") || !f.consumerSecret?.startsWith("cs_")) throw new GatewayError("INVALID_INPUT", "WooCommerce keys start with ck_ and cs_.");
  const base = await siteBase(f.siteUrl);
  await wc<unknown[]>(f, "/products?per_page=1");
  const site = await vendorFetch<{ name?: string }>("WooCommerce", `${base}/wp-json`).catch(() => ({ name: undefined }));
  return { accountLabel: `WooCommerce · ${site.name || new URL(base).hostname}`, meta: { siteUrl: base } };
};

/* ---------- one-click authorisation ---------- */

/** Builds the store's own approval URL. The state ties WooCommerce's callback to this user. */
export async function startWooConnect(userId: string, siteUrlRaw: string, returnTo: string): Promise<string> {
  const site = await siteBase(siteUrlRaw);
  const state = randomBytes(24).toString("base64url");
  await db().collection("oauth_states").doc(state).set({
    userId,
    provider: "woocommerce",
    siteUrl: site,
    returnTo: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/knowledge",
    expireAt: Timestamp.fromMillis(Date.now() + 15 * 60_000),
  });
  const base = env().PUBLIC_URL ?? env().APP_URL;
  if (!base) throw new GatewayError("AGENT_UNAVAILABLE", "WooCommerce one-click connect needs the public site address; paste keys instead.");
  const params = new URLSearchParams({
    app_name: "AgentGig",
    scope: "read",
    user_id: state,
    return_url: `${base}/api/connections/woocommerce/callback?state=${state}`,
    callback_url: `${base}/api/connections/woocommerce/callback`,
  });
  return `${site}/wc-auth/v1/authorize?${params}`;
}

/** WooCommerce POSTs { key_id, user_id, consumer_key, consumer_secret, key_permissions } here. */
export async function receiveWooKeys(body: { user_id?: string; consumer_key?: string; consumer_secret?: string }) {
  const stateRef = db().collection("oauth_states").doc(String(body.user_id ?? ""));
  const saved = (await stateRef.get()).data() as { userId: string; provider: string; siteUrl: string; expireAt: Timestamp } | undefined;
  if (!saved || saved.provider !== "woocommerce" || saved.expireAt.toMillis() < Date.now()) throw new GatewayError("UNAUTHENTICATED", "Unknown or expired connection request.");
  await saveKeyConnection(saved.userId, "woocommerce", { siteUrl: saved.siteUrl, consumerKey: String(body.consumer_key), consumerSecret: String(body.consumer_secret) }, testWoo);
  await stateRef.update({ completedAt: FieldValue.serverTimestamp() });
}

/* ---------- data ---------- */

interface WooProduct {
  sku: string;
  name: string;
  stock_quantity: number | null;
  manage_stock: boolean;
  price: string;
  total_sales: number;
}
interface WooOrder {
  number: string;
  date_created_gmt: string;
  status: string;
  total: string;
  currency: string;
  line_items: { name: string; quantity: number; sku: string }[];
  billing: { email: string; first_name: string };
  customer_id: number;
}

export async function wooProducts(userId: string): Promise<StoreProduct[] | null> {
  const k = await keyFields(userId, "woocommerce");
  if (!k) return null;
  const products = await wc<WooProduct[]>(k.fields, "/products?per_page=100&status=publish");
  const after = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const orders = await wc<WooOrder[]>(k.fields, `/orders?per_page=100&after=${encodeURIComponent(after)}&status=processing,completed,on-hold`);
  const sold = new Map<string, number>();
  for (const o of orders) for (const li of o.line_items) sold.set(li.sku || li.name, (sold.get(li.sku || li.name) ?? 0) + li.quantity);
  return products
    .filter((p) => p.manage_stock && p.stock_quantity !== null)
    .map((p) => ({
      sku: p.sku || p.name,
      name: p.name,
      onHand: p.stock_quantity ?? 0,
      soldLast7: sold.get(p.sku || p.name) ?? 0,
      unitCost: null,
      price: Number(p.price) || null,
      supplier: "Unknown supplier",
      supplierEmail: null,
    }));
}

export async function wooFindOrders(userId: string, q: { orderNumber?: string; email?: string }): Promise<StoreOrder[] | null> {
  const k = await keyFields(userId, "woocommerce");
  if (!k) return null;
  const search = q.orderNumber?.replace(/^#/, "") ?? q.email;
  if (!search) return [];
  const orders = q.orderNumber ? await wc<WooOrder>(k.fields, `/orders/${encodeURIComponent(search)}`).then((o) => [o]).catch(() => [] as WooOrder[]) : await wc<WooOrder[]>(k.fields, `/orders?search=${encodeURIComponent(search)}&per_page=5`);
  return orders.map((o) => ({
    number: `#${o.number}`,
    createdAt: o.date_created_gmt,
    paymentStatus: ["processing", "completed"].includes(o.status) ? "paid" : o.status,
    fulfilmentStatus: o.status === "completed" ? "fulfilled" : o.status,
    total: Number(o.total),
    currency: o.currency,
    items: o.line_items.map((l) => `${l.quantity} × ${l.name}`),
    tracking: [],
  }));
}

export async function wooLapsedCustomers(userId: string, days: number): Promise<StoreCustomer[] | null> {
  const k = await keyFields(userId, "woocommerce");
  if (!k) return null;
  const orders = await wc<WooOrder[]>(k.fields, `/orders?per_page=100&status=completed&orderby=date&order=desc`);
  const byEmail = new Map<string, StoreCustomer>();
  for (const o of orders) {
    const email = o.billing.email?.toLowerCase();
    if (!email) continue;
    const c = byEmail.get(email) ?? { firstName: o.billing.first_name, email, orders: 0, spent: 0, currency: o.currency, lastOrderAt: o.date_created_gmt, marketingConsent: false };
    c.orders++;
    c.spent += Number(o.total);
    if (o.date_created_gmt > c.lastOrderAt) c.lastOrderAt = o.date_created_gmt;
    byEmail.set(email, c);
  }
  const cutoff = Date.now() - days * 86_400_000;
  return [...byEmail.values()].filter((c) => Date.parse(c.lastOrderAt + "Z") < cutoff);
}

/** Completed orders whose completion falls between `fromDays` and `toDays` days ago. */
export async function wooDeliveredOrders(userId: string, fromDays: number, toDays: number): Promise<StoreDeliveredOrder[] | null> {
  const k = await keyFields(userId, "woocommerce");
  if (!k) return null;
  const after = new Date(Date.now() - toDays * 86_400_000).toISOString();
  const orders = await wc<(WooOrder & { date_completed_gmt: string | null; refunds: unknown[] })[]>(
    k.fields,
    `/orders?per_page=100&status=completed&modified_after=${encodeURIComponent(after)}`,
  );
  return orders
    .filter((o) => o.date_completed_gmt && o.billing.email)
    .map((o) => ({
      number: `#${o.number}`,
      firstName: o.billing.first_name,
      email: o.billing.email,
      items: o.line_items.slice(0, 5).map((l) => l.name),
      deliveredAt: `${o.date_completed_gmt}Z`,
      refunded: o.refunds.length > 0,
      // WooCommerce has no standard marketing-consent field.
      marketingConsent: false,
    }))
    .filter((o) => inWindow(o.deliveredAt, fromDays, toDays));
}
