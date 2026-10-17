import "server-only";
import { GatewayError } from "@/lib/errors";
import { keyFields, vendorFetch, type KeyTester } from "./keys";
import { inWindow, type StoreCustomer, type StoreDeliveredOrder, type StoreOrder, type StoreProduct } from "./store";

/** Shopify Admin GraphQL API, authenticated with a custom app's access token. */

const API_VERSION = "2025-07";

export function normaliseShopDomain(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const domain = host.includes(".") ? host : `${host}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new GatewayError("INVALID_INPUT", "Use your store's myshopify.com address, e.g. your-store.myshopify.com (Settings → Domains).");
  }
  return domain;
}

async function gql<T>(shop: string, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await vendorFetch<{ data?: T; errors?: { message: string }[] }>("Shopify", `https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (res.errors?.length) {
    const msg = res.errors[0].message;
    if (/access denied|scope/i.test(msg)) throw new GatewayError("INVALID_INPUT", `Shopify: ${msg}. Add the scopes listed in the connection steps and reinstall the app.`);
    throw new GatewayError("AGENT_FAILED", `Shopify: ${msg}`);
  }
  return res.data as T;
}

export const testShopify: KeyTester = async (f) => {
  const shop = normaliseShopDomain(f.shopDomain);
  const data = await gql<{ shop: { name: string; currencyCode: string } }>(shop, f.accessToken, "{ shop { name currencyCode } }");
  return { accountLabel: `Shopify · ${data.shop.name}`, meta: { shopDomain: shop, currency: data.shop.currencyCode } };
};

async function creds(userId: string) {
  const k = await keyFields(userId, "shopify");
  return k ? { shop: normaliseShopDomain(k.fields.shopDomain), token: k.fields.accessToken, currency: (k.conn.meta?.currency as string) ?? "USD" } : null;
}

/** Products with on-hand stock and units sold in the last 7 days (summed from orders). */
export async function shopifyProducts(userId: string): Promise<StoreProduct[] | null> {
  const c = await creds(userId);
  if (!c) return null;
  const products = await gql<{
    productVariants: { nodes: { sku: string | null; title: string; inventoryQuantity: number | null; price: string; product: { title: string; vendor: string } }[] };
  }>(c.shop, c.token, `{ productVariants(first: 250) { nodes { sku title inventoryQuantity price product { title vendor } } } }`);
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const orders = await gql<{ orders: { nodes: { lineItems: { nodes: { sku: string | null; name: string; quantity: number }[] } }[] } }>(
    c.shop,
    c.token,
    `query($q: String!) { orders(first: 250, query: $q) { nodes { lineItems(first: 100) { nodes { sku name quantity } } } } }`,
    { q: `created_at:>=${since}` },
  );
  const sold = new Map<string, number>();
  for (const o of orders.orders.nodes) for (const li of o.lineItems.nodes) sold.set(li.sku || li.name, (sold.get(li.sku || li.name) ?? 0) + li.quantity);
  return products.productVariants.nodes
    .filter((v) => v.inventoryQuantity !== null)
    .map((v) => {
      const name = v.title === "Default Title" ? v.product.title : `${v.product.title} · ${v.title}`;
      return {
        sku: v.sku || name,
        name,
        onHand: v.inventoryQuantity ?? 0,
        soldLast7: sold.get(v.sku || name) ?? sold.get(name) ?? 0,
        unitCost: null,
        price: Number(v.price),
        supplier: v.product.vendor || "Unknown supplier",
        supplierEmail: null,
      };
    });
}

