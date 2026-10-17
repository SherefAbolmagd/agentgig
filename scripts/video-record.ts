/**
 * Records the raw take of the demo video: "a day at Willow & Wick", an online
 * candle store where nobody types a task. Each agent starts because something
 * happened (a Shopify order, a customer's email, a declined card in Stripe, an
 * invoice in Drive); Sam only answers Ada on Telegram, and approved emails are
 * sent, so the take shows them in Gmail. Everything happens for real on
 * agentgig.si, Telegram, Shopify, Stripe and Google; see scripts/video-kit.ts
 * for how it's driven and recorded, and video/prepare.ts for the edit.
 *
 *   FFMPEG=<path> STRIPE=<stripe.exe> npx tsx --conditions=react-server scripts/video-record.ts \
 *     <out-dir> <telegram-profile-dir> <edge-profile-dir>
 *
 * Before a take: Shopify connected (video-connect-shopify.ts, again within
 * 24 h) and seeded (video-seed-shopify.ts, video-seed-stripe.ts --refund),
 * Stripe connected with a key that can refund, make Checkout links and
 * webhooks, Google connected with Gmail access, Telegram linked, and the Edge
 * profile signed in to Google, the Shopify admin and the Stripe dashboard
 * (video-google-login.ts). Earlier takes are in git history.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { Page } from "playwright";
import { FIX, openStage } from "./video-kit";
import { PEOPLE, VIDEO_UID as UID, videoAddresses } from "./video-inbox";
import { waxInvoicePdf } from "./video-fixtures";

const [OUT, TG_PROFILE, EDGE_PROFILE] = process.argv.slice(2);
if (!OUT || !TG_PROFILE || !EDGE_PROFILE) throw new Error("Usage: video-record.ts <out-dir> <telegram-profile-dir> <edge-profile-dir>");
const STRIPE = process.env.STRIPE ?? "stripe";
const STRIPE_DASH = "https://dashboard.stripe.com/acct_1URSo9IS6Zq3Nf2S/test";
const SHOPIFY_ADMIN = "https://admin.shopify.com/store/willow-and-wick";
/** What Ada posts once an approved task is delivered. */
const DONE = /sent from Gmail|saved as a draft|Nothing was sent|Refunded/;

