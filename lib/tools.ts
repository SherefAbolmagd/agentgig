import type { ToolProvider } from "@/types/firestore";

/** Display names for the tools agents work in. Shared by server and UI. */
export const TOOL_LABELS: Record<ToolProvider, string> = {
  linkedin: "LinkedIn",
  google_drive: "Google Drive",
  gmail: "Gmail",
  google_sheets: "Google Sheets",
  google_business: "Google Business Profile",
  slack: "Slack",
  discord: "Discord",
  shopify: "Shopify",
  bank_feed: "Bank feed",
  google_calendar: "Google Calendar",
  woocommerce: "WooCommerce",
  stripe: "Stripe",
  mailchimp: "Mailchimp",
  hubspot: "HubSpot",
  xero: "Xero",
  quickbooks: "QuickBooks",
};
