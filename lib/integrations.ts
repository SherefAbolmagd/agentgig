/**
 * The tools agents can act in, and how an owner connects each one. Shared by
 * server and browser (no secrets here).
 *
 *  oauth — sign in with the vendor (Google, LinkedIn, Slack, Xero, QuickBooks)
 *  key   — paste a key or token created in the vendor's own admin
 *  woo   — WooCommerce's built-in "approve on your own site" key flow
 */

export const OAUTH_PROVIDERS = ["google", "linkedin", "slack", "xero", "quickbooks"] as const;
export const KEY_PROVIDERS = ["shopify", "woocommerce", "stripe", "mailchimp", "hubspot"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export type KeyProvider = (typeof KEY_PROVIDERS)[number];
export type Provider = OAuthProvider | KeyProvider;
export const PROVIDERS: readonly Provider[] = [...OAUTH_PROVIDERS, ...KEY_PROVIDERS];

export interface KeyField {
  id: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  optional?: boolean;
}

export interface Integration {
  name: string;
  does: string;
  kind: "oauth" | "key" | "woo";
  group: "Workspace" | "Store" | "Payments" | "Marketing & sales" | "Accounting";
  /** Paste-a-key vendors: what to paste and where to find it. */
  fields?: KeyField[];
  steps?: string[];
  /** Not yet verified against a live account; shown as Beta. */
  beta?: boolean;
}

export const INTEGRATIONS: Record<Provider, Integration> = {
  google: { name: "Google", group: "Workspace", kind: "oauth", does: "Drive invoice folder, Gmail drafts, Sheets spend log, Calendar" },
  linkedin: { name: "LinkedIn", group: "Marketing & sales", kind: "oauth", does: "Publish EchoSocial posts to your profile" },
  slack: { name: "Slack", group: "Workspace", kind: "oauth", does: "Answer customers and post rotas in your workspace" },
  shopify: {
    name: "Shopify",
    group: "Store",
    kind: "key",
    beta: true,
    does: "Live stock, orders and customers for Inventory Guardian, Order Desk and Win-back",
    fields: [
      { id: "shopDomain", label: "Store address", placeholder: "your-store.myshopify.com" },
      { id: "accessToken", label: "Admin API access token", placeholder: "shpat_…", secret: true },
    ],
    steps: [
      "In Shopify admin, open Settings → Apps and sales channels → Develop apps (allow custom app development if asked).",
      "Create an app called AgentGig, then Configure Admin API scopes: read_products, read_inventory, read_orders, read_customers.",
      "Install the app, then reveal and copy the Admin API access token (it's shown once).",
    ],
  },
  woocommerce: {
    name: "WooCommerce",
    group: "Store",
    kind: "woo",
    beta: true,
    does: "Live stock, orders and customers from your WordPress store",
    fields: [{ id: "siteUrl", label: "Store address", placeholder: "https://yourshop.com" }],
    steps: ["Enter your store's address and click Connect.", "Your WordPress site asks you to approve read access for AgentGig. Approve, and you're sent back here."],
  },
  stripe: {
    name: "Stripe",
    group: "Payments",
    kind: "key",
    beta: true,
    does: "Revenue, failed payments and overdue invoices for Revenue Pulse (read-only)",
    fields: [{ id: "restrictedKey", label: "Restricted key", placeholder: "rk_live_… or rk_test_…", secret: true }],
    steps: [
      "In Stripe, open Developers → API keys → Create restricted key.",
      "Give it Read access to Balance, Charges, Customers, Invoices, PaymentIntents and Subscriptions, and nothing else.",
      "Copy the key (starts with rk_). AgentGig can read your figures but can never move money.",
    ],
  },
  mailchimp: {
    name: "Mailchimp",
    group: "Marketing & sales",
    kind: "key",
    beta: true,
    does: "Save Newsletter Writer's campaigns as drafts in your audience",
    fields: [{ id: "apiKey", label: "API key", placeholder: "xxxxxxxx…-us21", secret: true }],
    steps: ["In Mailchimp, open your profile → Extras → API keys → Create A Key.", "Copy the whole key, including the part after the dash (e.g. -us21)."],
  },
  hubspot: {
    name: "HubSpot",
    group: "Marketing & sales",
    kind: "key",
    beta: true,
    does: "New leads for Lead Follow-up, and notes logged on each contact",
    fields: [{ id: "token", label: "Private app access token", placeholder: "pat-…", secret: true }],
    steps: [
      "In HubSpot, open Settings → Integrations → Private Apps → Create a private app called AgentGig.",
      "Under Scopes, tick crm.objects.contacts.read and crm.objects.contacts.write.",
      "Create the app and copy its access token.",
    ],
  },
  xero: { name: "Xero", group: "Accounting", kind: "oauth", beta: true, does: "Bookkeeper saves audited invoices as draft bills" },
  quickbooks: { name: "QuickBooks", group: "Accounting", kind: "oauth", beta: true, does: "Bookkeeper saves audited invoices as bills" },
};

/** Which provider a tool belongs to. */
export function providerForTool(tool: string): Provider | null {
  if (tool === "google_drive" || tool === "gmail" || tool === "google_sheets" || tool === "google_calendar") return "google";
  return (PROVIDERS as readonly string[]).includes(tool) ? (tool as Provider) : null;
}

/** Store agents work with either store platform. */
export const STORE_PROVIDERS: Provider[] = ["shopify", "woocommerce"];
export const ACCOUNTING_PROVIDERS: Provider[] = ["xero", "quickbooks"];
