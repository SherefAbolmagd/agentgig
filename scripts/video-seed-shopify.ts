/**
 * Demo data for the online-store video in a Shopify DEV store (free, test
 * orders only), written with the video account's Shopify connection
 * (scripts/video-connect-shopify.ts first; its app can create orders).
 *
 *   npx tsx --conditions=react-server scripts/video-seed-shopify.ts [--reset]
 *
 * Creates, once (re-runs reuse the products and skip orders already made): six products with
 * stock (two running low), this week's orders that sell them, one shipped
 * order with Royal Mail tracking for the "where's my order?" email, and four
 * customers who last ordered three to four months ago (Win-back).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const STORE = process.env.SHOPIFY_STORE ?? "willow-and-wick.myshopify.com";

let token = "";

/** One Admin GraphQL call with the video account's Shopify connection token. Throws on GraphQL or user errors. */
async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${STORE}/admin/api/2026-10/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": token },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length || !body.data) throw new Error(body.errors?.map((e) => e.message).join("; ") ?? `Shopify ${res.status}`);
  const userErrors = Object.values(body.data as Record<string, { userErrors?: { message: string }[] }>).flatMap((r) => r?.userErrors ?? []);
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join("; "));
  return body.data;
}

const PRODUCTS: { title: string; sku: string; price: string; stock: number }[] = [
  { title: "Fig & Cedar candle", sku: "WW-FIG", price: "24.00", stock: 4 },
  { title: "Sea Salt & Sage candle", sku: "WW-SAGE", price: "22.00", stock: 7 },
  { title: "Black Pepper & Vetiver candle", sku: "WW-VET", price: "26.00", stock: 31 },
  { title: "Amber wax melts", sku: "WW-MELT", price: "9.50", stock: 3 },
  { title: "Autumn gift set", sku: "WW-GIFT", price: "48.00", stock: 14 },
  { title: "Long matches", sku: "WW-MATCH", price: "4.00", stock: 80 },
];

type Line = [sku: string, qty: number];
const RECENT: [string, string, string, Line[]][] = [
  ["Emma", "Clarke", "emma.clarke@example.com", [["WW-FIG", 2]]],
  ["Tom", "Reid", "tom.reid@example.com", [["WW-SAGE", 1], ["WW-MATCH", 1]]],
  ["Aisha", "Khan", "aisha.khan@example.com", [["WW-GIFT", 1]]],
  ["Lucy", "Fernandes", "lucy.f@example.com", [["WW-MELT", 3]]],
  ["Oliver", "Grant", "oliver.grant@example.com", [["WW-FIG", 2], ["WW-MATCH", 1]]],
  ["Mia", "Novak", "mia.novak@example.com", [["WW-VET", 1]]],
  ["Ben", "Walsh", "ben.walsh@example.com", [["WW-FIG", 3]]],
  ["Hannah", "Price", "hannah.price@example.com", [["WW-SAGE", 2], ["WW-MELT", 2]]],
  ["Jack", "Moore", "jack.moore@example.com", [["WW-FIG", 2], ["WW-SAGE", 1]]],
  ["Priya", "Shah", "priya.shah@example.com", [["WW-MELT", 2], ["WW-SAGE", 1]]],
  ["Leo", "Martins", "leo.martins@example.com", [["WW-FIG", 1], ["WW-GIFT", 1]]],
  ["Grace", "Hill", "grace.hill@example.com", [["WW-SAGE", 2]]],
];
const LAPSED: [string, string, string, number, Line[]][] = [
  ["Chloe", "Bennett", "chloe.bennett@example.com", 96, [["WW-FIG", 1], ["WW-MATCH", 1]]],
  ["Daniel", "Okafor", "daniel.okafor@example.com", 104, [["WW-GIFT", 1]]],
  ["Ruby", "Collins", "ruby.collins@example.com", 112, [["WW-VET", 2]]],
  ["Sam", "Turner", "sam.turner@example.com", 121, [["WW-SAGE", 1], ["WW-MELT", 1]]],
];
const SHIPPED: [string, string, string, Line[]] = ["Sophie", "Turner", "sophie.turner@example.com", [["WW-FIG", 2], ["WW-MATCH", 1]]];

