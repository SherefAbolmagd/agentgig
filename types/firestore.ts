/**
 * Firestore document shapes. One interface per collection; the document ID
 * pattern is noted on each. All writes go through API routes (Admin SDK);
 * clients only read their own docs.
 */
import type { AgentCategory, AgentSkill } from "./a2a";

/** Works for both Admin and client SDK timestamps. */
export type Ts = { toDate(): Date; toMillis(): number };

export const COLLECTIONS = {
  users: "users",
  agents: "agents",
  hires: "hires",
  connections: "connections",
  tasks: "tasks",
  tokenTransactions: "token_transactions",
  approvals: "approvals",
  knowledgeSources: "knowledge_sources",
  styleExamples: "style_examples",
  /** Invoice numbers ReceiptHero has seen, for atomic duplicate detection. Server-only. */
  invoiceKeys: "invoice_keys",
  /** memberships/{uid}: which organization account a person signs in to. */
  memberships: "memberships",
  invites: "invites",
  /** Company memory: facts agents (and people) share across the organization. */
  memory: "memory",
} as const;

export type ToolProvider =
  | "outlook"
  | "outlook_calendar"
  | "square"
  | "paypal"
  | "calendly"
  | "acuity"
  | "pipedrive"
  | "zoho_crm"
  | "typeform"
  | "jotform"
  | "trello"
  | "asana"
  | "notion"
  | "freshbooks"
  | "sage"
  | "linkedin"
  | "google_drive"
  | "gmail"
  | "google_sheets"
  | "google_calendar"
  | "google_business"
  | "slack"
  | "discord"
  | "shopify"
  | "woocommerce"
  | "stripe"
  | "mailchimp"
  | "hubspot"
  | "xero"
  | "quickbooks"
  | "bank_feed";

/* ---------- users/{accountId} ---------- */
/*
 * An account is the organization: one wallet, one business profile, one team
 * of agents. Its ID is its owner's uid, and every other collection's `userId`
 * field holds this account ID, whoever on the team did the work.
 */

export interface BusinessProfile {
  description: string; // what the business does, in the owner's words
  products: string; // what you sell, with prices if relevant
  audience: string;
  toneOfVoice: string;
  avoidWords: string[];
  website?: string;
  location?: string;
  openingHours?: string;
  /** Where customers leave a review, e.g. a Google review link. */
  reviewUrl?: string;
  /** UK Companies House number, for filing deadlines. */
  companyNumber?: string;
  /** IANA zone used for scheduling, e.g. "Europe/London". */
  timeZone?: string;
}

export interface UserDoc {
  displayName: string;
  email: string;
  businessName: string;
  /** Spendable tokens. Never negative; only lib/ledger.ts writes it. */
  tokenBalance: number;
  /** Reserved for running tasks; moves to spent or back to balance on settle. */
  tokensHeld: number;
  tokensSpent: number;
  businessProfile?: BusinessProfile;
  /** Company memory settings; missing means on, with approval for Customers and Money. */
  memory?: MemorySettings;
  createdAt: Ts;
  updatedAt: Ts;
}

/* ---------- memberships/{uid} ---------- */

export type Role = "owner" | "manager" | "member";

/** Present only for people who joined someone else's account. Owners have none. */
export interface MembershipDoc {
  accountId: string;
  role: Exclude<Role, "owner">;
  email: string;
  displayName: string;
  invitedBy: string;
  joinedAt: Ts;
}

/* ---------- invites/{token} ---------- */

/** The document ID is the secret in the invite link. */
export interface InviteDoc {
  accountId: string;
  businessName: string;
  role: Exclude<Role, "owner">;
  /** Optional: who it's meant for, shown to the owner. Not enforced. */
  label: string;
  invitedBy: string;
  status: "open" | "used" | "revoked";
  usedBy?: string;
  expiresAt: Ts;
  createdAt: Ts;
}

/* ---------- memory/{id} ---------- */

export const SHELVES = ["customers", "money", "stock", "brand", "team"] as const;
export type Shelf = (typeof SHELVES)[number];

export interface MemorySettings {
  enabled: boolean;
  /** Facts for these shelves wait for an owner or manager before agents can use them. */
  approveShelves: Shelf[];
}

/**
 * One shared fact. With Memory Bank configured the ID is the Memory Bank
 * memory ID, so Firestore mirrors it for the Memory page; pending facts get a
 * random ID until approved.
 */
export interface MemoryDoc {
  userId: string;
  shelf: Shelf;
  fact: string;
  status: "pending" | "saved";
  source: { kind: "agent"; agentId: string; agentName: string; taskId: string } | { kind: "person"; uid: string; name: string };
  pinned?: boolean;
  /** Agents that have been given this fact, most recent last. */
  usedBy?: string[];
  /** Memory Bank resource name, when Memory Bank stores it. */
  memoryName?: string;
  /** Set while a background job copies the fact into Memory Bank. */
  syncingSince?: Ts;
  /** When agents stop seeing it; a Firestore TTL policy deletes it later. */
  expiresAt?: Ts | null;
  createdAt: Ts;
  updatedAt: Ts;
}

/* ---------- agents/{slug} ---------- */

export interface TriggerOption {
  id: string;
  label: string; // shown in the hire wizard, e.g. "Every Tue and Thu at 08:30"
  type: "schedule" | "event" | "manual";
  cron?: string; // for schedule, in the owner's time zone
  event?: string; // for event, e.g. "google_drive.file_created"
}