async function main() {
  const { db } = await import("@/lib/firebase-admin");
  const { getConnection } = await import("@/lib/connectors");
  const { keyFields } = await import("@/lib/connectors/keys");
  const { driveListInvoices } = await import("@/lib/connectors/google");
  const { accessToken } = await import("@/lib/connectors/tokens");
  const { queueDriveInvoices } = await import("@/lib/triggers");
  const to = await videoAddresses();
  const google = async () => accessToken((await getConnection(UID, "google"))!);

  /** A customer's email lands in the store's Gmail inbox (Gmail's insert, as if delivered). AgentGig's Gmail push does the rest. */
  async function arrive(fromName: string, fromEmail: string, subject: string, body: string) {
    const raw = [
      `From: ${fromName} <${fromEmail}>`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@video.agentgig.si>`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      body,
    ].join("\r\n");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?internalDateSource=dateHeader", {
      method: "POST",
      headers: { authorization: `Bearer ${await google()}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), labelIds: ["INBOX", "UNREAD"] }),
    });
    if (!res.ok) throw new Error(`Gmail insert failed: ${res.status} ${await res.text()}`);
  }

  /** A customer places an order on the shop (Admin API); Shopify's webhook does the rest. */
  async function placeOrder(email: string, first: string, last: string, sku: string, quantity: number): Promise<string> {
    const k = (await keyFields(UID, "shopify"))!;
    const gql = async <T>(query: string, variables: Record<string, unknown> = {}) => {
      const r = await fetch(`https://${k.fields.shopDomain}/admin/api/2025-07/graphql.json`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-access-token": k.fields.accessToken },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await r.json()) as { data: T; errors?: { message: string }[] };
      if (body.errors?.length) throw new Error(`Shopify: ${body.errors[0].message}`);
      return body.data;
    };
    const v = (await gql<{ productVariants: { nodes: { id: string; price: string }[] } }>(`query($q: String!) { productVariants(first: 1, query: $q) { nodes { id price } } }`, { q: `sku:${sku}` })).productVariants.nodes[0];
    const made = await gql<{ orderCreate: { order: { name: string } | null; userErrors: { message: string }[] } }>(
      `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) { orderCreate(order: $order, options: $options) { order { name } userErrors { message } } }`,
      {
        order: {
          currency: "GBP",
          email,
          customer: { toUpsert: { email, firstName: first, lastName: last } },
          lineItems: [{ variantId: v.id, quantity }],
          financialStatus: "PAID",
          transactions: [{ kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: (Number(v.price) * quantity).toFixed(2), currencyCode: "GBP" } } }],
        },
        options: { inventoryBehaviour: "DECREMENT_IGNORING_POLICY", sendReceipt: false },
      },
    );
    if (!made.orderCreate.order) throw new Error(`Shopify order failed: ${made.orderCreate.userErrors[0]?.message}`);
    return made.orderCreate.order.name;
  }

  /** A card is declined at checkout (Stripe sandbox, through the CLI); Stripe's webhook does the rest. */
  function declineCard(name: string, email: string, amount: number, description: string): string {
    const call = (path: string, fields: Record<string, string | number>) => {
      let out: string;
      try {
        out = execFileSync(STRIPE, ["post", path, ...Object.entries(fields).flatMap(([k, v]) => ["-d", `${k}=${v}`])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        out = String((err as { stdout?: string }).stdout ?? "");
      }
      return JSON.parse(out.slice(out.indexOf("{"))) as { id?: string; error?: { payment_intent?: { id: string } } };
    };
    const customer = call("/v1/customers", { name, email, "metadata[source]": "agentgig-video" }).id!;
    const res = call("/v1/payment_intents", {
      amount,
      currency: "gbp",
      customer,
      description,
      payment_method: "pm_card_chargeDeclined",
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
      confirm: "true",
      "metadata[source]": "agentgig-video",
    });
    return res.error?.payment_intent?.id ?? res.id ?? "";
  }

  /** The newest delivered task of an agent: its links (sent email, Stripe refund). */
  async function delivered(agentId: string): Promise<{ label: string; url: string }[]> {
    for (let i = 0; i < 30; i++) {
      const snap = await db().collection("tasks").where("userId", "==", UID).where("agentId", "==", agentId).where("status", "==", "delivered").get();
      const newest = snap.docs.map((d) => d.data()).sort((a, b) => b.updatedAt.toMillis() - a.updatedAt.toMillis())[0];
      if (newest?.delivery?.links?.length) return newest.delivery.links;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return [];
  }
  const sentLink = (links: { label: string; url: string }[]) => links.find((l) => /sent|Sent/.test(l.label))?.url ?? links.find((l) => l.url.includes("mail.google.com"))?.url;

  // Emma's refund needs a payment nothing has been refunded from: a fresh one each take, for her delivered order.
  const { shopifyFindOrders } = await import("@/lib/connectors/shopify");
  const emmaOrder = (await shopifyFindOrders(UID, { email: to.emma }))?.[0]?.number;
  if (!emmaOrder) throw new Error("Emma's delivered order isn't in Shopify: run video-seed-shopify.ts");
  execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/video-seed-stripe.ts", "--refund", `"${emmaOrder}"`], { stdio: "inherit", env: process.env, shell: true });

  const stage = await openStage({ out: OUT, tgProfile: TG_PROFILE, googleProfile: EDGE_PROFILE });
  const { web, mark } = stage;
  const tg = stage.tg!;
  const p = web.page;
  const gmailInbox = "https://mail.google.com/mail/u/0/#inbox";
  const subjectIn = (g: Page, subject: string) => g.getByText(subject).filter({ visible: true }).first();
  /** Shows a sent email in Gmail: the thread, with the customer's email and the reply. */
  const showSent = async (url: string | undefined, label: string, hold = 4000) => {
    if (url) await web.glance(url, (g) => g.locator("div[role=main] h2").filter({ visible: true }).first(), hold, label);
  };
  /** Sam reads the draft on the phone and taps Approve ("<event> tapped"); then the delivery runs. */
  const approve = async (bubble: Awaited<ReturnType<typeof tg.waitFor>>, event: string) => {
    const before = await tg.incoming(DONE).count();
    await tg.me.point(bubble);
    await tg.me.pause(1800);
    await tg.tap(bubble, "Approve");
    mark(`${event} tapped`);
    await tg.waitFor(DONE, before);
  };

  await stage.run(async () => {
    /* Tour: the team, their triggers and the shared memory. Each page is marked once its
       content is in ("… go" marks the click), so the edit can skip the loading. */
    mark("tour team go");
    await web.go("/workforce");
    await p.getByText("Payment Rescue").first().waitFor({ timeout: 30_000 });
    mark("tour team");
    await web.pause(1500);
    await web.scroll(380);
    await web.pause(1800);
    await web.scroll(-380);
    mark("tour memory go");
    await web.go("/memory");
    await p.getByText(/Calder Candle Co\. pours our candles/).first().waitFor({ timeout: 30_000 });
    mark("tour memory");
    await web.pause(2800);
    mark("tour marketplace go");
    await web.click(p.getByRole("link", { name: "Marketplace" }));
    await web.redraw();
    await p.locator("article", { hasText: "Payment Rescue" }).first().waitFor({ timeout: 30_000 });
    mark("tour marketplace");
    await web.show(p.locator("article", { hasText: "Payment Rescue" }).first(), 2200);

    /* Telegram: linked once, then the team comes to Sam */
    mark("tour telegram go");
    await web.go("/team");
    await p.getByText(/Telegram/).first().waitFor({ timeout: 30_000 });
    mark("tour telegram");
    await web.show(p.getByText(/Telegram/).first(), 2500);
    await web.go("/workforce");

    /* 09:02 · A new Shopify order */
    mark("event order");
    const orderName = await placeOrder(to.leah, "Leah", "Morgan", "WW-FIG", 2);
    await web.glance(`${SHOPIFY_ADMIN}/orders`, (g) => g.getByText(orderName).filter({ visible: true }).first(), 2500, "order source");
    mark("order placed");
    const restock = await tg.waitFor(new RegExp(`New order ${orderName}`));
    mark("order ready");
    await approve(restock, "order");
    mark("order approved");
    await showSent(sentLink(await delivered("inventory-guardian")), "order result");

    /* 09:40 · "Where's my order?" */
    mark("event where");
    await arrive(PEOPLE.sophie.name, to.sophie, "Where is my order?", readFileSync(`${FIX}/order-question.txt`, "utf8"));
    await web.glance(gmailInbox, (g) => subjectIn(g, "Where is my order"), 2200, "where source");
    mark("where email");
    const where = await tg.waitFor(/emailed about an order/);
    mark("where ready");
    await approve(where, "where");
    mark("where approved");
    await showSent(sentLink(await delivered("order-desk")), "where result");

    /* 10:30 · A refund request, refunded in Stripe */
    mark("event refund");
    await arrive(PEOPLE.emma.name, to.emma, "My candle arrived cracked", readFileSync(`${FIX}/refund-request.txt`, "utf8"));
    await web.glance(gmailInbox, (g) => subjectIn(g, "My candle arrived cracked"), 2200, "refund source");
    mark("refund email");
    const refund = await tg.waitFor(/asked for a refund/);
    mark("refund ready");
    await approve(refund, "refund");
    mark("refund approved");
    const refundLinks = await delivered("order-desk");
    const stripePayment = refundLinks.find((l) => l.url.includes("stripe.com"))?.url.split("/payments/")[1];
    if (stripePayment) await web.glance(`${STRIPE_DASH}/payments/${stripePayment}`, (g) => g.getByText(/Refunded/).filter({ visible: true }).first(), 3000, "refund stripe");
    await showSent(sentLink(refundLinks), "refund result", 3000);

    /* 11:15 · A card is declined */
    mark("event declined");
    const pi = declineCard(PEOPLE.tom.name, to.tom, 4800, "Autumn gift set");
    if (pi) await web.glance(`${STRIPE_DASH}/payments/${pi}`, (g) => g.getByText(/Failed|declined/i).filter({ visible: true }).first(), 2500, "declined source");
    mark("declined shown");
    const rescue = await tg.waitFor(/card was declined/);
    mark("declined ready");
    await approve(rescue, "declined");
    mark("declined approved");
    await showSent(sentLink(await delivered("payment-rescue")), "declined result");

    /* 12:05 · A supplier invoice lands in Google Drive */
    mark("event invoice");
    const folder = await driveListInvoices(UID);
    const pdf = `${OUT}/invoice-NW-3317.pdf`;
    writeFileSync(pdf, waxInvoicePdf(to.northernWax));
    const boundary = `ww${Date.now()}`;
    const upload = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: { authorization: `Bearer ${await google()}`, "content-type": `multipart/related; boundary=${boundary}` },
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ name: "invoice-NW-3317.pdf", parents: [folder!.folderId] })}\r\n--${boundary}\r\ncontent-type: application/pdf\r\n\r\n`),
        readFileSync(pdf),
        Buffer.from(`\r\n--${boundary}--`),
      ]),
    });
    if (!upload.ok) throw new Error(`Drive upload failed: ${upload.status}`);
    await web.glance(`https://drive.google.com/drive/folders/${folder!.folderId}`, (g) => g.getByText("invoice-NW-3317.pdf").filter({ visible: true }).first(), 2500, "invoice source");
    mark("invoice uploaded");
    // Drive is checked every 5 minutes; the edit skips ahead to the check.
    await queueDriveInvoices();
    const over = await tg.waitFor("overcharged by");
    mark("invoice ready");
    await approve(over, "invoice");
    mark("invoice approved");
    const sheet = (await getConnection(UID, "google"))?.meta?.spendSheetId as string | undefined;
    if (sheet) await web.glance(`https://docs.google.com/spreadsheets/d/${sheet}`, (g) => g.locator("#waffle-grid-container").first(), 2500, "invoice result");

    /* 14:20 · A wholesale enquiry, priced with what the team remembers */
    mark("event quote");
    await arrive(`${PEOPLE.northside.name} · Northside Interiors`, to.northside, "Wholesale: 40 Autumn gift sets", readFileSync(`${FIX}/wholesale-enquiry.txt`, "utf8"));
    await web.glance(gmailInbox, (g) => subjectIn(g, "Wholesale: 40 Autumn gift sets"), 2200, "quote source");
    mark("quote email");
    const quote = await tg.waitFor(/emailed for a quote/);
    mark("quote ready");
    await approve(quote, "quote");
    mark("quote approved");
    await showSent(sentLink(await delivered("quote-builder")), "quote result");

    /* What it all cost (the one typed message: a question) */
    mark("cost");
    await tg.ask("What did today cost us?", /tokens/);
    mark("cost answered");
    await web.go("/memory");
    await web.pause(2500);
    mark("memory after");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
