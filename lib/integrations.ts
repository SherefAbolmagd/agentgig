/**
 * The tools agents can act in, and how an owner connects each one. Shared by
 * server and browser (no secrets here).
 *
 *  oauth — sign in with the vendor (Google, Microsoft 365, Xero, Square…)
 *  key   — paste a key or token created in the vendor's own admin
 *  woo   — WooCommerce's built-in "approve on your own site" key flow
 */

export const OAUTH_PROVIDERS = ["google", "microsoft", "linkedin", "slack", "xero", "quickbooks", "square", "zoho", "freshbooks", "sage"] as const;
export const KEY_PROVIDERS = [
  "shopify",
  "woocommerce",
  "stripe",
  "paypal",
  "mailchimp",
  "hubspot",
  "pipedrive",
  "calendly",
  "acuity",
  "typeform",
  "jotform",
  "trello",
  "asana",
  "notion",
] as const;
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

export const INTEGRATION_GROUPS = ["Workspace", "Store", "Payments", "Bookings & forms", "Marketing & sales", "Accounting", "Tasks"] as const;
export type IntegrationGroup = (typeof INTEGRATION_GROUPS)[number];

export interface Integration {
  name: string;
  does: string;
  kind: "oauth" | "key" | "woo";
  group: IntegrationGroup;
  /** Paste-a-key vendors: what to paste and where to find it. */
  fields?: KeyField[];
  steps?: string[];
  /** Not yet verified against a live account; shown as Beta. */
  beta?: boolean;
}