async function main() {
  const { keyFields } = await import("@/lib/connectors/keys");
  const conn = await keyFields("video-cafe-lumen", "shopify");
  if (!conn) throw new Error("Connect Shopify first: scripts/video-connect-shopify.ts");
  token = conn.fields.accessToken;

  const location = (await gql<{ locations: { nodes: { id: string }[] } }>(`{ locations(first: 1) { nodes { id } } }`)).locations.nodes[0].id;
  const variants = new Map<string, { id: string; price: string; title: string }>();
  // Resumable: products already in the store are reused, the rest are created.
  const have = await gql<{ productVariants: { nodes: { id: string; sku: string | null; price: string; product: { title: string } }[] } }>(`{ productVariants(first: 50, query: "sku:WW-*") { nodes { id sku price product { title } } } }`);
  for (const v of have.productVariants.nodes) if (v.sku) variants.set(v.sku, { id: v.id, price: v.price, title: v.product.title });
  for (const p of PRODUCTS.filter((x) => !variants.has(x.sku))) {
    const res = await gql<{ productSet: { product: { variants: { nodes: { id: string }[] } } } }>(
      `mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) { product { variants(first: 1) { nodes { id } } } userErrors { field message } } }`,
      {
        input: {
          title: p.title,
          vendor: p.sku === "WW-MATCH" ? "Hearthside Matches" : "Calder Candle Co.",
          status: "ACTIVE",
          productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
          variants: [
            {
              optionValues: [{ optionName: "Title", name: "Default Title" }],
              price: p.price,
              sku: p.sku,
              inventoryItem: { tracked: true, sku: p.sku },
              inventoryQuantities: [{ locationId: location, name: "available", quantity: p.stock }],
            },
          ],
        },
      },
    );
    variants.set(p.sku, { id: res.productSet.product.variants.nodes[0].id, price: p.price, title: p.title });
  }
  console.log(`✓ ${PRODUCTS.length} products with stock`);

  // Dev stores allow only a few new orders a minute: space them out and back off when told to.
  const order = async (first: string, last: string, email: string, lines: Line[], extra: Record<string, unknown> = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const made = await placeOrder(first, last, email, lines, extra);
        await new Promise((r) => setTimeout(r, 8000));
        return made;
      } catch (err) {
        if (!/too many attempts/i.test(String(err)) || attempt >= 8) throw err;
        console.log(`  waiting: Shopify asked to slow down (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, 30_000 * (attempt + 1)));
      }
    }
  };
  const placeOrder = async (first: string, last: string, email: string, lines: Line[], extra: Record<string, unknown> = {}) =>
    (await gql<{ orderCreate: { order: { name: string; customer: { id: string } } } }>(
      `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) { orderCreate(order: $order, options: $options) { order { name customer { id } } userErrors { field message } } }`,
      {
        order: {
          currency: "GBP",
          email,
          customer: { toUpsert: { email, firstName: first, lastName: last } },
          lineItems: lines.map(([sku, quantity]) => ({ variantId: variants.get(sku)!.id, quantity })),
          financialStatus: "PAID",
          transactions: [{ kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: lines.reduce((s, [sku, q]) => s + Number(variants.get(sku)!.price) * q, 0).toFixed(2), currencyCode: "GBP" } } }],
          ...extra,
        },
        options: { inventoryBehaviour: "BYPASS", sendReceipt: false, sendFulfillmentReceipt: false },
      },
    )).orderCreate.order;

  if (process.argv.includes("--reset")) {
    // Only for this demo store: clears every order and customer so the seed starts clean.
    for (;;) {
      const orders = (await gql<{ orders: { nodes: { id: string }[] } }>(`{ orders(first: 50) { nodes { id } } }`)).orders.nodes;
      if (!orders.length) break;
      for (const o of orders) await gql(`mutation($id: ID!) { orderDelete(orderId: $id) { deletedId userErrors { field message } } }`, { id: o.id });
    }
    const customers = (await gql<{ customers: { nodes: { id: string }[] } }>(`{ customers(first: 100) { nodes { id } } }`)).customers.nodes;
    for (const c of customers) await gql(`mutation($id: ID!) { customerDelete(input: { id: $id }) { deletedCustomerId userErrors { field message } } }`, { id: c.id });
    console.log(`✓ cleared the store's orders and ${customers.length} customers`);
  }
  if ((await gql<{ orders: { nodes: unknown[] } }>(`{ orders(first: 1) { nodes { id } } }`)).orders.nodes.length) {
    console.log("Orders already there. Nothing more to do.");
    return;
  }
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  for (const [first, last, email, days, lines] of LAPSED) {
    const { customer } = await order(first, last, email, lines, { processedAt: daysAgo(days) });
    // Win-back only writes to customers who agreed to marketing emails.
    await gql(
      `mutation($input: CustomerEmailMarketingConsentUpdateInput!) { customerEmailMarketingConsentUpdate(input: $input) { customer { id } userErrors { field message } } }`,
      { input: { customerId: customer.id, emailMarketingConsent: { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" } } },
    );
  }
  console.log(`✓ ${LAPSED.length} customers who last ordered 3–4 months ago, subscribed to emails`);
  const shipped = await order(...SHIPPED, {
    processedAt: daysAgo(4),
    fulfillmentStatus: "FULFILLED",
    fulfillment: { locationId: location, trackingCompany: "Royal Mail", trackingNumber: "RM482190635GB", notifyCustomer: false, shipmentStatus: "IN_TRANSIT" },
  });
  console.log(`✓ ${shipped.name}: shipped 4 days ago with Royal Mail tracking (the "where's my order?" email)`);
  for (const [first, last, email, lines] of RECENT) await order(first, last, email, lines);
  console.log(`✓ ${RECENT.length} orders this week`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