/** Orders matching an order number (#1001) or customer email. */
export async function shopifyFindOrders(userId: string, q: { orderNumber?: string; email?: string }): Promise<StoreOrder[] | null> {
  const c = await creds(userId);
  if (!c) return null;
  const query = q.orderNumber ? `name:#${q.orderNumber.replace(/^#/, "")}` : q.email ? `email:${q.email}` : "";
  if (!query) return [];
  const data = await gql<{
    orders: {
      nodes: {
        name: string;
        processedAt: string;
        displayFinancialStatus: string;
        displayFulfillmentStatus: string;
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        lineItems: { nodes: { name: string; quantity: number }[] };
        fulfillments: { trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[];
      }[];
    };
  }>(
    c.shop,
    c.token,
    `query($q: String!) { orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) { nodes {
      name processedAt displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 20) { nodes { name quantity } }
      fulfillments { trackingInfo { company number url } } } } }`,
    { q: query },
  );
  return data.orders.nodes.map((o) => ({
    number: o.name,
    // When the order was placed (createdAt is when Shopify stored it, later for imported orders).
    createdAt: o.processedAt,
    paymentStatus: o.displayFinancialStatus.toLowerCase(),
    fulfilmentStatus: o.displayFulfillmentStatus.toLowerCase(),
    total: Number(o.totalPriceSet.shopMoney.amount),
    currency: o.totalPriceSet.shopMoney.currencyCode,
    items: o.lineItems.nodes.map((l) => `${l.quantity} × ${l.name}`),
    tracking: o.fulfillments.flatMap((f) => f.trackingInfo).map((t) => ({ company: t.company, number: t.number, url: t.url })),
  }));
}

/** Customers whose last order is older than `days` days. */
export async function shopifyLapsedCustomers(userId: string, days: number): Promise<StoreCustomer[] | null> {
  const c = await creds(userId);
  if (!c) return null;
  const before = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const data = await gql<{
    customers: { nodes: { firstName: string | null; email: string | null; numberOfOrders: string; amountSpent: { amount: string; currencyCode: string }; lastOrder: { processedAt: string; name: string } | null; emailMarketingConsent: { marketingState: string } | null }[] };
  }>(
    c.shop,
    c.token,
    `query($q: String!) { customers(first: 50, query: $q, sortKey: UPDATED_AT, reverse: true) { nodes {
      firstName email numberOfOrders amountSpent { amount currencyCode } lastOrder { processedAt name } emailMarketingConsent { marketingState } } } }`,
    { q: `orders_count:>0 AND last_order_date:<${before}` },
  );
  return data.customers.nodes
    // processedAt is when the order was placed; createdAt is when Shopify stored it, which differs for imported orders.
    // Filtered here too: the search's last_order_date doesn't always narrow the list.
    .filter((n) => n.email && n.lastOrder && n.lastOrder.processedAt.slice(0, 10) < before)
    .map((n) => ({
      firstName: n.firstName ?? "",
      email: n.email!,
      orders: Number(n.numberOfOrders),
      spent: Number(n.amountSpent.amount),
      currency: n.amountSpent.currencyCode,
      lastOrderAt: n.lastOrder!.processedAt,
      marketingConsent: n.emailMarketingConsent?.marketingState === "SUBSCRIBED",
    }));
}

/** Orders delivered (or fulfilled) between `fromDays` and `toDays` days ago. */
export async function shopifyDeliveredOrders(userId: string, fromDays: number, toDays: number): Promise<StoreDeliveredOrder[] | null> {
  const c = await creds(userId);
  if (!c) return null;
  const since = new Date(Date.now() - toDays * 86_400_000).toISOString();
  const data = await gql<{
    orders: {
      nodes: {
        name: string;
        email: string | null;
        displayFinancialStatus: string;
        customer: { firstName: string | null; emailMarketingConsent: { marketingState: string } | null } | null;
        lineItems: { nodes: { name: string }[] };
        fulfillments: { createdAt: string; deliveredAt: string | null }[];
      }[];
    };
  }>(
    c.shop,
    c.token,
    `query($q: String!) { orders(first: 100, query: $q, sortKey: UPDATED_AT, reverse: true) { nodes {
      name email displayFinancialStatus customer { firstName emailMarketingConsent { marketingState } }
      lineItems(first: 5) { nodes { name } } fulfillments { createdAt deliveredAt } } } }`,
    { q: `fulfillment_status:shipped AND updated_at:>=${since}` },
  );
  return data.orders.nodes.flatMap((o) => {
    const done = o.fulfillments.map((f) => f.deliveredAt ?? f.createdAt).sort().pop();
    if (!done || !o.email) return [];
    return [{
      number: o.name,
      firstName: o.customer?.firstName ?? "",
      email: o.email,
      items: o.lineItems.nodes.map((l) => l.name),
      deliveredAt: done,
      refunded: /refund/i.test(o.displayFinancialStatus),
      marketingConsent: o.customer?.emailMarketingConsent?.marketingState === "SUBSCRIBED",
    }];
  }).filter((o) => inWindow(o.deliveredAt, fromDays, toDays));
}