export const INTEGRATIONS: Record<Provider, Integration> = {
  google: { name: "Google", group: "Workspace", kind: "oauth", does: "Drive invoice folder, Gmail drafts, Sheets spend log, Calendar" },
  microsoft: { name: "Microsoft 365", group: "Workspace", kind: "oauth", beta: true, does: "Outlook drafts and Outlook calendar, for every agent that writes emails or reads meetings" },
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
  square: { name: "Square", group: "Payments", kind: "oauth", beta: true, does: "Takings, appointments, stock and invoices from your Square account (read-only)" },
  paypal: {
    name: "PayPal",
    group: "Payments",
    kind: "key",
    beta: true,
    does: "PayPal sales, refunds and disputes for Revenue Pulse and Cash-flow Forecast (read-only)",
    fields: [
      { id: "clientId", label: "Client ID", placeholder: "A…" },
      { id: "clientSecret", label: "Secret", placeholder: "E…", secret: true },
    ],
    steps: [
      "Log in at developer.paypal.com with your business account and open Apps & Credentials → Live → Create App (type: Merchant).",
      "In the app's features, tick Transaction search, and nothing that moves money is needed.",
      "Copy the Client ID and Secret.",
    ],
  },
  pipedrive: {
    name: "Pipedrive",
    group: "Marketing & sales",
    kind: "key",
    beta: true,
    does: "Deals and new contacts for Deal Nudger and Lead Follow-up, with notes logged back",
    fields: [{ id: "apiToken", label: "Personal API token", placeholder: "40 characters", secret: true }],
    steps: ["In Pipedrive, click your profile picture → Personal preferences → API.", "Copy your personal API token."],
  },
  zoho: { name: "Zoho CRM", group: "Marketing & sales", kind: "oauth", beta: true, does: "Leads and deals for Lead Follow-up and Deal Nudger, with notes logged back" },
  calendly: {
    name: "Calendly",
    group: "Bookings & forms",
    kind: "key",
    beta: true,
    does: "Upcoming and past bookings for Booking Assistant",
    fields: [{ id: "token", label: "Personal access token", placeholder: "eyJ…", secret: true }],
    steps: ["In Calendly, open Integrations & apps → API and webhooks.", "Under Personal access tokens, click Generate new token, name it AgentGig and copy it."],
  },
  acuity: {
    name: "Acuity Scheduling",
    group: "Bookings & forms",
    kind: "key",
    beta: true,
    does: "Appointments for Booking Assistant (needs an Acuity plan with API access)",
    fields: [
      { id: "userId", label: "User ID", placeholder: "12345678" },
      { id: "apiKey", label: "API key", placeholder: "abc123…", secret: true },
    ],
    steps: ["In Acuity, open Integrations → API (under Other) and click View credentials.", "Copy the User ID and API key."],
  },
  typeform: {
    name: "Typeform",
    group: "Bookings & forms",
    kind: "key",
    beta: true,
    does: "New form responses for Enquiry Desk",
    fields: [{ id: "token", label: "Personal access token", placeholder: "tfp_…", secret: true }],
    steps: ["In Typeform, open your account → Settings → Personal tokens → Generate a new token.", "Give it the forms:read and responses:read scopes, then copy it."],
  },
  jotform: {
    name: "Jotform",
    group: "Bookings & forms",
    kind: "key",
    beta: true,
    does: "New form submissions for Enquiry Desk",
    fields: [{ id: "apiKey", label: "API key", placeholder: "32 characters", secret: true }],
    steps: ["In Jotform, open My Account → API → Create New Key.", "Set its permission to Read Access and copy it."],
  },
  trello: {
    name: "Trello",
    group: "Tasks",
    kind: "key",
    beta: true,
    does: "Action items from Meeting Notes and Deadline Keeper as cards on your board",
    fields: [
      { id: "apiKey", label: "API key", placeholder: "32 characters" },
      { id: "token", label: "Token", placeholder: "ATTA…", secret: true },
      { id: "boardUrl", label: "Board link", placeholder: "https://trello.com/b/…", optional: true },
    ],
    steps: [
      "Open trello.com/power-ups/admin, create a Power-Up called AgentGig in your workspace, then open API key and generate a new key.",
      "Next to the key, click the Token link, allow access and copy the token.",
      "Paste the board link to choose where cards go. Cards land in its first list.",
    ],
  },
  asana: {
    name: "Asana",
    group: "Tasks",
    kind: "key",
    beta: true,
    does: "Action items from Meeting Notes and Deadline Keeper as tasks",
    fields: [
      { id: "token", label: "Personal access token", placeholder: "2/…", secret: true },
      { id: "projectUrl", label: "Project link", placeholder: "https://app.asana.com/0/…", optional: true },
    ],
    steps: ["In Asana, open the developer console (My settings → Apps → Manage developer apps) and create a personal access token.", "Optionally paste a project link; otherwise tasks go to My Tasks."],
  },
  notion: {
    name: "Notion",
    group: "Tasks",
    kind: "key",
    beta: true,
    does: "Action items from Meeting Notes and Deadline Keeper as pages in a Notion database",
    fields: [
      { id: "token", label: "Internal integration secret", placeholder: "ntn_…", secret: true },
      { id: "databaseUrl", label: "Database link", placeholder: "https://www.notion.so/…" },
    ],
    steps: [
      "Open notion.so/profile/integrations, create an internal integration called AgentGig and copy its secret.",
      "Open your tasks database, click ••• → Connections → add AgentGig.",
      "Copy the database link (Share → Copy link) and paste it here.",
    ],
  },
  freshbooks: { name: "FreshBooks", group: "Accounting", kind: "oauth", beta: true, does: "Unpaid invoices and bills for Invoice Chaser, Cash-flow Forecast and Bookkeeper" },
  sage: { name: "Sage Accounting", group: "Accounting", kind: "oauth", beta: true, does: "Unpaid invoices and bills for Invoice Chaser, Cash-flow Forecast and Bookkeeper" },
};

/** Which provider a tool belongs to. */
export function providerForTool(tool: string): Provider | null {
  if (tool === "google_drive" || tool === "gmail" || tool === "google_sheets" || tool === "google_calendar") return "google";
  if (tool === "outlook" || tool === "outlook_calendar") return "microsoft";
  if (tool === "zoho_crm") return "zoho";
  return (PROVIDERS as readonly string[]).includes(tool) ? (tool as Provider) : null;
}

/** Store agents work with either store platform. */
export const STORE_PROVIDERS: Provider[] = ["shopify", "woocommerce"];
export const ACCOUNTING_PROVIDERS: Provider[] = ["xero", "quickbooks", "freshbooks", "sage"];
