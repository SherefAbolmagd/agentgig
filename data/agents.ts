/**
 * Launch catalogue, loaded by `npm run seed`.
 *
 * EchoSocial and ReceiptHero are native (handlers in lib/agents). The others
 * are partner listings; until a partner endpoint is registered in Milestone 3
 * they have no endpointUrl and the marketplace shows them as previews.
 */
import type { AgentDoc } from "@/types/firestore";

export type SeedAgent = Omit<AgentDoc, "listedAt">;

export const SEED_AGENTS: SeedAgent[] = [
  {
    slug: "echosocial",
    name: "EchoSocial",
    initials: "ES",
    category: "Marketing",
    description:
      "Writes on-brand LinkedIn posts from your website and audience, then schedules them for when your followers are online.",
    provider: { name: "AgentExchange Labs" },
    tokensPerTask: 5,
    source: "native",
    model: "flash",
    skills: [
      {
        id: "linkedin.post",
        name: "Write a LinkedIn post",
        description: "Drafts a LinkedIn post with hashtags and a call to action for a target audience and tone.",
        tags: ["marketing", "linkedin", "copywriting"],
        examples: ["Announce our new weekly office delivery to office managers in Manchester"],
      },
    ],
    tools: ["linkedin"],
    triggers: [
      { id: "tue-thu-0830", label: "Every Tue and Thu at 08:30", type: "schedule", cron: "30 8 * * 2,4" },
      { id: "manual", label: "Only when I click Run", type: "manual" },
    ],
    timeSaved: "3 h/week",
    estTasksPerWeek: 2,
    rating: 4.8,
    taskCount: 12400,
    status: "listed",
  },
  {
    slug: "receipthero",
    name: "ReceiptHero",
    initials: "RH",
    category: "Finance",
    description:
      "Reads receipt and invoice photos or PDFs, pulls out line items and tax, and flags totals that don't add up.",
    provider: { name: "AgentExchange Labs" },
    tokensPerTask: 2,
    source: "native",
    model: "pro",
    skills: [
      {
        id: "invoice.extract",
        name: "Audit an invoice",
        description: "Extracts vendor, line items, tax and totals from a receipt or invoice and flags discrepancies.",
        tags: ["finance", "invoices", "ocr"],
        inputModes: ["image/jpeg", "image/png", "application/pdf"],
        outputModes: ["application/json"],
      },
    ],
    tools: ["google_drive", "gmail"],
    triggers: [
      { id: "drive-invoices", label: "When a file lands in Drive /Invoices", type: "event", event: "google_drive.file_created" },
      { id: "manual", label: "Only when I click Run", type: "manual" },
    ],
    timeSaved: "2 h/week",
    estTasksPerWeek: 20,
    rating: 4.9,
    taskCount: 31000,
    status: "listed",
  },
  {
    slug: "dm-concierge",
    name: "DM Concierge",
    initials: "DC",
    category: "E-Commerce",
    description:
      "Answers customer questions in Slack and Discord from your FAQ and order history, and hands tricky ones to you.",
    provider: { name: "Relaybird", url: "https://relaybird.example" },
    tokensPerTask: 1,
    source: "a2a",
    skills: [
      { id: "support.reply", name: "Reply to a customer", description: "Answers a customer message from the FAQ.", tags: ["support"] },
    ],
    tools: ["slack", "discord"],
    triggers: [
      { id: "on-message", label: "When a customer messages", type: "event", event: "slack.message" },
      { id: "manual", label: "Only when I click Run", type: "manual" },
    ],
    timeSaved: "5 h/week",
    estTasksPerWeek: 120,
    rating: 4.7,
    taskCount: 88900,
    status: "listed",
  },
  {
    slug: "inventory-guardian",
    name: "Inventory Guardian",
    initials: "IG",
    category: "E-Commerce",
    description: "Watches stock levels, predicts sell-outs from sales speed and drafts reorders for you to approve.",
    provider: { name: "Northwind Dev", url: "https://northwind.example" },
    tokensPerTask: 3,
    source: "a2a",
    skills: [
      { id: "stock.monitor", name: "Check stock", description: "Predicts sell-outs and drafts reorders.", tags: ["inventory"] },
    ],
    tools: ["shopify"],
    triggers: [
      { id: "daily-0700", label: "Every morning at 07:00", type: "schedule", cron: "0 7 * * *" },
      { id: "manual", label: "Only when I click Run", type: "manual" },
    ],
    timeSaved: "2 h/week",
    estTasksPerWeek: 14,
    rating: 4.6,
    taskCount: 5200,
    status: "listed",
  },
  {
    slug: "reviewpulse",
    name: "ReviewPulse",
    initials: "RP",
    category: "Marketing",
    description: "Drafts replies to new Google reviews in your voice and alerts you to anything under three stars.",
    provider: { name: "Lark & Co", url: "https://lark.example" },
    tokensPerTask: 2,
    source: "a2a",
    skills: [
      { id: "review.reply", name: "Reply to a review", description: "Drafts a reply to a Google review.", tags: ["reviews"] },
    ],
    tools: ["google_business"],
    triggers: [
      { id: "on-review", label: "When a new review arrives", type: "event", event: "google_business.review_created" },
      { id: "manual", label: "Only when I click Run", type: "manual" },
    ],
    timeSaved: "1 h/week",
    estTasksPerWeek: 8,
    rating: 4.5,
    taskCount: 9700,
    status: "listed",
  },
  {
    slug: "vat-reconciler",
    name: "VAT Reconciler",
    initials: "VR",
    category: "Finance",
    description: "Matches bank transactions to invoices every month and prepares a VAT summary for your accountant.",
    provider: { name: "Ledgerline", url: "https://ledgerline.example" },
    tokensPerTask: 6,
    source: "a2a",
    skills: [
      { id: "vat.summary", name: "Prepare VAT summary", description: "Reconciles invoices and bank lines.", tags: ["finance", "vat"] },
    ],
    tools: ["bank_feed", "google_sheets"],
    triggers: [
      { id: "monthly", label: "On the 1st of each month", type: "schedule", cron: "0 9 1 * *" },
      { id: "manual", label: "Only when I click Run", type: "manual" },
    ],
    timeSaved: "4 h/month",
    estTasksPerWeek: 1,
    rating: 4.7,
    taskCount: 3100,
    status: "listed",
  },
  {
    slug: "rotabuilder",
    name: "RotaBuilder",
    initials: "RB",
    category: "HR/Ops",
    description: "Builds the weekly staff rota from availability and expected footfall, then posts it to your team channel.",
    provider: { name: "Shiftwise", url: "https://shiftwise.example" },
    tokensPerTask: 4,
    source: "a2a",
    skills: [
      { id: "rota.generate", name: "Build the rota", description: "Generates a weekly rota.", tags: ["hr", "scheduling"] },
    ],
    tools: ["slack"],
    triggers: [
      { id: "fri-1500", label: "Every Friday at 15:00", type: "schedule", cron: "0 15 * * 5" },
      { id: "manual", label: "Only when I click Run", type: "manual" },
    ],
    timeSaved: "2 h/week",
    estTasksPerWeek: 1,
    rating: 4.4,
    taskCount: 2800,
    status: "listed",
  },
  {
    slug: "onboarding-buddy",
    name: "Onboarding Buddy",
    initials: "OB",
    category: "HR/Ops",
    description: "Sends new hires their paperwork, answers policy questions and ticks off first-week tasks.",
    provider: { name: "Peoplewise", url: "https://peoplewise.example" },
    tokensPerTask: 3,
    source: "a2a",
    skills: [
      { id: "docs.collect", name: "Onboard a new hire", description: "Collects documents and answers policy questions.", tags: ["hr"] },
    ],
    tools: ["gmail"],
    triggers: [
      { id: "on-hire", label: "When I add a new hire", type: "event", event: "agentexchange.new_hire" },
      { id: "manual", label: "Only when I click Run", type: "manual" },
    ],
    timeSaved: "3 h/hire",
    estTasksPerWeek: 2,
    rating: 4.6,
    taskCount: 4000,
    status: "listed",
  },
];

/** Demo account used in local development and the hackathon demo. */
export const DEMO_USER = {
  uid: "demo-cafe-lumen",
  displayName: "Sam Patel",
  email: "sam@cafelumen.example",
  businessName: "Café Lumen Ltd",
  startingTokens: 312,
  businessProfile: {
    description:
      "Independent specialty coffee roaster in Manchester. We supply offices with freshly roasted beans, oat milk and cups on a weekly delivery.",
    products:
      "Office coffee subscription from £39/week (beans, oat milk, cups). One-off espresso beans 1kg £18.50. Free tasting box for new offices.",
    audience: "Office managers and founders of 10–80 person companies in Greater Manchester",
    toneOfVoice: "Friendly and down to earth, a little playful, never corporate",
    avoidWords: ["synergy", "game-changer", "revolutionary"],
    website: "https://cafelumen.co.uk",
    location: "Manchester, UK",
    openingHours: "Mon–Fri 07:00–17:00",
  },
} as const;