export interface AgentDoc {
  slug: string;
  name: string;
  initials: string;
  category: AgentCategory;
  description: string;
  provider: { name: string; url?: string };
  tokensPerTask: number;
  /** native = handler in lib/agents; a2a = partner endpoint called over A2A. */
  source: "native" | "a2a";
  /** Native agents only; resolved to GEMINI_FLASH_MODEL / GEMINI_PRO_MODEL. */
  model?: "flash" | "pro";
  cardUrl?: string;
  endpointUrl?: string;
  skills: AgentSkill[];
  tools: ToolProvider[];
  triggers: TriggerOption[];
  /** Marketing copy for the card, e.g. "3 h/week". */
  timeSaved: string;
  estTasksPerWeek: number;
  rating: number | null;
  taskCount: number;
  status: "pending" | "listed" | "suspended";
  listedAt: Ts;
  /** A2A listings: who registered it, and how the gateway authenticates to it. */
  ownerUid?: string;
  auth?: { type: "apiKey"; header: string; secretRef: string } | null;
  version?: string;
  protocolVersion?: string;
  /** Built against the vendor's API but not yet tested with a live account. */
  beta?: boolean;
}

/* ---------- hires/{uid}_{slug} ---------- */

export interface HireDoc {
  userId: string;
  agentId: string;
  trigger: TriggerOption;
  approvalMode: "ask" | "auto";
  connectionIds: string[];
  /** "profile" for the business profile, otherwise knowledge_sources IDs. */
  knowledgeAccess: string[];
  /** Max tokens this agent may spend per calendar month; null = no cap. */
  monthlyCapTokens: number | null;
  /** Company memory shelves it reads before working and adds to afterwards. Missing = the agent's defaults. */
  memory?: { read: Shelf[]; write: Shelf[] };
  /** Tokens held or charged this month, for the cap. Written only by lib/ledger.ts. */
  spend?: { period: string; tokens: number };
  active: boolean;
  createdAt: Ts;
  updatedAt: Ts;
}

/* ---------- connections/{id} ---------- */

export interface ConnectionDoc {
  userId: string;
  provider: ToolProvider | "google";
  accountLabel: string; // e.g. "Café Lumen company page"
  scopes: string[];
  /** Secret Manager resource name holding the refresh token. Never the token itself. */
  secretRef: string;
  status: "active" | "expired" | "revoked";
  /** Provider-specific details, e.g. LinkedIn person URN, Slack default channel, Drive folder ID. */
  meta?: Record<string, unknown>;
  expiresAt?: Ts;
  createdAt: Ts;
}

/* ---------- tasks/{id} ---------- */

export type TaskStatus =
  | "requested"
  | "reserved"
  | "running"
  | "awaiting_approval"
  | "delivered"
  | "rejected"
  | "failed"
  | "discarded";

export type GatewayStep = "verify" | "reserve" | "scrub" | "ground" | "run" | "deliver" | "remember";

export interface TaskStepLog {
  step: GatewayStep;
  status: "ok" | "error" | "skipped";
  message: string;
  at: Ts;
}

export interface DlpFinding {
  infoType: string; // e.g. EMAIL_ADDRESS
  count: number;
}

export interface TaskDoc {
  userId: string;
  agentId: string;
  hireId: string | null;
  skillId: string;
  origin: "manual" | "schedule" | "event" | "a2a";
  /** The team member who started a manual task. */
  requestedBy?: string;
  status: TaskStatus;
  cost: number;
  /** Set once by lib/ledger.ts settleTask; makes settling idempotent. */
  settlement?: "charged" | "released";
  /** Month the task counted against its hire's cap. */
  spendPeriod?: string;
  /** Stored after scrubbing only. */
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  dlpFindings: DlpFinding[];
  steps: TaskStepLog[];
  error?: { code: string; message: string };
  createdAt: Ts;
  updatedAt: Ts;
  finishedAt?: Ts;
}

/* ---------- token_transactions/{id} (append-only) ---------- */

export interface TokenTransactionDoc {
  userId: string;
  type: "topup" | "hold" | "charge" | "release";
  /** Change to tokenBalance: negative for hold, positive for topup and release, 0 for charge. */
  amount: number;
  balanceAfter: number;
  description: string;
  taskId?: string;
  agentId?: string;
  createdAt: Ts;
}

/* ---------- approvals/{id} ---------- */

export interface ApprovalAction {
  id: string;
  label: string;
  kind: "approve" | "edit" | "alternative" | "skip";
}

export interface ApprovalDoc {
  userId: string;
  taskId: string;
  agentId: string;
  title: string;
  preview: string;
  severity: "info" | "check";
  actions: ApprovalAction[];
  /** Output field the owner may edit before approving, if any. */
  editField?: string | null;
  status: "open" | "approved" | "skipped";
  editedOutput?: Record<string, unknown>;
  createdAt: Ts;
  resolvedAt?: Ts;
}

/* ---------- knowledge_sources/{id} ---------- */

export interface KnowledgeSourceDoc {
  userId: string;
  name: string; // e.g. "FAQ.pdf"
  mimeType: string;
  storagePath: string; // gs:// path in the knowledge bucket
  sizeBytes: number;
  approxTokens: number;
  status: "processing" | "ready" | "error";
  dlpFindings: DlpFinding[];
  createdAt: Ts;
}

/* ---------- style_examples/{id} ---------- */

export interface StyleExampleDoc {
  userId: string;
  agentId: string;
  draft: string;
  edited: string;
  createdAt: Ts;
}
